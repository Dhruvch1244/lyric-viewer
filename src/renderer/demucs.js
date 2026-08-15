'use strict';

/*
  Demucs vocal isolation in the webview — an optional pre-pass before Whisper.
  Whisper is a speech model and falls well below its speech accuracy on sung
  vocals over a dense mix (worst on fast rap and heavy EDM — this user's
  library, see whisper-transcription notes). Isolating vocals first is meant
  to close that gap; whether it actually helps enough to be worth the extra
  download + compute is untested.

  MORE UNVERIFIED THAN WHISPER, AND FOR A DIFFERENT REASON. transformers.js's
  pipeline() has no audio-source-separation task in this app's version (checked
  SUPPORTED_TASKS directly), so this talks to onnxruntime-web directly — a
  second, separate vendored ort runtime (scripts/vendor-demucs.js), not
  transformers.js's internal copy, since reaching into that copy isn't a
  documented public API.

  Model: StemSplitio/htdemucs-ft-vocals-onnx on HuggingFace — a vocals-only
  export of HT-Demucs FT, chosen so this downloads one stem instead of four.
  ASSUMPTIONS THAT NEED LIVE CONFIRMATION, not yet checked against the real
  repo (a web fetch of the model card was not available while writing this):
    - the weights file is named "model.onnx" at the repo root — the standard
      single-file HF convention, not independently confirmed for this repo;
    - the input/output tensor SHAPE is the standard Demucs contract (stereo,
      44100 Hz, [batch, channels, samples]) — tensor NAMES are read from the
      loaded session at runtime rather than hardcoded, which sidesteps
      needing to know them in advance, but not the shape convention itself.
  Treat this exactly like whisper.js's own "plausible, not proven" WASM path:
  it needs one real run against the live model to confirm before trusting it
  in front of a user. If the file name or shape is wrong, `isolateVocals`
  rejects and the caller should fall back to transcribing the raw signal.
*/
(function () {
  const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/main/model.onnx';
  const SAMPLE_RATE = 44100;
  // Non-overlapping-except-for-the-crossfade chunking rather than Demucs' own
  // overlap-add sliding window — simpler, at some cost to seam quality. Fine
  // for a transcription pre-pass, not a mixdown someone would listen to.
  const CHUNK_SECONDS = 8;
  const CROSSFADE_SECONDS = 0.2;

  let ortPromise = null;
  let sessionPromise = null;

  async function loadOrt() {
    if (!ortPromise) {
      ortPromise = import('./vendor/onnxruntime/ort.wasm.min.mjs').then((ort) => {
        ort.env.wasm.wasmPaths = new URL('./vendor/onnxruntime/', document.baseURI).href;
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = true; // off the render thread — see whisper.js
        return ort;
      });
    }
    return ortPromise;
  }

  async function loadSession(onProgress) {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const ort = await loadOrt();
      if (onProgress) onProgress({ stage: 'downloading' });
      const resp = await fetch(MODEL_URL);
      if (!resp.ok) throw new Error(`demucs model fetch failed: HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    })();
    return sessionPromise;
  }

  /**
   * Resample mono PCM between rates (nearest-neighbour — good enough to feed
   * a model, not a mixdown). Used both to bring capture.js's 16kHz audio up
   * to the 44100 Hz Demucs expects, and to bring the isolated result back
   * down to whatever rate the caller's own ASR pass wants.
   */
  function resample(pcm, fromRate, toRate) {
    if (fromRate === toRate) return pcm;
    const ratio = toRate / fromRate;
    const outLen = Math.round(pcm.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = pcm[Math.min(pcm.length - 1, Math.floor(i / ratio))];
    }
    return out;
  }

  async function runChunk(ort, session, mono) {
    const samples = mono.length;
    const data = new Float32Array(2 * samples);
    data.set(mono, 0);
    data.set(mono, samples); // duplicate to both channels
    const tensor = new ort.Tensor('float32', data, [1, 2, samples]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const result = out[session.outputNames[0]];
    // Downmix the separated stereo vocal stem to mono for the ASR path.
    const isolated = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      isolated[i] = (result.data[i] + result.data[samples + i]) / 2;
    }
    return isolated;
  }

  /**
   * Isolate vocals from mono PCM at `inputRate` Hz. Returns mono PCM at
   * `outputRate` Hz (defaults to 44100, Demucs' own rate) — pass 16000 to get
   * back something whisper.js can feed straight into Whisper.
   * @param {Float32Array} pcm
   * @param {number} inputRate
   * @param {{outputRate?: number, onProgress?: (p:{stage:string,pct?:number})=>void}} [opts]
   * @returns {Promise<Float32Array>}
   */
  async function isolateVocals(pcm, inputRate, opts = {}) {
    const onProgress = opts.onProgress;
    const ort = await loadOrt();
    const session = await loadSession(onProgress);
    const mono = resample(pcm, inputRate, SAMPLE_RATE);
    const length = mono.length;
    const chunkLen = Math.floor(CHUNK_SECONDS * SAMPLE_RATE);
    const fadeLen = Math.floor(CROSSFADE_SECONDS * SAMPLE_RATE);
    const out = new Float32Array(length);

    let chunkStart = 0;
    let chunkIndex = 0;
    const totalChunks = Math.max(1, Math.ceil(length / (chunkLen - fadeLen)));
    while (chunkStart < length) {
      const chunkEnd = Math.min(length, chunkStart + chunkLen);
      const chunk = await runChunk(ort, session, mono.subarray(chunkStart, chunkEnd));
      for (let i = 0; i < chunk.length; i++) {
        const dst = chunkStart + i;
        if (chunkStart > 0 && i < fadeLen) {
          // dst falls in the overlap with the previous chunk, which already
          // wrote a real (non-zero) value there — genuine crossfade, not a
          // fade against silence.
          const w = i / fadeLen;
          out[dst] = out[dst] * (1 - w) + chunk[i] * w;
        } else {
          out[dst] = chunk[i];
        }
      }
      chunkIndex += 1;
      if (onProgress) onProgress({ stage: 'separating', pct: Math.min(100, Math.round((chunkIndex / totalChunks) * 100)) });
      if (chunkEnd >= length) break;
      chunkStart = chunkEnd - fadeLen; // next chunk starts inside this one, for the crossfade
    }
    return resample(out, SAMPLE_RATE, opts.outputRate || SAMPLE_RATE);
  }

  window.Demucs = { isolateVocals, SAMPLE_RATE };
})();
