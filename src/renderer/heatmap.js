'use strict';

/*
  Song heatmap — the shape of a track, learned by listening to it.

  The visuals react to the moment they are in and nothing else: they cannot
  anticipate, and when you replay a song they know no more than the first time.
  A heatmap fixes that. Energy is binned against POSITION IN THE SONG rather
  than wall-clock time, so what is recorded is a property of the track, not of
  one playthrough — replay it and the whole arc is already known.

  That is what makes it a visualiser rather than a meter: the drop at 2:14 can
  be drawn before it arrives, and the quiet bar before it can be drawn as quiet,
  because the song has been heard before.

  Bins rather than a curve, because the display is a fixed number of cells and
  binning at capture time keeps both memory and draw cost constant regardless of
  track length. BIN_COUNT cells across any song means a 90-second interlude and
  a 9-minute epic cost exactly the same.

  Each bin holds the loudest moment it saw, not the average: a heatmap of
  averages washes out to a flat mid-grey, because the interesting thing about a
  drop is its PEAK, and averaging it with the bar either side removes precisely
  the feature worth drawing.

  Once a map is on disk it can be read FORWARDS, which is the only thing in this
  app that knows what has not happened yet: `lookahead` reports a rise before it
  arrives, and `sections` names the shape of the track. Both refuse to answer
  from a song that has not been heard enough — a guess about the future is worse
  than admitting there is nothing to say.

  Exposed on window.HeatMap.
*/

