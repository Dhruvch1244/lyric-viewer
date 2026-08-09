'use strict';

/*
  Real audio-reactive engine.

  Captures the system audio via Electron's loopback path (the main process wires
  setDisplayMediaRequestHandler → audio: 'loopback'), runs it through a Web Audio
  AnalyserNode, and derives a compact reactive envelope every frame:

    level  — overall loudness            (0..1)
    bass   — sub/kick band               (0..1)
    mid    — vocals/instruments band     (0..1)
    treble — hats/risers band            (0..1)
    kick   — bass-onset transient        (0..1, spikes then decays)
    build  — EDM build-up detector       (0..1, ramps while highs rise/bass ducks)
    drop   — one-frame TRUE on a drop     (boolean)

  When capture is unavailable (permission denied, no loopback), the renderer keeps
  using its lyric-cadence engine, so nothing breaks — this only upgrades realism
  when real audio is present.

  Exposed on window.AudioReactive:
    - start()  -> Promise<boolean>   begin capture (needs a user gesture on first call)
    - stop()                          release the stream
    - sample(nowMs) -> envelope       call once per frame
    - isActive() -> boolean
*/

(function () {
  /** @type {AudioContext|null} */ let audioCtx = null;
  /** @type {AnalyserNode|null} */ let analyser = null;
  /** @type {MediaStream|null} */ let mediaStream = null;
  /** @type {Uint8Array|null} */ let freq = null;
  let running = false;

  /* Smoothed bands + detector state. */
  let bassEMA = 0;      // slow bass floor, for onset comparison
  let levelFast = 0;    // ~120ms energy
  let levelSlow = 0;    // ~1.5s energy
  let trebleFast = 0;
  let trebleSlow = 0;
  let build = 0;        // 0..1 build-up accumulator
  let lastKickAt = 0;
  let lastDropAt = 0;

  /* Reused output object to avoid per-frame allocation. */
  const env = {
    active: false, level: 0, bass: 0, mid: 0, treble: 0,
    kick: 0, build: 0, drop: false,
  };

  /**
   * Begin loopback capture. Must be triggered from a user gesture the first time
   * on some Chromium builds; the caller retries on the first pointer/key event.
   * @returns {Promise<boolean>} whether capture started
   */
  async function start() {
    if (running) return true;
    let stream;
    try {
      // video:true is required for the loopback audio path; we stop the video
      // track immediately and only keep the audio.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      console.warn('[audio] capture unavailable:', err && err.message);
      return false;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      console.warn('[audio] no loopback audio track');
      return false;
    }
    stream.getVideoTracks().forEach((t) => t.stop()); // discard the screen video

    mediaStream = stream;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;                  // 512 bins
    analyser.smoothingTimeConstant = 0.72;
    src.connect(analyser);

    freq = new Uint8Array(analyser.frequencyBinCount);
    running = true;
    env.active = true;
    return true;
  }

  /** Release the capture stream and reset detector state. */
  function stop() {
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null; analyser = null; mediaStream = null; freq = null;
    running = false;
    env.active = false;
  }

  /**
   * Sample the analyser and update the reactive envelope.
   * @param {number} now performance.now() ms
   * @returns {typeof env}
   */
  function sample(now) {
    env.drop = false;
    if (!running || !analyser) { env.active = false; return env; }
    env.active = true;

    analyser.getByteFrequencyData(freq);
    const n = freq.length;                    // 512 bins across ~0–24kHz (~46Hz/bin)
    const bassEnd = 6;                        // ~0–280Hz (kick/sub)
    const midEnd = 64;                        // ~0.3–3kHz (body/vocals)

    let bass = 0, mid = 0, treble = 0, total = 0;
    for (let i = 0; i < n; i += 1) {
      const v = freq[i] / 255;
      if (i < bassEnd) bass += v;
      else if (i < midEnd) mid += v;
      else treble += v;
      total += v;
    }
    bass /= bassEnd;
    mid /= (midEnd - bassEnd);
    treble /= (n - midEnd);
    total /= n;

    env.bass = bass; env.mid = mid; env.treble = treble; env.level = total;

    // Energy envelopes at two timescales.
    levelFast += (total - levelFast) * 0.30;
    levelSlow += (total - levelSlow) * 0.02;
    trebleFast += (treble - trebleFast) * 0.30;
    trebleSlow += (treble - trebleSlow) * 0.02;
    bassEMA += (bass - bassEMA) * 0.06;

    // Kick: a bass transient clearly above its running floor, rate-limited so one
    // hit isn't counted twice.
    let kick = 0;
    if (bass > 0.34 && bass > bassEMA * 1.35 && now - lastKickAt > 130) {
      kick = Math.min(1, (bass - bassEMA) * 2.8); // punchier onset so drums read clearly
      lastKickAt = now;
    }
    env.kick = Math.max(env.kick * 0.72, kick);   // decay + latch on hits

    // Build-up: highs rising while the bass is ducked (the classic filtered riser).
    // Accumulate while that condition holds; bleed away otherwise.
    const highsRising = trebleFast > trebleSlow + 0.02;
    const bassDucked = bass < 0.42;
    if (highsRising && bassDucked && levelFast > 0.06) build = Math.min(1, build + 0.016);
    else build = Math.max(0, build - 0.02);
    env.build = build;

    // Drop: a strong bass hit arriving out of a build (or a sharp jump from a dip),
    // rate-limited to one per ~2s.
    const bigHit = bass > 0.5 && bass > bassEMA * 1.6;
    if (bigHit && (build > 0.40 || levelFast > levelSlow * 1.7) && now - lastDropAt > 2000) {
      env.drop = true;
      lastDropAt = now;
      build = 0;
    }

    return env;
  }

  window.AudioReactive = { start, stop, sample, isActive: () => running };
})();
