'use strict';

/*
  🎬 Director — picks the look for each part of the song, like a VJ who has
  heard it before.

  heatmap.js already splits a song into sections and names them (intro,
  verse, build, drop, break, outro). This maps each section to a scene that
  fits it: quiet Prism or an Overlay look for intros, breaks and outros;
  flowing shaders and Prism for verses; tunnels and pulses for builds; the
  hardest scenes (lasers, hyperspace, lightning) for drops.

  Deterministic per song: the choice hashes the track key with the section's
  start, so the same song is directed the same way every time it plays, and
  two songs in a row are not directed identically. The mood biases Prism's
  palette and the genre how hard the drops go; nothing here is random.

  Pure: no DOM, no renderer state. renderer.js asks `plan()` when the section
  changes and applies the answer without saving it, so turning the Director
  off puts the song's own look straight back.

  Exposed on window.Director: { plan, kinds, intensityFor }.
*/

(function () {
  /* Overlay looks that suit a quiet passage under lyrics. */
  const CALM_OVERLAY = ['liquid', 'starfield', 'vinyl', 'wormhole', 'cover3d', 'coverglass'];

  /* Shader scenes by how hard they hit. Names are catalogue names
     (shaders/index.json). */
  const SHADERS = {
    verse: ['Aurora', 'Ripples', 'Lava Lamp', 'Synthwave', 'Neon Rings', 'Plasma Pulse', 'Kaleidoscope'],
    build: ['Hex Pulse', 'Ring Tunnel', 'Vortex', 'Spectrum 3D', 'Skyline', 'Starburst'],
    drop: ['Laser Show', 'Laser Tunnel', 'Hyperspace', 'Club', 'Lightning', 'Fractal Bloom', 'Inferno', 'Shatter', 'Laser Grid'],
    hardDrop: ['Laser Show', 'Club', 'Lightning', 'Glitch', 'Shatter', 'Laser Grid'],
  };

  /* Prism forms by character (prism.js FORMS order). */
  const PRISM_FORMS = {
    calm: [0, 7, 8, 9],       // rings, waves, plasma, flower
    verse: [1, 3, 4, 11],     // spiral, hex, cells, weave
    build: [5, 6, 2, 10],     // tunnel, rays, grid, stars
  };
  /* Warps: calm sections stay plain or gently bent; builds go kaleidoscopic. */
  const PRISM_WARPS = { calm: [0, 2], verse: [0, 1, 5], build: [3, 4, 1] };
  /* Palettes per mood (prism.js PALETTES order): 0 song, 1 fire, 2 ice,
     3 neon, 4 sunset, 5 mono, 6 rainbow, 7 acid. */
  const MOOD_PALETTES = {
    calm: [2, 0, 4],
    dark: [5, 2, 3],
    bright: [4, 6, 0],
    energetic: [1, 3, 7],
    neutral: [0, 3, 4],
  };

  const HARD_GENRE = /\b(metal|rock|punk|edm|dubstep|trap|drum|bass|hardstyle|techno|house|electro|phonk)\b/i;
  const SOFT_GENRE = /\b(r&b|rnb|soul|jazz|lo.?fi|ambient|chill|acoustic|classical|folk|ghazal|sufi)\b/i;

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h;
  }

  const pick = (list, h, salt) => list[(h >>> salt) % list.length];

  /** How hard a genre wants its drops: 'hard' | 'soft' | 'normal'. */
  function intensityFor(genre) {
    if (!genre) return 'normal';
    if (HARD_GENRE.test(genre)) return 'hard';
    if (SOFT_GENRE.test(genre)) return 'soft';
    return 'normal';
  }

  function prismFor(character, mood, h) {
    const form = pick(PRISM_FORMS[character], h, 3);
    const warp = pick(PRISM_WARPS[character], h, 7);
    const palette = pick(MOOD_PALETTES[mood] || MOOD_PALETTES.neutral, h, 11);
    return `${form}-${warp}-${palette}`;
  }

  /**
   * The scene for one section.
   * @param {object} q
   * @param {string} q.trackKey  stable id for the song
   * @param {string} q.kind      heatmap.js section kind
   * @param {number} q.startMs   the section's start, so each section of a song differs
   * @param {string} [q.mood]    MoodProfile key: calm / energetic / dark / bright / neutral
   * @param {string} [q.genre]   free-text genre
   * @returns {{look: string, shader?: string, prism?: string, label: string}}
   */
  function plan(q) {
    const h = hash(`${q.trackKey}|${Math.round((q.startMs || 0) / 1000)}|${q.kind}`);
    const mood = q.mood || 'neutral';
    const force = intensityFor(q.genre);

    switch (q.kind) {
      case 'drop': {
        // Soft genres get a big but not violent scene: Prism at full tilt.
        if (force === 'soft') return { look: 'prism', prism: prismFor('build', mood, h), label: 'Drop' };
        const list = force === 'hard' ? SHADERS.hardDrop : SHADERS.drop;
        return { look: 'shaders', shader: pick(list, h, 2), label: 'Drop' };
      }
      case 'build':
        return (h & 1)
          ? { look: 'shaders', shader: pick(SHADERS.build, h, 2), label: 'Build' }
          : { look: 'prism', prism: prismFor('build', mood, h), label: 'Build' };
      case 'verse':
        return (h % 3 === 0)
          ? { look: 'prism', prism: prismFor('verse', mood, h), label: 'Verse' }
          : { look: 'shaders', shader: pick(SHADERS.verse, h, 2), label: 'Verse' };
      case 'intro':
      case 'outro':
      case 'break':
      default: {
        const label = q.kind ? q.kind[0].toUpperCase() + q.kind.slice(1) : 'Calm';
        return (h & 1)
          ? { look: pick(CALM_OVERLAY, h, 2), label }
          : { look: 'prism', prism: prismFor('calm', mood, h), label };
      }
    }
  }

  /*
    LIVE SECTIONS — the first listen.

    heatmap.js only names sections once half the song has been heard (and
    exact boundaries come only from a local file's offline pass), so on a
    song's first play from Spotify or YouTube the Director used to open on an
    intro look and then sit there, jumping only on lyric-gap "drops". This
    reads the same section shape off what is being heard right now.

    Loudness is judged against the song's own running peak, not an absolute
    level: a hot-mastered pop track and a quiet acoustic one both have a
    "loud part", and an absolute threshold would call one all-drop and the
    other all-break. Every state has a minimum dwell, because a section that
    changes every two seconds is worse than one that changes late.
  */
  const LIVE = {
    slowMs: 3000,        // energy smoothing: phrase scale, not beat scale
    peakDecayMs: 90000,  // the running peak forgets over ~1.5 min (a long quiet intro must not pin it)
    warmupMs: 6000,      // say "intro" until there is enough to judge
    dwellMs: 7000,       // minimum time in any section
    dropHoldMs: 9000,    // a drop is held at least this long
    quiet: 0.42,         // rel energy below this is a quiet part
    dropExit: 0.6,       // a drop ends when rel energy falls under this
    loud: 0.86,          // sustained loud after a build counts as the drop...
    jump: 1.3,           // ...but only once energy has jumped this far above the build's own
    build: 0.35,         // build-up detector / anticipation above this is a build
  };

  function createLive() {
    let slow = 0;
    let peak = 0;
    let heardMs = 0;
    let kind = 'intro';
    let since = 0;       // song position the current section started at
    let enteredAt = 0;   // heardMs at entry, for the dwell
    let prevKind = 'intro';
    let entrySlow = 0;   // energy when the current section began

    function enter(next, posMs) {
      if (next === kind) return false;
      prevKind = kind;
      kind = next;
      since = posMs;
      enteredAt = heardMs;
      entrySlow = slow;
      return true;
    }

    /**
     * Feed one frame.
     * @param {object} f
     * @param {number} f.dt          frame delta (ms)
     * @param {number} f.posMs       song position
     * @param {number} f.durationMs  song length, 0 if unknown
     * @param {number} f.level       loudness 0..1
     * @param {number} [f.build]     build-up detector 0..1
     * @param {number} [f.anticipation] heat-map lookahead rise 0..1
     * @param {boolean} [f.drop]     a drop landed this frame
     * @returns {{kind: string, startMs: number, changed: boolean, rel: number}}
     */
    function step(f) {
      const dt = Math.max(0, Math.min(250, f.dt || 0));
      heardMs += dt;
      const lvl = Math.max(0, f.level || 0);
      slow += (lvl - slow) * Math.min(1, dt / LIVE.slowMs);
      peak = Math.max(slow, peak * Math.exp(-dt / LIVE.peakDecayMs));
      const rel = peak > 0.01 ? slow / peak : 0;
      const dwelt = heardMs - enteredAt;
      const rising = Math.max(f.build || 0, f.anticipation || 0) > LIVE.build;
      const quietKind = () => {
        if (f.posMs < 30000) return 'intro';
        if (f.durationMs > 0 && f.posMs > f.durationMs - 30000) return 'outro';
        return 'break';
      };

      let changed = false;
      if (f.drop && kind !== 'drop' && rel > LIVE.quiet) {
        // A real drop cuts in at once — no dwell; it is the moment that matters.
        changed = enter('drop', f.posMs);
      } else if (heardMs < LIVE.warmupMs) {
        // too early to judge
      } else if (kind === 'drop') {
        if (dwelt > LIVE.dropHoldMs && rel < LIVE.dropExit) changed = enter(rel < LIVE.quiet ? quietKind() : 'verse', f.posMs);
      } else if (dwelt > LIVE.dwellMs) {
        let next;
        // Relative energy alone cannot call a drop: early in a song whatever
        // is playing IS the peak so far, so a build would read as "loud".
        // The drop has to be louder than the build was.
        if (kind === 'build' && rel > LIVE.loud && slow > entrySlow * LIVE.jump) next = 'drop';
        else if (rising && rel > LIVE.quiet) next = 'build';
        else if (rel < LIVE.quiet) next = kind === 'intro' || kind === 'outro' || kind === 'break' ? kind : quietKind();
        else next = kind === 'build' && rising ? 'build' : 'verse';
        changed = enter(next, f.posMs);
      }
      return { kind, startMs: since, changed, rel, prevKind };
    }

    return { step, get kind() { return kind; } };
  }

  /**
   * How to cut INTO a section: 'flash' (a white hit — drops), 'dip' (to black
   * and back — the quiet parts), 'glow' (a quick bloom in the song's colour —
   * everything in between). The cut itself happens at the transition's peak,
   * where the screen is covered, which also hides an engine's cold start.
   * @returns {{style: string, leadMs: number, tailMs: number}}
   */
  function transitionFor(kind) {
    if (kind === 'drop') return { style: 'flash', leadMs: 40, tailMs: 520 };
    if (kind === 'intro' || kind === 'outro' || kind === 'break') return { style: 'dip', leadMs: 380, tailMs: 760 };
    return { style: 'glow', leadMs: 220, tailMs: 480 };
  }

  /**
   * When to cut: on the next bar line when the tempo is locked (4 beats),
   * otherwise the next beat; never sooner than the transition's lead-in, and
   * a drop goes now.
   * @param {object} q
   * @param {number} q.beatPeriodMs @param {number} q.beatClockMs ms into the current beat
   * @param {number} q.beatCount beats elapsed @param {boolean} q.locked
   * @param {number} q.leadMs @param {string} q.kind
   * @returns {number} ms from now
   */
  function cutDelay(q) {
    if (q.kind === 'drop') return q.leadMs;
    const P = q.beatPeriodMs > 0 ? q.beatPeriodMs : 500;
    let wait = P - (q.beatClockMs % P);
    if (q.locked) wait += ((4 - ((q.beatCount + 1) % 4)) % 4) * P;
    const step = q.locked ? P * 4 : P;
    while (wait < q.leadMs) wait += step;
    return wait;
  }

  window.Director = {
    plan,
    createLive,
    transitionFor,
    cutDelay,
    LIVE,
    intensityFor,
    kinds: ['intro', 'verse', 'build', 'drop', 'break', 'outro'],
    SHADERS,
    CALM_OVERLAY,
  };
})();