(function () {
  /** Cells across the whole song, whatever its length. */
  const BIN_COUNT = 96;

  /** Bands kept per bin. Enough to colour by character, cheap to store. */
  const BANDS = ['level', 'bass', 'treble'];

  /** A bin needs this many samples before it is treated as real. */
  const MIN_SAMPLES = 2;

  /**
   * How different a saved map's track length may be before it is treated as a
   * different recording (ms). Radio edits, extended mixes and live versions
   * share a title and an artist but not an arrangement, so replaying a stored
   * arc against the wrong one would draw a confident, wrong shape.
   */
  const DURATION_TOLERANCE_MS = 2000;

  /** Structure: level below this is quiet, above the second is loud. */
  const TIER_QUIET = 0.40;
  const TIER_LOUD = 0.72;

  /** Runs shorter than this are noise, not sections. */
  const MIN_SECTION_BINS = 4;

  /** Structure needs this much of the song heard before it is claimed. */
  const MIN_STRUCTURE_COVERAGE = 0.5;

  /** @type {{durationMs: number, bins: Array}|null} */
  let map = null;
  let dirty = false;

  /**
   * Measured section starts (ms), from the native offline pass
   * (`structure.rs`), or null.
   *
   * When present these REPLACE the energy-tier runs `sections()` would
   * otherwise derive, but nothing else: each resulting section is still named
   * and levelled from the heat map exactly as before. Energy tiers split a
   * song where its loudness changes, which is wrong for a verse and a chorus
   * at the same level (one section) and for a crescendo inside one (two).
   * Chroma novelty splits where the harmony changes, which is what a boundary
   * is. So structure supplies *where*, the heat map still supplies *what*.
   * @type {number[]|null}
   */
  let measuredStarts = null;

  /* Bumped whenever a bin changes, so the derived structure can be memoised
     without comparing 96 cells: the renderer asks for it every frame and it
     only actually changes when something new is heard. */
  let revision = 0;
  /** @type {{revision: number, value: Array}|null} */
  let structureCache = null;
  /** @type {{revision: number, value: Array}|null} */
  let cellsCache = null;
  /** @type {{revision: number, value: number}|null} */
  let peakCache = null;

  /**
   * The loudest `level` seen across all bins, memoised against `revision`.
   *
   * `cells()` and `lookahead()` both normalise against this and used to each
   * do their own 96-bin scan; `lookahead()` is called every audio-active
   * frame, so that was a full pass over the map 60 times a second for a
   * number that only changes when a bin does.
   * @returns {number}
   */
  function peakLevel() {
    if (!map) return 0;
    if (peakCache && peakCache.revision === revision) return peakCache.value;
    let peak = 0;
    for (const b of map.bins) if (b.level > peak) peak = b.level;
    peakCache = { revision, value: peak };
    return peak;
  }

  /**
   * Start (or resume) recording for a track of known length.
   * @param {number} durationMs
   */
  function start(durationMs) {
    const dur = Number(durationMs);
    if (!Number.isFinite(dur) || dur <= 0) { map = null; return; }
    if (map && map.durationMs === dur) return;   // already recording this track
    map = {
      durationMs: dur,
      bins: Array.from({ length: BIN_COUNT }, () => ({ level: 0, bass: 0, treble: 0, n: 0 })),
    };
    dirty = false;
    revision += 1;
  }

  /**
   * Load a previously learned map, or clear with null.
   *
   * A saved map is rejected when its track length disagrees with the one
   * currently playing: same title, same artist, different arrangement is a real
   * case (radio edit, extended mix, live cut), and drawing the stored arc over
   * the wrong recording would put the drop confidently in the wrong place.
   * Rejection leaves whatever `start` set up, so the song simply learns itself
   * again rather than being left with nothing.
   *
   * @param {{durationMs: number, bins: Array}|null} saved
   * @returns {boolean} whether the map was adopted
   */
  function load(saved) {
    if (!saved || !Array.isArray(saved.bins) || saved.bins.length !== BIN_COUNT) {
      map = null;
      dirty = false;
      return false;
    }
    if (map && Math.abs(Number(saved.durationMs) - map.durationMs) > DURATION_TOLERANCE_MS) {
      return false;   // keep the fresh map `start` made for the track that is actually playing
    }
    map = saved;
    dirty = false;
    revision += 1;
    return true;
  }

  /**
   * Record one sample at a playback position.
   * @param {number} positionMs
   * @param {{level: number, bass: number, treble: number}} env
   */
  function note(positionMs, env) {
    if (!map || !env) return;
    const pos = Number(positionMs);
    if (!Number.isFinite(pos) || pos < 0) return;

    const i = Math.min(BIN_COUNT - 1, Math.floor((pos / map.durationMs) * BIN_COUNT));
    if (i < 0) return;
    const bin = map.bins[i];

    // Peak-hold: keep the loudest moment this bin has seen, across plays.
    for (const band of BANDS) {
      const v = Number(env[band]);
      if (Number.isFinite(v) && v > bin[band]) { bin[band] = v; dirty = true; revision += 1; }
    }
    bin.n += 1;
    // Crossing MIN_SAMPLES turns a bin from unheard to known, which changes both
    // coverage and the derived structure even though no peak moved.
    if (bin.n === MIN_SAMPLES) revision += 1;
  }

  /**
   * The map, or null when nothing usable has been learned.
   * @returns {{durationMs: number, bins: Array}|null}
   */
  function get() {
    return map;
  }

  /**
   * Normalised cells for drawing: 0..1 per band, with unheard bins marked.
   *
   * Normalised against the song's OWN loudest bin rather than an absolute
   * scale, because the interesting thing is a track's internal dynamics — where
   * it lifts and where it drops away — not how hot it was mastered.
   *
   * Memoised against the same revision counter as `sections`, because the
   * renderer asks every frame while the answer changes only when a bin does:
   * rebuilding allocated 96 objects and an array 60 times a second to hand back
   * identical values.
   *
   * The returned array is SHARED — treat it as read-only. Nothing in the app
   * writes to it, and copying defensively would reintroduce the allocation this
   * cache exists to remove.
   *
   * @returns {Array<{level: number, bass: number, treble: number, known: boolean}>}
   */
  function cells() {
    if (!map) return [];
    if (cellsCache && cellsCache.revision === revision) return cellsCache.value;
    const peak = peakLevel();
    const scale = peak > 0 ? 1 / peak : 0;
    const value = map.bins.map((b) => ({
      level: Math.min(1, b.level * scale),
      bass: Math.min(1, b.bass * scale),
      treble: Math.min(1, b.treble * scale),
      known: b.n >= MIN_SAMPLES,
    }));
    cellsCache = { revision, value };
    return value;
  }

  /**
   * How much of the song has been heard, 0..1. Lets the caller show a partial
   * map honestly rather than pretending a half-learned song is complete.
   * @returns {number}
   */
  function coverage() {
    if (!map) return 0;
    const known = map.bins.filter((b) => b.n >= MIN_SAMPLES).length;
    return known / BIN_COUNT;
  }

  /* ------------------------------------------------------- reading forwards */

  /**
   * What is coming, as seen from a playback position.
   *
   * This is the only forward-looking thing in the app. Everything else reacts to
   * the sample it is holding; a stored map has already heard the rest of the
   * song, so the build-up before a drop can be *played into* rather than
   * discovered a frame late.
   *
   * `rise` is how much louder the loudest moment in the window ahead is than
   * now, and `imminence` is how close that moment has come — separate on
   * purpose, because a big drop forty seconds out and a small one two seconds
   * out deserve different treatment, and the caller multiplies them as it sees
   * fit.
   *
   * Returns zeroes rather than a guess whenever the window ahead has not
   * actually been heard.
   *
   * @param {number} positionMs
   * @param {number} [aheadMs] how far to look; ~6s is about how long a build reads for
   * @returns {{rise: number, imminence: number, toPeakMs: number, peak: number, level: number}}
   */
  function lookahead(positionMs, aheadMs = 6000) {
    const none = { rise: 0, imminence: 0, toPeakMs: 0, peak: 0, level: 0 };
    if (!map) return none;
    const pos = Number(positionMs);
    const window = Number(aheadMs);
    if (!Number.isFinite(pos) || pos < 0 || !Number.isFinite(window) || window <= 0) return none;

    const binMs = map.durationMs / BIN_COUNT;
    const here = Math.min(BIN_COUNT - 1, Math.floor(pos / binMs));
    if (here < 0) return none;

    // Normalise against the song's own loudest bin, exactly as cells() does, so
    // "rise" means the same thing on a quiet track and a loud one. Shared,
    // revision-memoised scan — this function runs every audio-active frame.
    const top = peakLevel();
    if (top <= 0) return none;

    const nowBin = map.bins[here];
    if (nowBin.n < MIN_SAMPLES) return none;
    const level = nowBin.level / top;

    const last = Math.min(BIN_COUNT - 1, Math.floor((pos + window) / binMs));
    let peak = 0;
    let peakBin = -1;
    for (let i = here + 1; i <= last; i += 1) {
      const b = map.bins[i];
      if (b.n < MIN_SAMPLES) continue;          // never heard — say nothing about it
      const v = b.level / top;
      if (v > peak) { peak = v; peakBin = i; }
    }
    if (peakBin < 0) return { ...none, level };

    // Time to the START of the peak bin: that is where the rise lands, and
    // aiming at its centre would consistently fire late.
    const toPeakMs = Math.max(0, peakBin * binMs - pos);
    return {
      rise: Math.max(0, Math.min(1, peak - level)),
      imminence: Math.max(0, Math.min(1, 1 - toPeakMs / window)),
      toPeakMs,
      peak,
      level,
    };
  }

  /**
   * Name a bin's energy tier. Three tiers, because two cannot tell a build from
   * a drop and four produce boundaries no listener would agree with.
   * @param {number} level 0..1
   * @returns {0|1|2}
   */
  function tierOf(level) {
    if (level < TIER_QUIET) return 0;
    if (level < TIER_LOUD) return 1;
    return 2;
  }

  /**
   * The song split into named sections.
   *
   * Derived from the same bins rather than stored separately, so it costs
   * nothing extra to learn and cannot drift out of step with the heatmap.
   * Levels are smoothed first: structure is about sustained energy, and a
   * single loud bin is a crash cymbal, not a chorus.
   *
   * Returns an empty list until enough of the song has been heard — a section
   * list built from a quarter of a track is fiction.
   *
   * @returns {Array<{startMs: number, endMs: number, kind: string, level: number}>}
   */
  function sections() {
    if (!map || coverage() < MIN_STRUCTURE_COVERAGE) return [];
    // The renderer asks every frame; the answer only changes when a bin does.
    if (structureCache && structureCache.revision === revision) return structureCache.value;
    const raw = cells();
    const binMs = map.durationMs / BIN_COUNT;
    if (binMs <= 0) return [];

    // 3-wide moving average over known cells only, so an unheard gap does not
    // read as a quiet passage.
    const smooth = raw.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(raw.length - 1, i + 1); j += 1) {
        if (!raw[j].known) continue;
        sum += raw[j].level;
        n += 1;
      }
      return n ? sum / n : 0;
    });

    /** @type {Array<{from: number, to: number, tier: number, level: number}>} */
    let runs;
    const measured = Boolean(measuredStarts && measuredStarts.length > 1);
    if (measured) {
      // Measured boundaries. No tier-run derivation and no short-run
      // absorption: structure.rs already enforces a minimum section length,
      // and absorbing here would undo a boundary it was confident about.
      // Each boundary becomes a start bin; each section then runs up to the
      // bin before the next one. Derived that way round, not from both ends
      // independently, because the two roundings disagree at a boundary that
      // falls inside a bin — and a section computed as ending after the next
      // one begins is the kind of overlap that quietly loses a whole section.
      const starts = [];
      for (const ms of measuredStarts) {
        const bin = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor(ms / binMs)));
        // Two boundaries inside one bin would produce an empty section, and a
        // section shorter than a bin cannot be drawn anyway.
        if (!starts.length || bin > starts[starts.length - 1]) starts.push(bin);
      }
      runs = starts.map((from, i) => ({
        from,
        to: i + 1 < starts.length ? starts[i + 1] - 1 : BIN_COUNT - 1,
        tier: 0,
        level: 0,
      }));
    } else {
      // Runs of equal tier — the fallback for anything with no measured
      // structure (every SMTC track, and any local file too short or too
      // uniform for structure.rs to commit to a boundary).
      runs = [];
      for (let i = 0; i < smooth.length; i += 1) {
        const tier = tierOf(smooth[i]);
        const last = runs[runs.length - 1];
        if (last && last.tier === tier) last.to = i;
        else runs.push({ from: i, to: i, tier, level: 0 });
      }

      // Absorb runs too short to be a section into their neighbour, longest wins.
      for (let i = runs.length - 1; i >= 0 && runs.length > 1; i -= 1) {
        const run = runs[i];
        if (run.to - run.from + 1 >= MIN_SECTION_BINS) continue;
        const prev = runs[i - 1];
        const next = runs[i + 1];
        const into = !prev ? next : !next ? prev
          : (prev.to - prev.from) >= (next.to - next.from) ? prev : next;
        into.from = Math.min(into.from, run.from);
        into.to = Math.max(into.to, run.to);
        runs.splice(i, 1);
      }
    }

    for (const run of runs) {
      let sum = 0;
      for (let i = run.from; i <= run.to; i += 1) sum += smooth[i];
      run.level = sum / (run.to - run.from + 1);
      // A measured run has no tier yet — it was cut by harmony, not level —
      // so give it one from its own mean energy. This is what keeps `kind`
      // ("drop", "build", "verse") meaning exactly what it always meant.
      // Tier runs already carry theirs and must keep it: absorption merges
      // runs of different tiers, so re-deriving from the mean there would
      // silently rename sections the fallback path has always named one way.
      if (measured) run.tier = tierOf(run.level);
    }

    const value = runs.map((run, i) => ({
      startMs: run.from * binMs,
      endMs: (run.to + 1) * binMs,
      kind: kindOf(run, runs[i + 1], i === 0, i === runs.length - 1),
      level: run.level,
    }));
    structureCache = { revision, value };
    return value;
  }

  /**
   * Name one run from its tier and what follows it.
   * @param {{tier: number, level: number}} run
   * @param {{tier: number, level: number}|undefined} next
   * @param {boolean} first @param {boolean} last
   * @returns {string}
   */
  function kindOf(run, next, first, last) {
    if (run.tier === 2) return 'drop';
    if (run.tier === 1) return next && next.tier === 2 ? 'build' : 'verse';
    if (first) return 'intro';
    if (last) return 'outro';
    return 'break';
  }

  /**
   * The section covering a position, or null.
   * @param {number} positionMs
   * @returns {{startMs: number, endMs: number, kind: string, level: number}|null}
   */
  function sectionAt(positionMs) {
    const pos = Number(positionMs);
    if (!Number.isFinite(pos)) return null;
    for (const s of sections()) {
      if (pos >= s.startMs && pos < s.endMs) return s;
    }
    return null;
  }

  /**
   * Supply measured section starts (ms) for the current song, or null to go
   * back to deriving them from energy tiers.
   *
   * Must be called with null on every track change — a previous song's
   * boundaries drawn over this one's timeline are not merely stale, they are
   * confidently wrong, which is worse than the tier fallback.
   *
   * Bumps `revision`, so the memoised structure and the renderer's
   * pre-rendered timeline both rebuild.
   *
   * @param {number[]|null} startsMs ascending, starting at 0
   */
  function setSections(startsMs) {
    measuredStarts = Array.isArray(startsMs) && startsMs.length > 1 ? startsMs.slice() : null;
    revision += 1;
  }

  /** Whether anything new has been learned since the last save. */
  function isDirty() {
    return dirty;
  }

  /** Take the map for persisting, clearing the dirty flag. */
  function takeForSave() {
    dirty = false;
    return map;
  }

  /**
   * A counter that changes whenever a bin does. Lets a caller cache anything
   * derived from the map — the renderer pre-renders the timeline to a bitmap
   * and keys it on this — without comparing 96 cells every frame.
   * @returns {number}
   */
  function currentRevision() {
    return revision;
  }

  window.HeatMap = {
    start, load, note, get, cells, coverage, isDirty, takeForSave,
    lookahead, sections, sectionAt, setSections, revision: currentRevision,
    BIN_COUNT, MIN_SAMPLES, MIN_STRUCTURE_COVERAGE, DURATION_TOLERANCE_MS,
  };
})();
