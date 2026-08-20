'use strict';

/*
  Offline song analysis — the whole shape of a track, before it plays.

  Everything this app learns about a song (the energy arc behind the timeline,
  the measured tempo the platter and the dancers run on, the anticipation that
  reads a stored map forwards) has until now required `♫` loopback capture and a
  full listen. Play a song for the first time and you get none of it; the second
  play is when it comes alive.

  With a local file there is no reason to wait. The decoded samples are already
  in hand, so the same measurements can be taken over the whole track in a
  fraction of a second — and the visuals can anticipate a drop on the FIRST
  play, with no capture and no permission prompt.

  DESIGN. The band split is done with two one-pole filters rather than Web
  Audio's biquads, for one deliberate reason: it keeps this file pure arithmetic
  over a Float32Array. No AudioContext, no async rendering, and — the point —
  the analysis is testable in Node without a browser. `analyseSamples` is the
  whole algorithm and it takes numbers and returns numbers.

  Exposed on window.SongAnalysis.
*/

(function () {
  /** Envelope window. ~23ms at 44.1kHz: short enough to catch a kick. */
  const WINDOW_MS = 23;

  /** Cutoffs for the two bands, in Hz. */
  const BASS_HZ = 200;
  const TREBLE_HZ = 4000;

  /** An onset needs the bass to exceed its running floor by this much. */
  const ONSET_THRESHOLD = 0.12;

  /** How fast the running floor follows the signal (per window). */
  const FLOOR_RATE = 0.10;

  /**
   * One-pole coefficient for a cutoff frequency.
   * @param {number} hz @param {number} sampleRate
   * @returns {number} 0..1
   */
  function poleAlpha(hz, sampleRate) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * hz);
    return dt / (rc + dt);
  }

  /**
   * Measure a song from its raw samples.
   *
   * Returns per-window envelopes normalised against the track's own peak — the
   * same convention `HeatMap.cells()` uses, because what matters is a song's
   * internal dynamics, not how hot it was mastered.
   *
   * @param {Float32Array} samples mono (or one channel of) PCM
   * @param {number} sampleRate
   * @returns {{windowMs: number, level: Float32Array, bass: Float32Array,
   *            treble: Float32Array, onsets: number[]}}
   */
  function analyseSamples(samples, sampleRate) {
    const empty = {
      windowMs: WINDOW_MS,
      level: new Float32Array(0),
      bass: new Float32Array(0),
      treble: new Float32Array(0),
      onsets: [],
    };
    if (!samples || !samples.length || !(sampleRate > 0)) return empty;

    const hop = Math.max(1, Math.round((WINDOW_MS / 1000) * sampleRate));
    const count = Math.floor(samples.length / hop);
    if (count < 1) return empty;

    const level = new Float32Array(count);
    const bass = new Float32Array(count);
    const treble = new Float32Array(count);

    const aLow = poleAlpha(BASS_HZ, sampleRate);
    const aHigh = poleAlpha(TREBLE_HZ, sampleRate);
    // Low-pass state, and the high-pass's previous input/output.
    let low = 0;
    let hpPrevIn = 0;
    let hpPrevOut = 0;
    // The high-pass coefficient is expressed the other way round: a value near
    // 1 passes fast changes and rejects slow ones.
    const hpA = 1 - aHigh;

    for (let w = 0; w < count; w += 1) {
      const start = w * hop;
      const end = start + hop;
      let sumSq = 0;
      let sumLow = 0;
      let sumHigh = 0;
      for (let i = start; i < end; i += 1) {
        const x = samples[i];
        sumSq += x * x;

        low += aLow * (x - low);
        sumLow += low * low;

        const hp = hpA * (hpPrevOut + x - hpPrevIn);
        hpPrevIn = x;
        hpPrevOut = hp;
        sumHigh += hp * hp;
      }
      level[w] = Math.sqrt(sumSq / hop);
      bass[w] = Math.sqrt(sumLow / hop);
      treble[w] = Math.sqrt(sumHigh / hop);
    }

    /*
      One shared scale for all three bands, NOT one each.

      Normalising each band against its own peak would make every song's bass
      and treble both top out at 1, which destroys the only thing the bands are
      compared for: `HeatMap` tints a cell by whether `bass >= treble`, and the
      live analyser produces bands on a common scale. Scaling them together
      keeps that comparison meaningful while still erasing mastering level.
    */
    const scale = 1 / Math.max(peakOf(level), peakOf(bass), peakOf(treble), 1e-9);
    for (let i = 0; i < level.length; i += 1) {
      level[i] *= scale;
      bass[i] *= scale;
      treble[i] *= scale;
    }

    return { windowMs: WINDOW_MS, level, bass, treble, onsets: findOnsets(bass, WINDOW_MS) };
  }

  /** Largest value in an envelope. */
  function peakOf(arr) {
    let peak = 0;
    for (let i = 0; i < arr.length; i += 1) if (arr[i] > peak) peak = arr[i];
    return peak;
  }

  /**
   * Bass onsets, as timestamps in ms.
   *
   * Tested by DIFFERENCE against a running floor, not by ratio — the same
   * correction 0.12.0 had to make to the live detector. A ratio has no headroom
   * once the signal saturates, and modern masters sit pegged near the top of
   * the range for a whole song, which made the ratio test structurally dead on
   * exactly the genres with the strongest kicks.
   *
   * @param {Float32Array} bass normalised bass envelope
   * @param {number} windowMs
   * @returns {number[]}
   */
  function findOnsets(bass, windowMs) {
    const onsets = [];
    let floor = 0;
    let armed = true;
    for (let i = 0; i < bass.length; i += 1) {
      const v = bass[i];
      if (armed && v - floor > ONSET_THRESHOLD) {
        onsets.push(i * windowMs);
        armed = false;                    // wait for a fall before firing again
      } else if (v <= floor + ONSET_THRESHOLD * 0.4) {
        armed = true;
      }
      floor += (v - floor) * FLOOR_RATE;
    }
    return onsets;
  }

  /**
   * Analyse a decoded buffer and load the result into the app's learned state.
   *
   * Mixes to mono first: stereo width says nothing about energy or tempo, and
   * halving the sample count halves the work.
   *
   * Feeds the SAME modules the live path feeds, so nothing downstream needs to
   * know where the measurements came from — the timeline, the structure labels
   * and anticipation all just find the song already known.
   *
   * @param {AudioBuffer} buffer
   * @returns {{windows: number, onsets: number, bpm: number|null, ms: number}}
   */
  function loadFromBuffer(buffer) {
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mono = toMono(buffer);
    const result = analyseSamples(mono, buffer.sampleRate);
    const summary = applyAnalysis(result, buffer.duration * 1000);
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    return { ...summary, ms };
  }

  /**
   * Load an already-computed analysis (from anywhere — the JS pass above, or the
   * native Rust `analyze_local_file`) into the learned state: fill the heat map
   * and estimate tempo. `result` needs `windowMs` + the `level/bass/treble`
   * envelopes + `onsets`; the envelopes may be plain arrays (JSON from Rust) or
   * typed arrays — both index the same.
   *
   * `result.beats` is the native beat grid (`beats.rs`, JOB-ENGINE §7.12) and
   * is preferred over the onset estimator whenever it is present: it is a
   * dynamic program over the whole song rather than a guess from a rolling
   * window, and it carries the beat *positions*, not only a tempo. The
   * estimator stays as the fallback for the Web Audio path, which has no such
   * grid.
   *
   * `result.key` is the detected musical key (`key.rs`, §7.13), passed
   * through untouched. Absent whenever nothing was decisive enough to name,
   * which is a normal outcome the caller must handle rather than a failure.
   *
   * @param {{windowMs:number, level:number[], bass:number[], treble:number[], onsets:number[],
   *          beats?:{bpm:number, beatsMs:number[], confidence:number},
   *          key?:{tonic:number, name:string, major:boolean, label:string, confidence:number},
   *          sectionStartsMs?:number[]}} result
   * @param {number} durationMs
   * @returns {{windows:number, onsets:number, bpm:number|null, beatsMs:number[]|null,
   *            key:object|null, source:string}}
   */
  function applyAnalysis(result, durationMs) {
    if (!result || !result.level) {
      return { windows: 0, onsets: 0, bpm: null, beatsMs: null, key: null, source: 'none' };
    }
    if (window.HeatMap) {
      window.HeatMap.start(durationMs);
      for (let w = 0; w < result.level.length; w += 1) {
        window.HeatMap.note(w * result.windowMs, {
          level: result.level[w],
          bass: result.bass[w],
          treble: result.treble[w],
        });
      }
      /* Measured section boundaries (structure.rs), set AFTER the bins are
         filled so the sections they define have energy to be named from.
         Always called, with null when there are none, so a track with no
         measured structure falls back to energy tiers rather than inheriting
         the previous song's boundaries. */
      if (window.HeatMap.setSections) window.HeatMap.setSections(result.sectionStartsMs || null);
    }
    /* Loudness normalisation for the live envelope (loudness.rs). Always set,
       with 1 when unmeasured, so a track with no measurement does not inherit
       the previous song's correction. */
    if (window.AudioReactive && window.AudioReactive.setLoudnessGain) {
      window.AudioReactive.setLoudnessGain((result.loudness && result.loudness.gain) || 1);
    }
    let bpm = null;
    let beatsMs = null;
    let source = 'none';
    const grid = result.beats;
    if (grid && grid.bpm > 0 && Array.isArray(grid.beatsMs) && grid.beatsMs.length > 1) {
      bpm = grid.bpm;
      beatsMs = grid.beatsMs;
      source = 'grid';
    }
    const onsets = result.onsets || [];
    if (bpm === null && window.Tempo && onsets.length) {
      const est = window.Tempo.estimate(onsets);
      if (est) { bpm = est.bpm; source = 'onsets'; }
    }
    return { windows: result.level.length, onsets: onsets.length, bpm, beatsMs, key: result.key || null, source };
  }

  /**
   * How far past the most recent measured beat a playback position sits.
   *
   * The point of keeping the grid rather than only its tempo: the beat clock's
   * PHASE can then come from the measurement too. The live alternative
   * (`Tempo.phaseFor`) needs loopback capture to be on, so with ♫ off the
   * clock free-runs and slowly slides against the music even though the period
   * is exactly right. A grid knows where every beat is with no audio at all.
   *
   * Reads the grid rather than assuming a fixed period, because a real grid is
   * not perfectly even — that is the whole reason it is a list of positions
   * and not a number.
   *
   * @param {number[]|null} beatsMs measured beat positions, ascending
   * @param {number} positionMs current playback position, same origin
   * @returns {number|null} ms since the last beat, or null before the first
   *   beat / with no usable grid
   */
  function beatPhaseAt(beatsMs, positionMs) {
    if (!Array.isArray(beatsMs) || beatsMs.length < 2) return null;
    if (!(positionMs >= beatsMs[0])) return null; // also catches NaN
    let lo = 0;
    let hi = beatsMs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beatsMs[mid] <= positionMs) lo = mid;
      else hi = mid - 1;
    }
    return positionMs - beatsMs[lo];
  }

  /**
   * Move a hue part of the way toward a target hue, the short way round.
   *
   * Used to tint a palette by musical key (minor cool, major warm). A fixed
   * rotation cannot express that: +20° warms a blue palette and cools a red
   * one. Nudging toward a target does the same thing to every palette, and
   * keeping `amount` small biases the artwork's colours rather than replacing
   * them.
   *
   * The short way round is the whole subtlety — going from 350° to 10° is +20,
   * not −340, and a naive subtraction sends the colour the long way through
   * every other hue on the wheel.
   *
   * @param {number} hue degrees, any range
   * @param {number} target degrees
   * @param {number} amount 0..1 of the way there
   * @returns {number} degrees in [0, 360)
   */
  function hueTowards(hue, target, amount) {
    const delta = ((((target - hue) % 360) + 540) % 360) - 180;
    return ((hue + delta * amount) % 360 + 360) % 360;
  }

  /**
   * Average all channels into one Float32Array.
   * @param {AudioBuffer} buffer
   * @returns {Float32Array}
   */
  function toMono(buffer) {
    const n = buffer.length;
    const channels = buffer.numberOfChannels;
    if (channels === 1) return buffer.getChannelData(0);
    const out = new Float32Array(n);
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < n; i += 1) out[i] += data[i];
    }
    const s = 1 / channels;
    for (let i = 0; i < n; i += 1) out[i] *= s;
    return out;
  }

  const api = {
    analyseSamples, findOnsets, loadFromBuffer, applyAnalysis, beatPhaseAt, hueTowards,
    WINDOW_MS, ONSET_THRESHOLD,
  };

  // Browser IIFE by default; also requireable so the arithmetic can be tested
  // in Node with no browser and no AudioContext.
  if (typeof window !== 'undefined') window.SongAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
