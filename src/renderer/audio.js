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
  /** @type {AudioNode|null} The node feeding the analyser, shared with MilkDrop. */
  let sourceNode = null;
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
    buildAnalyser(audioCtx.createMediaStreamSource(new MediaStream(audioTracks)));
    running = true;
    env.active = true;
    return true;
  }

  /**
   * Drive the reactive envelope from an audio ELEMENT rather than from screen
   * capture.
   *
   * This is the local-playback path, and it is strictly better than loopback:
   * no permission prompt, no screen-capture stream, no other application's
   * sound mixed in, and the element is reconnected to the destination so
   * playback is unaffected.
   *
   * @param {HTMLMediaElement} media
   * @returns {boolean}
   */
  function startFromElement(media) {
    if (!media) return false;
    if (running) stop();
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const src = audioCtx.createMediaElementSource(media);
      buildAnalyser(src);
      // A MediaElementSource diverts the element's output into the graph, so it
      // must be routed onward or the song plays silently.
      src.connect(audioCtx.destination);
      running = true;
      env.active = true;
      return true;
    } catch (err) {
      console.warn('[audio] element capture failed:', err && err.message);
      stop();
      return false;
    }
  }

  /**
   * Build the analyser and connect a source to it. Shared by both entry points
   * so the tuning below cannot drift between them.
   * @param {AudioNode} src
   */
  function buildAnalyser(src) {
    // Kept so other consumers can tap the same graph. Butterchurn wants a node
    // to attach its own analysers to, and building it a second capture would
    // mean a second permission prompt for sound we already have.
    sourceNode = src;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;                  // 512 bins
    /*
      Lower than the 0.72 this used to run at. Smoothing is applied to the
      spectrum BEFORE we ever see it, so a high constant blunts exactly the
      transients kick detection depends on — it was smoothing the drums away
      and then failing to find them.
    */
    analyser.smoothingTimeConstant = 0.55;
    /*
      The default window is -100..-30 dB, which modern masters blow straight
      through: measured on a commercial house track, the bass bins sat pegged
      between 0.94 and 1.00 for the entire song. With the signal clipped at the
      ceiling there is no headroom left for a transient to rise into, so every
      onset test below was dead on arrival. Opening the ceiling restores the
      dynamic range these tests need.
    */
    analyser.minDecibels = -95;
    analyser.maxDecibels = -12;
    src.connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Release the capture stream and reset detector state. */
  function stop() {
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null; analyser = null; sourceNode = null; mediaStream = null; freq = null;
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

    /*
      Kick: a bass transient rising clearly ABOVE its running floor.

      Tested by DIFFERENCE, not by ratio. The old test was
      `bass > bassEMA * 1.35`, which cannot fire on loud material: once the
      bass band sits near 1.0 the floor sits near 1.0 too, and asking for 1.35x
      a saturated signal is asking for something impossible. Measured on a
      commercial house track — a genre that is essentially nothing but kick
      drum — it produced a kick value of exactly 0.00 for the whole song.

      A difference test has the same meaning at any level and keeps working
      when the track is mastered hot.
    */
    let kick = 0;
    const rise = bass - bassEMA;
    if (bass > 0.22 && rise > 0.045 && now - lastKickAt > 130) {
      kick = Math.min(1, rise * 4.5);
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
    // Same correction as the kick test: a difference, not a ratio, so a hot
    // master cannot make the condition unreachable.
    const bigHit = bass > 0.38 && bass - bassEMA > 0.11;
    if (bigHit && (build > 0.40 || levelFast > levelSlow * 1.7) && now - lastDropAt > 2000) {
      env.drop = true;
      lastDropAt = now;
      build = 0;
    }

    return env;
  }

  /**
   * The live loopback MediaStream, or null when capture is off. Exposed so
   * capture.js can tap the same stream for Whisper transcription instead of
   * prompting the user for a second screen-capture permission.
   * @returns {MediaStream|null}
   */
  function getStream() {
    return running ? mediaStream : null;
  }

  window.AudioReactive = {
    start, startFromElement, stop, sample, isActive: () => running, getStream,
    /* The live graph, for consumers that do their own analysis rather than
       reading our envelope. Both are null when capture is off; a consumer must
       cope with that rather than assume sound is available. */
    getContext: () => audioCtx,
    getSource: () => sourceNode,
    /**
     * Fill `out` with time-domain samples from the live analyser.
     *
     * Time domain, not the frequency data `sample()` returns: MilkDrop presets
     * draw the waveform itself, so a spectrum is the wrong shape entirely. The
     * caller supplies the buffer so this allocates nothing at 60fps.
     *
     * @param {Uint8Array} out
     * @returns {boolean} whether anything was written
     */
    timeDomain: (out) => {
      if (!running || !analyser || !out) return false;
      analyser.getByteTimeDomainData(out);
      return true;
    },
  };
})();
