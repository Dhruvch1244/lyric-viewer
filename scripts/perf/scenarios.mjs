/*
  What gets measured, and how a run is made repeatable.

  The doctrine this serves (docs/PERF-UX.md §0): CPU cost repeats, frame rate
  does not. `drawCostMs` is reproducible to ~0.1ms; presented fps varies 3–4x
  between byte-identical runs on this hardware. So the harness's job is to make
  the *work* identical between runs and then measure the work.

  Three things vary the work and all three are pinned here:

  - **Audio.** The backdrop's expensive layers — confetti, shockwaves, ripples,
    flicker — fire off `audioEnv`. Real capture makes every run different, so
    the driver installs a scripted envelope instead.
  - **The look.** `presetId` selects layers, shader biases, and which of the two
    engines draws.
  - **The clock.** Lyric rendering is driven by playback position, so a paused
    clock measures a page doing nothing.

  Note what is deliberately NOT measured: capture cost itself. The audio IPC
  path was profiled and cleared at 0.038% of a core (JOB-ENGINE §6), so stubbing
  it out removes a known-negligible cost, not an interesting one.
*/

/*
  The page-side driver, installed once per page load.

  It leans on renderer.js being a classic script: `presetId`, `liteMode`,
  `cues`, `playbackStatus` and friends are top-level `let` bindings, which
  makes them global lexical bindings that an indirect eval can assign to.
  Nothing here needs a hook in production code, which is why P1 ships with zero
  production changes.
*/
export const DRIVER_SOURCE = String.raw`
window.__perfDriver = (() => {
  /* Deterministic PRNG (mulberry32) — same seed, same sequence, every run. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
    The scripted timeline advances by FRAME, not by wall clock.

    That is the whole point: a slower frame sees exactly the same audio input as
    a faster one, so two runs feed the renderer an identical sequence of work
    even when their timing differs. Driving it from performance.now() would make
    the input itself depend on the thing being measured.
  */
  var CYCLE = 240;              // ~4s at 60fps
  var BUILD_START = 150;        // build-up ramps over the last quarter
  var DROP_AT = 216;            // then a drop, once per cycle
  var KICK_PERIOD = 24;         // ~2.5Hz, a plausible four-to-the-floor

  var tick = 0;
  var realAudio = null;
  var installed = false;

  /*
    Build the scripted envelope on top of the real one's own object.

    Calling the real sample() with capture off returns the module's own env
    object fully populated with defaults (audio.js's early return does not
    strip it). Using that as the template means a field added to the envelope
    later is carried automatically rather than silently missing here — the
    stub cannot drift out of shape with the thing it stands in for.
  */
  function envTemplate() {
    try {
      var real = realAudio && typeof realAudio.sample === 'function' ? realAudio.sample(0) : null;
      if (real && typeof real === 'object') return Object.assign({}, real, { bands: (real.bands || []).slice() });
    } catch (e) { /* fall through to the literal below */ }
    return {
      active: false, level: 0, bass: 0, mid: 0, treble: 0, kick: 0, build: 0,
      drop: false, bands: new Array(8).fill(0), centroid: 0, flux: 0, fluxFloor: 0,
    };
  }

  function install(opts) {
    if (installed) uninstall();
    realAudio = window.AudioReactive;
    var random = rng(opts.seed >>> 0);
    var env = envTemplate();
    tick = 0;

    window.AudioReactive = {
      isActive: function () { return true; },
      start: function () { return Promise.resolve(true); },
      startFromElement: function () { return true; },
      stop: function () {},
      getStream: function () { return null; },
      getContext: function () { return null; },
      getSource: function () { return null; },
      setLoudnessGain: function () {},
      loudnessGain: function () { return 1; },
      /* MilkDrop draws the waveform itself; give it a deterministic one rather
         than leaving it to render a flat line, which is not representative. */
      timeDomain: function (out) {
        if (!out) return false;
        for (var i = 0; i < out.length; i++) {
          out[i] = 128 + Math.round(60 * Math.sin((tick * 0.11) + i * 0.05) * (0.4 + env.level));
        }
        return true;
      },
      sample: function () {
        tick += 1;
        var phase = tick % CYCLE;
        var build = phase >= BUILD_START && phase < DROP_AT
          ? (phase - BUILD_START) / (DROP_AT - BUILD_START)
          : 0;
        var isKick = phase % KICK_PERIOD === 0;

        env.active = true;
        env.level = 0.35 + 0.25 * build + 0.08 * random();
        env.bass = 0.40 + 0.30 * build + (isKick ? 0.25 : 0);
        env.mid = 0.30 + 0.15 * build;
        env.treble = 0.20 + 0.30 * build;
        env.kick = isKick ? 0.45 + 0.4 * build : 0;
        env.build = build;
        env.drop = phase === DROP_AT;
        env.centroid = 0.35 + 0.25 * build;
        env.flux = 0.10 + 0.20 * build;
        env.fluxFloor = 0.08;
        for (var b = 0; b < env.bands.length; b++) {
          env.bands[b] = 0.25 + 0.35 * build + 0.1 * random();
        }
        return env;
      },
    };

    /*
      A running clock. estimatePosition() returns the anchor unchanged unless
      playbackStatus is 'Playing', so without this the lyric loop renders one
      frozen line and measures a page that is not doing its job.
    */
    if (Array.isArray(opts.cues)) cues = opts.cues;
    currentTrack = opts.track || { title: 'Perf Harness', artist: 'Synthetic' };
    playbackStatus = 'Playing';
    anchorPositionMs = 0;
    anchorAt = performance.now();

    if (typeof opts.presetId === 'string') presetId = opts.presetId;
    if (typeof opts.liteMode === 'boolean') liteMode = opts.liteMode;
    if (typeof opts.backdropLevel === 'number') backdropLevel = opts.backdropLevel;
    if (typeof opts.spritesEnabled === 'boolean') spritesEnabled = opts.spritesEnabled;

    /*
      Zero the smoothed costs, or the previous scenario leaks into this one.

      perfCost is an EMA advanced by perfEnd(), which only runs when a layer
      actually draws. A layer that STOPS drawing is therefore never decayed —
      it freezes at its last value forever. The first run of this harness had
      "ghost", a look with almost no layers, confidently reporting the
      mathCurves and constellation costs of the "concert" scenario that ran
      before it, and both compact modes reporting a full-mode number because
      their backdrop is parked and updates nothing at all.

      drawCostMs gets the same treatment for the same reason. Starting from
      zero means the governor briefly runs at full quality before settling,
      which is identical across scenarios and is what the warm-up absorbs.
    */
    for (var key in perfCost) perfCost[key] = 0;
    drawCostMs = 0;

    installed = true;
    return { presetId: presetId, liteMode: liteMode, cues: cues.length };
  }

  function uninstall() {
    if (!installed) return;
    if (realAudio) window.AudioReactive = realAudio;
    playbackStatus = 'Stopped';
    installed = false;
  }

  /** Everything the harness samples, read in one round trip. */
  function snapshot() {
    return {
      drawCostMs: drawCostMs,
      frameIntervalMs: frameIntervalMs,
      perfCost: Object.assign({}, perfCost),
      canRender: canRender(),
      /*
        The "a real draw happened" marker. drawBackdrop sets it immediately
        before starting the cost timer, and AFTER the isCompact() early return
        — so a value that stops advancing is the difference between a backdrop
        that is cheap and one that is not running at all. Without it a parked
        loop reports a plausible small number rather than nothing.
      */
      lastDrawnAt: lastDrawnAt,
      activeEngine: typeof activeEngine === 'string' ? activeEngine : null,
      presetId: presetId,
      liteMode: liteMode,
      tick: tick,
      heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  }

  return { install: install, uninstall: uninstall, snapshot: snapshot };
})();
return true;
`;

