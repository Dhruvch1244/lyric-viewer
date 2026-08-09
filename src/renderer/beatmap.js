'use strict';

/*
  Learn-on-listen beat maps.

  The first time you play a song WITH system-audio capture on, the reactive engine
  (audio.js) already derives kicks / build-ups / drops from the live spectrum. This
  module records those events against the song's playback position and hands the
  finished map back to the main process to persist per track.

  On any later play — even with audio capture OFF — the stored map drives the same
  moments, aligned to the song position from SMTC. Because the whole timeline is
  known ahead of time, build-ups can be *anticipated*: the glow ramps in over the
  ~1.8s BEFORE a drop instead of only reacting after it lands.

  Exposed on `window.BeatMap`:
    - startRecording()                 begin a fresh recording for the current song
    - note(posMs, env)                 feed one live audio frame while recording
    - takeRecording()                  → {drops, kicks, duration} | null, and clears it
    - load(map)                        set the map to play back (or null to clear)
    - hasPlayback()                    → boolean
    - tick(posMs)                      → {drop, kick, buildup} events to apply now
*/

(function () {
  /* Recording dedupe windows (ms) and safety caps. */
  const DROP_MIN_GAP = 1500;
  const KICK_MIN_GAP = 110;
  const KICK_MIN_STRENGTH = 0.5;   // only log clearly audible drum hits
  const MAX_DROPS = 400;
  const MAX_KICKS = 4000;

  /* Playback tuning. */
  const BUILDUP_LEAD_MS = 1800;    // how long before a drop the anticipation ramps
  const SEEK_RESET_MS = 2000;      // a jump larger than this = a seek → don't fire

  /* ------------------------------------------------------------- recording */

  /** @type {{drops:number[], kicks:{t:number,v:number}[]} | null} */
  let rec = null;
  let lastRecDrop = -Infinity;
  let lastRecKick = -Infinity;
  let recMaxPos = 0;

  function startRecording() {
    rec = { drops: [], kicks: [] };
    lastRecDrop = -Infinity;
    lastRecKick = -Infinity;
    recMaxPos = 0;
  }

  /**
   * Record one live audio frame.
   * @param {number} posMs song position
   * @param {{drop:boolean, kick:number}} env live audio envelope from audio.js
   */
  function note(posMs, env) {
    if (!rec || !env || !Number.isFinite(posMs) || posMs < 0) return;
    if (posMs > recMaxPos) recMaxPos = posMs;

    if (env.drop && posMs - lastRecDrop > DROP_MIN_GAP) {
      rec.drops.push(Math.round(posMs));
      lastRecDrop = posMs;
      if (rec.drops.length > MAX_DROPS) rec.drops.shift();
    }
    if (env.kick > KICK_MIN_STRENGTH && posMs - lastRecKick > KICK_MIN_GAP) {
      rec.kicks.push({ t: Math.round(posMs), v: Math.round(env.kick * 100) / 100 });
      lastRecKick = posMs;
      if (rec.kicks.length > MAX_KICKS) rec.kicks.shift();
    }
  }

  /**
   * Hand back the current recording (sorted, de-duplicated) and clear it. Returns
   * null when nothing worth saving was captured.
   * @returns {{drops:number[], kicks:{t:number,v:number}[], duration:number}|null}
   */
  function takeRecording() {
    const out = rec;
    rec = null;
    if (!out || (out.drops.length === 0 && out.kicks.length < 8)) return null;
    out.drops.sort((a, b) => a - b);
    out.kicks.sort((a, b) => a.t - b.t);
    return { drops: out.drops, kicks: out.kicks, duration: Math.round(recMaxPos) };
  }

  /* -------------------------------------------------------------- playback */

  /** @type {{drops:number[], kicks:{t:number,v:number}[], duration:number} | null} */
  let map = null;
  let dropIdx = 0;
  let kickIdx = 0;
  let lastTickPos = -Infinity;

  /** First index in a sorted array whose value is >= pos (binary search). */
  function lowerBound(arr, pos, keyFn) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keyFn(arr[mid]) < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Point both cursors at the first event at/after `pos` (used on load + seeks). */
  function reseek(pos) {
    dropIdx = map ? lowerBound(map.drops, pos, (t) => t) : 0;
    kickIdx = map ? lowerBound(map.kicks, pos, (k) => k.t) : 0;
    lastTickPos = pos;
  }

  /**
   * Load a stored map for playback, or null to clear.
   * @param {{drops:number[], kicks:{t:number,v:number}[], duration:number}|null} m
   */
  function load(m) {
    map = m && Array.isArray(m.drops) && Array.isArray(m.kicks) ? m : null;
    dropIdx = 0;
    kickIdx = 0;
    lastTickPos = -Infinity;
  }

  function hasPlayback() {
    return Boolean(map);
  }

  /**
   * Advance playback to the current position and report events to fire this frame.
   * Returns a drop flag, the strongest kick crossed since the last tick, and an
   * anticipation build-up level (0..1) that ramps toward the next drop.
   * @param {number} posMs song position
   * @returns {{drop:boolean, kick:number, buildup:number}}
   */
  function tick(posMs) {
    const result = { drop: false, kick: 0, buildup: 0 };
    if (!map || !Number.isFinite(posMs)) return result;

    // A backward jump or a big forward skip is a seek: re-index without firing the
    // events we leapt over.
    if (posMs < lastTickPos || posMs - lastTickPos > SEEK_RESET_MS) {
      reseek(posMs);
      return result;
    }

    // Fire every drop/kick whose timestamp we crossed since the last tick.
    while (dropIdx < map.drops.length && map.drops[dropIdx] <= posMs) {
      result.drop = true;
      dropIdx += 1;
    }
    while (kickIdx < map.kicks.length && map.kicks[kickIdx].t <= posMs) {
      if (map.kicks[kickIdx].v > result.kick) result.kick = map.kicks[kickIdx].v;
      kickIdx += 1;
    }

    // Anticipation: ramp build-up over the window before the next upcoming drop.
    const nextDropT = dropIdx < map.drops.length ? map.drops[dropIdx] : Infinity;
    const untilDrop = nextDropT - posMs;
    if (untilDrop >= 0 && untilDrop < BUILDUP_LEAD_MS) {
      result.buildup = 1 - untilDrop / BUILDUP_LEAD_MS;
    }

    lastTickPos = posMs;
    return result;
  }

  window.BeatMap = {
    startRecording,
    note,
    takeRecording,
    load,
    hasPlayback,
    tick,
  };
})();
