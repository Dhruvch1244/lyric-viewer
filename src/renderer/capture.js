'use strict';

/*
  PCM recorder for Whisper transcription.

  Taps the same loopback MediaStream audio.js already holds (see its
  getStream()) and accumulates mono 16 kHz Float32 samples — exactly the format
  src/main/transcribe.js wants. Chromium does the hard parts for free: an
  AudioContext constructed at 16 kHz resamples the stream on the way in, and a
  single-channel processor downmixes stereo, so there is no hand-written
  resampler or codec anywhere in this path.

  Why this exists at all: songs LRCLIB has no synced lyrics for can only be
  transcribed from audio we have actually heard. So the app listens once,
  transcribes at the end, and caches the result — the same
  learn-on-first-listen shape as beatmap.js. You do not get lyrics during the
  first play; you get them instantly on every play after.

  Exposed on window.PcmCapture:
    - start()        begin accumulating (no-op if already running)
    - stop()         stop, keep what was collected
    - take()         stop and return the collected Float32Array, then reset
    - reset()        discard everything
    - seconds()      how much audio is buffered
    - isActive()
*/

(function () {
  /** Whisper's required input rate. */
  const SAMPLE_RATE = 16000;

  /**
   * Hard ceiling on buffered audio (~12 min = 46 MB). Long DJ sets and streams
   * that never change track must not grow this without bound.
   */
  const MAX_SECONDS = 12 * 60;

  /** Below this there is not enough signal to be worth a transcription pass. */
  const MIN_USEFUL_SECONDS = 20;

  const PROCESSOR_BUFFER = 4096;

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {MediaStreamAudioSourceNode|null} */ let source = null;
  /** @type {ScriptProcessorNode|null} */ let processor = null;
  /** @type {GainNode|null} */ let sink = null;
  /** @type {Float32Array[]} */ let blocks = [];
  let total = 0;
  let running = false;

  /**
   * Begin accumulating PCM from the active loopback stream.
   * @returns {boolean} whether capture started
   */
  function start() {
    if (running) return true;
    const stream = window.AudioReactive && window.AudioReactive.getStream();
    if (!stream) return false; // loopback capture is off; nothing to record

    try {
      // Constructing the context at 16 kHz makes Chromium resample for us.
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      source = ctx.createMediaStreamSource(stream);

      // ScriptProcessorNode is deprecated in favour of AudioWorklet, but a
      // worklet must load its module over the page origin, which is fragile
      // under this app's file:// + strict-CSP setup. This node needs no extra
      // file and no CSP exception. Asking for 1 input channel downmixes
      // stereo to mono on the way in.
      processor = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!running) return;
        if (total >= MAX_SECONDS * SAMPLE_RATE) return; // ceiling reached; stop growing
        // The event buffer is reused by the engine, so copy before keeping it.
        blocks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        total += event.inputBuffer.length;
      };

      // A ScriptProcessorNode only runs while connected to the destination.
      // Route it through a muted gain node so nothing is actually played back
      // — this is loopback audio, so audible output would feed back into the
      // capture.
      sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);

      running = true;
      return true;
    } catch (err) {
      console.warn('[capture] could not start:', err && err.message);
      teardown();
      return false;
    }
  }

  /** Tear down the audio graph, leaving the collected blocks intact. */
  function teardown() {
    if (processor) processor.onaudioprocess = null;
    try { if (source) source.disconnect(); } catch { /* already gone */ }
    try { if (processor) processor.disconnect(); } catch { /* already gone */ }
    try { if (sink) sink.disconnect(); } catch { /* already gone */ }
    if (ctx) ctx.close().catch(() => {});
    ctx = null; source = null; processor = null; sink = null;
    running = false;
  }

  /** Stop capturing but keep what has been collected so far. */
  function stop() {
    if (!running) return;
    teardown();
  }

  /** Seconds of audio currently buffered. */
  function seconds() {
    return total / SAMPLE_RATE;
  }

  /** Discard all buffered audio and stop. */
  function reset() {
    teardown();
    blocks = [];
    total = 0;
  }

  /**
   * Stop, flatten and hand over everything captured, then reset.
   * @returns {Float32Array|null} null when there is too little audio to bother
   */
  function take() {
    stop();
    if (total < MIN_USEFUL_SECONDS * SAMPLE_RATE) {
      reset();
      return null;
    }
    const out = new Float32Array(total);
    let offset = 0;
    for (const block of blocks) {
      out.set(block, offset);
      offset += block.length;
    }
    blocks = [];
    total = 0;
    return out;
  }

  window.PcmCapture = {
    start, stop, take, reset, seconds,
    isActive: () => running,
    SAMPLE_RATE,
    MIN_USEFUL_SECONDS,
  };
})();
