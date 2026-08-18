'use strict';

/*
  Demucs vocal isolation in the webview — an optional pre-pass before Whisper.
  Whisper is a speech model and falls well below its speech accuracy on sung
  vocals over a dense mix (worst on fast rap and heavy EDM — this user's
  library, see whisper-transcription notes). Isolating vocals first is meant
  to close that gap; whether it actually helps enough to be worth the extra
  download + compute is untested.

  FIXED (this session) — the contract this file assumed was wrong on every
  point that matters, confirmed against the model repo's own infer.py rather
  than guessed a second time:
    - filename was "model.onnx"; the real files are htdemucs_ft_vocals.onnx
      (fp32, ~302MB) and a _fp16weights variant (~158MB, used here — half the
      download for a WASM CPU path that upcasts internally regardless).
    - the model takes an EXACT 343,980-sample (7.8s @ 44100Hz) input, not an
      arbitrary chunk length — a short final chunk must be zero-padded, not
      merely fed at whatever length remained.
    - the output is FOUR stems stacked as [1, 4, 2, samples] — drums, bass,
      other, vocals, in that order — not a single vocals-only stereo pair.
      The old code read the first `2*samples` floats of that buffer as if
      they WERE the vocals stem; that region is actually the DRUMS stem's
      both channels. It would have silently handed Whisper a drum track.
    - overlap-add needs a proper linear fade window + a weight accumulator
      (what infer.py does), not two chunks blended over a fixed 0.2s — the
      real model's overlap is 25% of a 7.8s segment (≈1.95s), not 0.2s.
  None of this was reachable before: the fetch 404'd on the wrong filename,
  so `isolateVocals` always rejected and every caller fell back to the raw
  signal. The feature has been a no-op, silently, since it shipped.

  transformers.js's pipeline() has no audio-source-separation task in this
  app's version (checked SUPPORTED_TASKS directly), so this talks to
  onnxruntime-web directly — a second, separate vendored ort runtime
  (scripts/vendor-demucs.js), not transformers.js's internal copy.

  STILL UNVERIFIED: this is corrected against the model's documented contract,
  not yet run against the live model end-to-end (a browser/WASM environment
  this shell doesn't have). Treat exactly like whisper.js's own path before
  its verification pass — plausible, not proven — until one real run confirms
  the output is audibly vocals rather than noise.
*/
(function () {
  // fp16: ~158MB vs ~302MB for fp32, same architecture. A WASM CPU session
  // upcasts fp16 weights internally per-op, so this is a size trade with no
  // expected accuracy cost — not independently confirmed for this specific
  // graph, same "verify before trusting" caveat as everything else here.
  const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/main/htdemucs_ft_vocals_fp16weights.onnx';
  const SAMPLE_RATE = 44100;
  const MIX_INPUT_NAME = 'mix';
  const STEMS_OUTPUT_NAME = 'stems';
  const SOURCES = ['drums', 'bass', 'other', 'vocals'];
  const VOCALS_INDEX = SOURCES.indexOf('vocals');

  // The model's fixed input length — not a tunable chunk size. 7.8s @ 44100Hz,
  // rounded exactly as the reference implementation rounds it.
  const SEGMENT_SAMPLES = Math.round(7.8 * SAMPLE_RATE);
  // 25% overlap between consecutive segments, per the reference's own default.
  const OVERLAP_SAMPLES = Math.floor(SEGMENT_SAMPLES / 4);
  const STRIDE_SAMPLES = SEGMENT_SAMPLES - OVERLAP_SAMPLES;

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

  /**
   * A linear fade-in/fade-out window over `length` samples, transitioning
   * over `transition` samples at each end and holding 1.0 in the middle —
   * matches the reference's `_make_transition_window`. Cached per (length,
   * transition) pair since every full-size segment uses the identical window;
   * only the final, shorter segment needs its own.
   */
  const windowCache = new Map();
  function transitionWindow(length, transition) {
    const key = `${length}:${transition}`;
    let w = windowCache.get(key);
    if (w) return w;
    w = new Float32Array(length).fill(1);
    const t = Math.min(transition, Math.floor(length / 2));
    for (let i = 0; i < t; i++) {
      const ramp = t > 1 ? i / (t - 1) : 1;
      w[i] = ramp;
      w[length - 1 - i] = ramp;
    }
    windowCache.set(key, w);
    return w;
  }

  /**
   * Run one fixed-length segment through the model and return only the
   * vocals stem, stereo, planar (`[L...][R...]`, i.e. `Float32Array(2*N)`).
   * The other three stems are real outputs but are dropped immediately —
   * the model card itself calls them "(low-quality) by-products" of a
   * specialist trained for vocals; keeping them would triple the memory for
   * stems nothing here uses.
   *
   * `segment` must be exactly SEGMENT_SAMPLES long per channel (planar
   * stereo, `2*SEGMENT_SAMPLES` total) — callers zero-pad the final chunk.
   */
  async function runSegment(ort, session, segment) {
    const tensor = new ort.Tensor('float32', segment, [1, 2, SEGMENT_SAMPLES]);
    const out = await session.run({ [MIX_INPUT_NAME]: tensor });
    const stems = out[STEMS_OUTPUT_NAME];
    // stems.data is flat: [4 sources][2 channels][SEGMENT_SAMPLES], planar.
    // The graph's batch dim is 1, which contributes nothing to the flat
    // buffer's length or strides — same indexing whether or not it's counted.
    const stemStride = 2 * SEGMENT_SAMPLES;
    const base = VOCALS_INDEX * stemStride;
    return stems.data.subarray(base, base + stemStride);
  }

  /**
   * Separate vocals from a planar stereo mix at 44100Hz. Returns stereo
   * planar vocals (`Float32Array(2*mix.length/2... )` — same shape as input)
   * via the model's own overlap-add scheme: fixed 7.8s segments, 25% overlap,
   * a linear fade window, and a weight accumulator so overlapping regions
   * average correctly instead of just blending two neighbours.
   *
   * @param {Float32Array} stereoMix planar stereo, length `2*samples`
   * @param {(p:{stage:string,pct?:number})=>void} [onProgress]
   * @returns {Promise<Float32Array>} planar stereo vocals, same length
   */
  async function separateVocalsStereo(stereoMix, onProgress) {
    const ort = await loadOrt();
    const session = await loadSession(onProgress);
    const samples = stereoMix.length / 2;
    const left = stereoMix.subarray(0, samples);
    const right = stereoMix.subarray(samples);

    const out = new Float32Array(2 * samples);
    const weight = new Float32Array(samples);

    const totalChunks = Math.max(1, Math.ceil(samples / STRIDE_SAMPLES));
    let chunkIndex = 0;
    for (let start = 0; start < samples; start += STRIDE_SAMPLES) {
      const end = Math.min(samples, start + SEGMENT_SAMPLES);
      const chunkLen = end - start;

      // Build the exact-length planar input the model requires, zero-padding
      // a short final segment rather than resizing the graph's input shape.
      const segment = new Float32Array(2 * SEGMENT_SAMPLES);
      segment.set(left.subarray(start, end), 0);
      segment.set(right.subarray(start, end), SEGMENT_SAMPLES);

      const vocals = await runSegment(ort, session, segment);
      const win = transitionWindow(SEGMENT_SAMPLES, OVERLAP_SAMPLES);
      for (let i = 0; i < chunkLen; i++) {
        const w = win[i];
        out[start + i] += vocals[i] * w; // left
        out[samples + start + i] += vocals[SEGMENT_SAMPLES + i] * w; // right
        weight[start + i] += w;
      }

      chunkIndex += 1;
      if (onProgress) {
        onProgress({ stage: 'separating', pct: Math.min(100, Math.round((chunkIndex / totalChunks) * 100)) });
      }
      if (end >= samples) break;
    }

    for (let i = 0; i < samples; i++) {
      const w = Math.max(weight[i], 1e-8);
      out[i] /= w;
      out[samples + i] /= w;
    }
    return out;
  }

  /**
   * Isolate vocals from MONO PCM at `inputRate` Hz — the shape capture.js's
   * system-audio path produces. Internally duplicated to stereo (the model
   * has no mono mode) and downmixed back to mono on the way out, since the
   * only current consumer is Whisper, which wants mono. Returns mono PCM at
   * `outputRate` Hz (defaults to 44100) — pass 16000 for whisper.js.
   * @param {Float32Array} pcm
   * @param {number} inputRate
   * @param {{outputRate?: number, onProgress?: (p:{stage:string,pct?:number})=>void}} [opts]
   * @returns {Promise<Float32Array>}
   */
  async function isolateVocals(pcm, inputRate, opts = {}) {
    const mono = resample(pcm, inputRate, SAMPLE_RATE);
    const samples = mono.length;
    const stereoMix = new Float32Array(2 * samples);
    stereoMix.set(mono, 0);
    stereoMix.set(mono, samples);

    const vocalsStereo = await separateVocalsStereo(stereoMix, opts.onProgress);
    const vocalsMono = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      vocalsMono[i] = (vocalsStereo[i] + vocalsStereo[samples + i]) / 2;
    }
    return resample(vocalsMono, SAMPLE_RATE, opts.outputRate || SAMPLE_RATE);
  }

  /**
   * Warm the model cache without separating anything. Only worth calling
   * when vocal isolation is actually enabled — this downloads the same
   * multi-hundred-MB model isolateVocals would, and the setting defaults off.
   * @returns {Promise<boolean>}
   */
  function preload() {
    return loadSession().then(() => true).catch(() => false);
  }

  window.Demucs = { isolateVocals, preload, SAMPLE_RATE };
})();