/**
 * A fixed lyric set. Deterministic content and spacing so word-timing and
 * per-word animation do the same amount of work in every run.
 *
 * @param {number} count number of lines
 * @param {number} gapMs spacing between lines
 * @returns {Array<{timeMs: number, text: string}>}
 */
export function syntheticCues(count = 120, gapMs = 2500) {
  const words = ['neon', 'midnight', 'chrome', 'static', 'harbour', 'gravity', 'echo', 'paper', 'signal', 'amber'];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    // Line length cycles 4→8 words so short and long lines are both represented.
    const len = 4 + (i % 5);
    const text = Array.from({ length: len }, (_, w) => words[(i * 7 + w * 3) % words.length]).join(' ');
    out.push({ timeMs: i * gapMs, text });
  }
  return out;
}

/*
  The scenario table.

  Chosen along the axes that actually change cost — display mode, engine, and
  the Lite rung — rather than one per preset. `concert` and `liquid` are the
  two heaviest swirl looks and the ones whose regressions have historically
  shown up in release notes; `ghost` is the floor, and worth keeping because a
  floor that rises is the clearest possible signal that something global got
  more expensive.
*/
/*
  `expectBackdrop` is an assertion, not a hint. PERF-UX §1 records that compact
  modes "genuinely shed cost" — both GPU surfaces and the 2D canvas leave the
  page rather than merely being hidden. That claim has never had a test. Here
  it becomes one: a compact scenario whose backdrop turns out to be drawing is
  a failure, and so is a full-mode scenario whose backdrop is not.

  `expectEngine` catches the other silent-success case — a scenario that names
  a preset but fails to select its engine measures the wrong thing entirely
  while looking perfectly healthy.
*/
export const SCENARIOS = [
  { name: 'full/liquid', mode: 'full', presetId: 'liquid', liteMode: false, backdropLevel: 2, spritesEnabled: true, expectBackdrop: true, expectEngine: 'swirl' },
  { name: 'full/concert', mode: 'full', presetId: 'concert', liteMode: false, backdropLevel: 2, spritesEnabled: true, expectBackdrop: true, expectEngine: 'swirl' },
  { name: 'full/ghost', mode: 'full', presetId: 'ghost', liteMode: false, backdropLevel: 2, spritesEnabled: false, expectBackdrop: true, expectEngine: 'swirl' },
  { name: 'full/liquid+lite', mode: 'full', presetId: 'liquid', liteMode: true, backdropLevel: 2, spritesEnabled: true, expectBackdrop: true, expectEngine: 'swirl' },
  { name: 'full/milkdrop', mode: 'full', presetId: 'milkdrop', liteMode: false, backdropLevel: 2, spritesEnabled: true, expectBackdrop: true, expectEngine: 'milkdrop' },
  { name: 'bar/liquid', mode: 'bar', presetId: 'liquid', liteMode: false, backdropLevel: 2, spritesEnabled: true, expectBackdrop: false, expectEngine: 'swirl' },
  { name: 'strip/liquid', mode: 'strip', presetId: 'liquid', liteMode: false, backdropLevel: 2, spritesEnabled: true, expectBackdrop: false, expectEngine: 'swirl' },
];

/*
  Wallpaper is excluded from the default set on purpose: entering it reparents
  the window behind the real desktop icons, which is disruptive to whoever is
  sitting at the machine. Opt in with --include-wallpaper when the mode itself
  is what you are measuring.
*/
export const WALLPAPER_SCENARIO = {
  name: 'wallpaper/liquid',
  mode: 'wallpaper',
  presetId: 'liquid',
  liteMode: false,
  backdropLevel: 2,
  spritesEnabled: true,
  /* Wallpaper draws the full layout — it IS the desktop, so it is explicitly
     not a compact mode and must not take the parking path. */
  expectBackdrop: true,
  expectEngine: 'swirl',
};
