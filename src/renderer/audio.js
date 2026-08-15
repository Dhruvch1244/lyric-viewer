'use strict';

/*
  Real audio-reactive engine.

  Captures system audio via native WASAPI loopback (Rust, see audio.rs) as the
  primary path, falling back to getDisplayMedia's screen-share picker when
  native capture is unavailable or silent — Electron could auto-approve that
  picker via setDisplayMediaRequestHandler, but WebView2 has no equivalent
  bypass wired up, so the fallback shows a real prompt on Tauri. Either path
  runs through a Web Audio AnalyserNode, deriving a compact reactive envelope
  every frame:

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

  /*
    Native WASAPI loopback (src-tauri/src/audio.rs). When it is available it
    feeds the exact byte spectrum / waveform a getDisplayMedia AnalyserNode
    would, via `native-audio` events — so all the DSP below is identical either
    way, only the SOURCE differs. Native needs no share-picker and no user
    gesture; getDisplayMedia stays as the fallback.
  */
  let nativeMode = false;
  let nativeSubscribed = false;
  let nativeGotFrame = false;
  const nativeAnalyser = {
    fftSize: 1024,
    frequencyBinCount: 512,
    _freq: new Uint8Array(512),
    _time: (() => { const a = new Uint8Array(1024); a.fill(128); return a; })(),
    getByteFrequencyData(out) { out.set(this._freq.subarray(0, out.length)); },
    getByteTimeDomainData(out) { out.set(this._time.subarray(0, out.length)); },
  };

  function b64ToBytes(b64, out) {
    const bin = atob(b64);
    const n = Math.min(bin.length, out.length);
    for (let i = 0; i < n; i += 1) out[i] = bin.charCodeAt(i);
  }

  function ensureNativeSubscription() {
    if (nativeSubscribed || !window.player || !window.player.onNativeAudio) return;
    nativeSubscribed = true;
    window.player.onNativeAudio((data) => {
      if (!data) return;
      if (data.f) b64ToBytes(data.f, nativeAnalyser._freq);
      if (data.t) b64ToBytes(data.t, nativeAnalyser._time);
      nativeGotFrame = true;
    });
  }

  /**
   * Try native WASAPI loopback. Resolves true ONLY if real frames arrive, so a
   * false result lets the caller fall back to getDisplayMedia.
   * @returns {Promise<boolean>}
   */
  async function startNative() {
    if (!window.player || !window.player.startAudioCapture) return false;
    ensureNativeSubscription();
    if (!nativeSubscribed) return false; // no event bridge → cannot confirm
    nativeGotFrame = false;
    try { await window.player.startAudioCapture(); } catch (e) { return false; }
    // Confirm capture is actually live by waiting for the first frame.
    const ok = await new Promise((resolve) => {
      let waited = 0;
      const iv = setInterval(() => {
        waited += 50;
        if (nativeGotFrame) { clearInterval(iv); resolve(true); }
        else if (waited >= 600) { clearInterval(iv); resolve(false); }
      }, 50);
    });
    if (!ok) { try { window.player.stopAudioCapture(); } catch (e) { /* ignore */ } return false; }
    analyser = nativeAnalyser;
    freq = new Uint8Array(nativeAnalyser.frequencyBinCount);
    prevFreq = new Uint8Array(nativeAnalyser.frequencyBinCount);
    nativeMode = true;
    running = true;
    env.active = true;
    return true;
  }

  /* Smoothed bands + detector state. */
  let bassEMA = 0;      // slow bass floor, for onset comparison
  /** Previous frame's spectrum, for spectral flux. Allocated with `freq`. */
  let prevFreq = null;
  let fluxEMA = 0;      // adaptive onset floor
  let fluxVar = 0;      // mean deviation of the flux, for the threshold margin
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
    /* Deeper analysis. `bands` is reused in place every frame rather than
       reallocated — this runs 60 times a second and a fresh array each time is
       pure garbage for the collector. Consumers must read it, not keep it. */
    bands: new Array(8).fill(0),
    centroid: 0,
    flux: 0,
    fluxFloor: 0,
  };

  /**
   * Begin capture. Prefers native WASAPI loopback (no picker, no gesture); falls
   * back to the getDisplayMedia path when native is unavailable or silent.
   * @returns {Promise<boolean>} whether capture started
   */
  async function start() {
    if (running) return true;
    if (await startNative()) return true;
    return startDisplayMedia();
  }

  /**
   * getDisplayMedia loopback fallback. Must be triggered from a user gesture the
   * first time on some Chromium builds; the caller retries on a pointer/key event.
   * @returns {Promise<boolean>} whether capture started
   */
  async function startDisplayMedia() {
    if (running) return true;
    let stream;
    try {
      // video:true is required for the loopback audio path; we stop the video
      // track immediately and only keep the audio. Plain constraints only — the
      // `systemAudio`/auto-select experiment made WebView2 reject the request
      // outright ("capture unavailable"); native WASAPI is the no-picker path.
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
    // Flux needs a previous frame; starting it as a copy of nothing means the
    // very first sample reports no onset rather than a spurious full-scale one.
    prevFreq = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Release the capture stream and reset detector state. */
  function stop() {
    if (nativeMode) {
      try {
        if (window.player && window.player.stopAudioCapture) window.player.stopAudioCapture();
      } catch (e) { /* ignore */ }
      nativeMode = false;
    }
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null; analyser = null; sourceNode = null; mediaStream = null;
    freq = null; prevFreq = null;
    fluxEMA = 0; fluxVar = 0;
    running = false;
    env.active = false;
  }

  /* ------------------------------------------------------- spectral analysis */
  /*
    Three bands (bass/mid/treble) plus a bass-rise onset test was the shallowest
    layer in the app, and it had a measured consequence: played against a real
    138 BPM track, the onset stream was noisy enough that the tempo estimator
    reported 60, 64, 86, 147, 172 and 179 across one song. The tempo fix
    insulated the CLOCK from that, but the onsets themselves are still the input
    to the beat detector whenever there is no offline analysis to fall back on —
    i.e. the whole loopback-capture path.

    So: more bands for the visuals to read, and a real onset detector.
  */

  /*
    Band edges in analyser bins (~46Hz each at fftSize 1024 / 48kHz).
    Roughly logarithmic, because pitch is: even spacing puts six of eight bands
    above 4kHz where almost no musical energy lives.
  */
  const BAND_EDGES = [0, 2, 4, 8, 16, 32, 72, 160, 512];
  const BAND_COUNT = BAND_EDGES.length - 1;

  /**
   * Average magnitude per band, 0..1.
   * @param {Uint8Array} bins
   * @param {number[]} out written in place; allocates nothing per frame
   */
  function computeBands(bins, out) {
    for (let b = 0; b < BAND_COUNT; b += 1) {
      const from = BAND_EDGES[b];
      const to = Math.min(BAND_EDGES[b + 1], bins.length);
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += bins[i];
      out[b] = to > from ? sum / (to - from) / 255 : 0;
    }
    return out;
  }

  /**
   * Spectral centroid — the "centre of mass" of the spectrum, 0..1.
   *
   * This is brightness. It separates a filtered breakdown from a full-range
   * drop even when both are equally loud, which no amount of level watching
   * can do.
   *
   * @param {Uint8Array} bins
   * @returns {number} 0..1 as a fraction of the spectrum's width
   */
  function spectralCentroid(bins) {
    let weighted = 0;
    let total = 0;
    for (let i = 0; i < bins.length; i += 1) {
      const v = bins[i];
      weighted += i * v;
      total += v;
    }
    return total > 0 ? (weighted / total) / bins.length : 0;
  }

  /**
   * Spectral flux — the sum of POSITIVE frame-to-frame changes.
   *
   * Positive only, deliberately: onsets are energy appearing, and counting
   * energy disappearing as well would make every note-off look like a note-on.
   * This is the standard onset function, and it is far more selective than
   * watching one band's level rise, because a broadband transient (a drum)
   * lights up many bins at once where a bass wobble moves only a few.
   *
   * @param {Uint8Array} bins
   * @param {Uint8Array} prev previous frame's bins
   * @param {number} [from] first bin to consider
   * @param {number} [to] one past the last bin
   * @returns {number} 0..1
   */
  function spectralFlux(bins, prev, from = 0, to = bins.length) {
    let flux = 0;
    for (let i = from; i < to; i += 1) {
      const d = bins[i] - prev[i];
      if (d > 0) flux += d;
    }
    return flux / ((to - from) * 255);
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

    /*
      Richer spectrum for anything that wants it. Computed every frame because
      it is a single pass over bins we have already fetched — the expensive part
      (the FFT) happened inside getByteFrequencyData regardless.
    */
    computeBands(freq, env.bands);
    env.centroid = spectralCentroid(freq);

    // Flux over the low end only for the kick test, and broadband for `env.flux`
    // so visuals can react to any transient rather than only to drums.
    const lowFlux = prevFreq ? spectralFlux(freq, prevFreq, 0, 16) : 0;
    env.flux = prevFreq ? spectralFlux(freq, prevFreq) : 0;
    if (prevFreq) prevFreq.set(freq);

    /*
      Adaptive onset floor, tracked but not currently used as a gate — see the
      kick test below for the measurement that decided that. Kept because it is
      three arithmetic operations and it is the thing any future onset work
      would start from.
    */
    fluxEMA += (lowFlux - fluxEMA) * 0.10;
    fluxVar += (Math.abs(lowFlux - fluxEMA) - fluxVar) * 0.10;
    env.fluxFloor = fluxEMA + fluxVar * 1.4;

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

    /*
      NOT gated on spectral flux, and that is a measured decision rather than an
      oversight.

      The theory was sound: this test fires on anything that moves the bass band
      — sub-bass melodies, wobbles, an off-beat 808 — and a low-end flux peak
      should separate a broadband drum transient from a bass note. It was built,
      and then played against the same 138 BPM track that motivated it.

      Result: onset counts fell (22–61 per sample against 39–125), so the gate
      was certainly filtering, but the tempo estimate did not improve — 2 of 12
      samples landed within 6 BPM of the truth, against 4 of 12 without it. With
      twelve samples that difference is noise, which is precisely the point: no
      improvement could be demonstrated, and the gate costs real kick sensitivity
      that the ripples and the beat flash spend.

      So the flux is still computed and exposed (`env.flux` — it is genuinely
      useful for visuals, and one pass over bins already in hand), but it does
      not veto a kick. Whatever is wrong with the live tempo estimate is not
      simply that the onsets are dirty; a 12-second Fourier window is the more
      likely culprit and is a bigger change than this.
    */
    if (bass > 0.22 && rise > 0.045 && now - lastKickAt > 130) {
      kick = Math.min(1, rise * 4.5);
      lastKickAt = now;
    }
    env.kick = Math.max(env.kick * 0.66, kick);   // snappier decay = tighter thump

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
    /* Pure DSP, exposed for tests. These are the parts with arithmetic worth
       checking against known input — the rest of this file is plumbing. */
    computeBands, spectralCentroid, spectralFlux, BAND_EDGES, BAND_COUNT,
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
