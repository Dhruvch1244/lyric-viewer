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
*/
(function () {
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

  /**
   * Transcribe mono 16 kHz PCM into timestamped cues.
   * @param {Float32Array} pcm
   * @param {{model?:string, language?:string, onProgress?:Function}} [opts]
   * @returns {Promise<Array<{timeMs:number, text:string}>>}
   */
  async function transcribe(pcm, opts = {}) {
    const model = opts.model || 'onnx-community/whisper-base';
    const transcriber = await loadPipeline(model, opts.onProgress);
    if (opts.onProgress) opts.onProgress({ stage: 'transcribing' });

    const out = await transcriber(pcm, {
      return_timestamps: true,   // chunk-level [start, end] timestamps
      chunk_length_s: 30,
      stride_length_s: 5,
      language: opts.language || undefined,
      task: 'transcribe',
    });

    const chunks = out && Array.isArray(out.chunks) ? out.chunks : [];
    return chunks
      .filter((c) => c && typeof c.text === 'string' && c.text.trim())
      .map((c) => ({
        timeMs: Math.round(((c.timestamp && c.timestamp[0]) || 0) * 1000),
        text: c.text.trim(),
      }));
  }

  window.Whisper = { transcribe };
})();
