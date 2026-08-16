'use strict';

/*
  Whisper in the webview — the Tauri replacement for onnxruntime-node.

  In Electron, transcription ran in the main process via onnxruntime-node. Tauri
  has no Node, so transcription runs HERE, in the webview, using the
  transformers.js WEB build (onnxruntime-web / WASM). The renderer already
  records the loopback PCM (capture.js); this turns that Float32Array into
  timestamped cues, and the Rust side (finalize_transcription) aligns them to the
  real plain lyrics and caches the result for the next play.

  Everything is lazy: transformers.js (431KB) and the Whisper model (tens of MB,
  downloaded from HuggingFace and cached by the webview) are only fetched the
  first time a song actually needs transcribing.

  NOT YET VERIFIED END TO END. The Rust align/cache half is unit-tested; this
  half needs one real play with network to confirm the model download and WASM
  inference in WebView2. Single-threaded WASM is used deliberately — multi-thread
  needs SharedArrayBuffer, which needs COOP/COEP headers the asset protocol does
  not set.

  WORD-LEVEL TIMESTAMPS (`return_timestamps: 'word'`) are a second, separately
  unverified surface on top of the above: transformers.js computes word-level
  timing via a different internal pass (cross-attention/DTW alignment) than
  the chunk-level timestamps this used before, so a live run is what actually
  proves both the transcription AND the per-word timing work — not just the
  transcription. See groupWordsIntoLines below for how the resulting flat word
  list becomes line-shaped cues, and lyrics::WordTiming / align::align_lyrics
  on the Rust side for how a line's words[] survives (or doesn't) alignment to
  the real lyric text.

  PROXY MODE. numThreads:1 alone still runs inference synchronously on the
  calling thread — a whisper-base pass over a real song is many seconds of
  blocking WASM execution, which would freeze the rAF-driven visuals for the
  whole transcription (confirmed by reading the call path, not yet measured
  live). `wasm.proxy` is onnxruntime-web's own fix: it moves session.run()
  onto a single dedicated Worker via postMessage/transferables, which needs no
  SharedArrayBuffer/COOP/COEP (unlike numThreads>1) — the CSP's `worker-src
  'self' blob:` was already set up anticipating this. The worker loads the
  same vendored ort-wasm-simd-threaded.jsep.mjs this thread does, so nothing
  new needs vendoring.
*/
(function () {
  const DEFAULT_MODEL = 'onnx-community/whisper-base';

  /** Cached pipeline promise, so the model loads once per session. */
  let pipePromise = null;

  /**
   * Build (or reuse) the ASR pipeline.
   * @param {string} model HuggingFace model id
   * @param {(p:{stage:string,pct?:number})=>void} [onProgress]
   */
  async function loadPipeline(model, onProgress) {
    if (pipePromise) return pipePromise;
    pipePromise = (async () => {
      // Dynamic import: transformers.web is an ES module served from our origin.
      const mod = await import('./vendor/transformers/transformers.web.min.js');
      const { pipeline, env } = mod;

      // Models come from HuggingFace; the ort WASM binary is vendored beside us.
      env.allowLocalModels = false;
      env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', document.baseURI).href;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = true;

      return pipeline('automatic-speech-recognition', model, {
        dtype: 'q8', // quantised — smaller download, fine for lyrics
        device: 'wasm',
        progress_callback: (p) => {
          if (onProgress && p && p.status === 'progress') {
            onProgress({ stage: 'downloading', pct: Math.round(p.progress || 0) });
          }
        },
      });
    })();
    return pipePromise;
  }

  /*
    Line grouping for word-level output.

    `return_timestamps: 'word'` (below) makes transformers.js return one chunk
    PER WORD instead of Whisper's own coarser segment chunks — that's the only
    way to get real per-word timestamps out of it, since word-level timing is
    computed via a separate cross-attention/DTW pass keyed to that mode. The
    trade is that "lines" no longer come for free; they're re-derived here
    from pauses between words, which is also a reasonable proxy for where a
    sung phrase actually breaks (arguably better than Whisper's own 30s
    chunk-budget boundaries, which don't know or care about phrasing).
  */
  const LINE_GAP_MS = 700;      // a silence at least this long starts a new line
  const MAX_WORDS_PER_LINE = 14; // guards a legato passage with no pauses from becoming one giant "line"

  /**
   * Group flat word-level timestamps into line-shaped cues, each carrying its
   * own words[] for exact per-word sync (see lyrics::WordTiming on the Rust
   * side, which only trusts this when a real lyric line's word count matches).
   * @param {Array<{text:string, timestamp:[number,number]}>} chunks
   * @returns {Array<{timeMs:number, endMs:number, text:string, words:Array<{word:string,startMs:number,endMs:number}>}>}
   */
  function groupWordsIntoLines(chunks) {
    const words = chunks
      .filter((c) => c && typeof c.text === 'string' && c.text.trim() && Array.isArray(c.timestamp))
      .map((c) => {
        const startMs = Math.round((c.timestamp[0] || 0) * 1000);
        const rawEnd = c.timestamp[1];
        const endMs = Math.round((rawEnd != null ? rawEnd : c.timestamp[0] || 0) * 1000);
        return { word: c.text.trim(), startMs, endMs: Math.max(endMs, startMs) };
      });

    const lines = [];
    let current = [];
    for (const w of words) {
      const prev = current[current.length - 1];
      const gap = prev ? w.startMs - prev.endMs : 0;
      if (current.length && (gap > LINE_GAP_MS || current.length >= MAX_WORDS_PER_LINE)) {
        lines.push(current);
        current = [];
      }
      current.push(w);
    }
    if (current.length) lines.push(current);

    return lines.map((ws) => ({
      timeMs: ws[0].startMs,
      endMs: ws[ws.length - 1].endMs,
      text: ws.map((w) => w.word).join(' '),
      words: ws,
    }));
  }

  /**
   * Transcribe mono 16 kHz PCM into timestamped cues, each carrying measured
   * per-word timing.
   * @param {Float32Array} pcm
   * @param {{model?:string, language?:string, onProgress?:Function}} [opts]
   * @returns {Promise<Array<{timeMs:number, endMs:number, text:string, words:Array<{word:string,startMs:number,endMs:number}>}>>}
   */
  async function transcribe(pcm, opts = {}) {
    const model = opts.model || DEFAULT_MODEL;
    const transcriber = await loadPipeline(model, opts.onProgress);
    if (opts.onProgress) opts.onProgress({ stage: 'transcribing' });

    const out = await transcriber(pcm, {
      return_timestamps: 'word',   // word-level timestamps — see groupWordsIntoLines
      chunk_length_s: 30,
      stride_length_s: 5,
      language: opts.language || undefined,
      task: 'transcribe',
    });

    const chunks = out && Array.isArray(out.chunks) ? out.chunks : [];
    return groupWordsIntoLines(chunks);
  }

  /**
   * Warm the model cache without transcribing anything. Fire-and-forget from
   * renderer.js a few seconds after startup, so a song that actually needs
   * transcription later doesn't pay for the download + WASM compile in the
   * moment — WebView2 persists the fetched bytes across restarts, so this
   * only ever costs something once per install.
   * @param {string} [model]
   */
  function preload(model) {
    return loadPipeline(model || DEFAULT_MODEL).then(() => true).catch(() => false);
  }

  // groupWordsIntoLines exposed for unit testing (test/whisper-grouping.test.js)
  // — it's pure array processing with no webview/ONNX dependency, unlike
  // everything else in this file.
  window.Whisper = { transcribe, preload, DEFAULT_MODEL, groupWordsIntoLines };
})();
