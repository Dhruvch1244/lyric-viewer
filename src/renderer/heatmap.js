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

  Exposed on window.HeatMap.
*/

(function () {
  /** Cells across the whole song, whatever its length. */
  const BIN_COUNT = 96;

  /** Bands kept per bin. Enough to colour by character, cheap to store. */
  const BANDS = ['level', 'bass', 'treble'];

  /** A bin needs this many samples before it is treated as real. */
  const MIN_SAMPLES = 2;

  /** @type {{durationMs: number, bins: Array}|null} */
  let map = null;
  let dirty = false;

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
  }

  /**
   * Load a previously learned map, or clear with null.
   * @param {{durationMs: number, bins: Array}|null} saved
   */
  function load(saved) {
    if (!saved || !Array.isArray(saved.bins) || saved.bins.length !== BIN_COUNT) {
      map = null;
      dirty = false;
      return;
    }
    map = saved;
    dirty = false;
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
      if (Number.isFinite(v) && v > bin[band]) { bin[band] = v; dirty = true; }
    }
    bin.n += 1;
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
   * @returns {Array<{level: number, bass: number, treble: number, known: boolean}>}
   */
  function cells() {
    if (!map) return [];
    let peak = 0;
    for (const b of map.bins) if (b.level > peak) peak = b.level;
    const scale = peak > 0 ? 1 / peak : 0;
    return map.bins.map((b) => ({
      level: Math.min(1, b.level * scale),
      bass: Math.min(1, b.bass * scale),
      treble: Math.min(1, b.treble * scale),
      known: b.n >= MIN_SAMPLES,
    }));
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

  /** Whether anything new has been learned since the last save. */
  function isDirty() {
    return dirty;
  }

  /** Take the map for persisting, clearing the dirty flag. */
  function takeForSave() {
    dirty = false;
    return map;
  }

  window.HeatMap = {
    start, load, note, get, cells, coverage, isDirty, takeForSave,
    BIN_COUNT, MIN_SAMPLES,
  };
})();
