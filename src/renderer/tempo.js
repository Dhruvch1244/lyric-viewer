'use strict';

/*
  Tempo estimation from kick onsets.

  The beat clock used to GUESS its period from lyric cadence — words per line
  divided by the line's duration, clamped to a musical range. That is a
  reasonable fallback when there is no audio, but it is not the tempo: it drifts
  with how wordy a line happens to be, so reactive layers pulse near the music
  rather than on it.

  Now that kick detection actually fires (see audio.js), the onsets themselves
  carry the tempo, and it can be measured instead.

  METHOD. Treat the onsets as a train of impulses and, for each candidate beat
  period, measure how tightly they cluster when wrapped around that period:

      re = Σ cos(2π·t/P),  im = Σ sin(2π·t/P),  score = √(re²+im²) / n

  This is one bin of a Fourier transform of the onset train. It is the right
  tool here for two reasons: the score is a genuine 0..1 confidence (1.0 means
  every onset lands on the same phase, ~0 means they are scattered), and the
  ANGLE of that same sum gives the beat phase for free — so where the beats
  fall comes out of the same computation as how fast they are.

  Robust to a missed or spurious kick, which a simple average of successive
  intervals is not: one dropped kick doubles an interval and skews the mean,
  whereas here it just removes one term from a sum of many.

  OCTAVE ERRORS. A period of 500ms also scores highly at 250ms and 1000ms —
  every second beat of a 120BPM track is a perfect 60BPM track. Scores alone
  cannot separate these, so ties are broken toward the range real music
  actually sits in; see PREFERRED_BPM.

  Exposed on window.Tempo.
*/

(function () {
  /** Search range. 60–200 BPM covers essentially all popular music. */
  const MIN_BPM = 60;
  const MAX_BPM = 200;

  /** Where human tempo perception clusters; used only to break octave ties. */
  const PREFERRED_BPM = 125;

  /*
    A tempo already measured across the WHOLE song, handed in by the offline
    analysis on the local-playback path (see analyze.js). When present it is
    treated as far better evidence than anything this file can derive, and for
    a simple reason: it saw three minutes, this sees twelve seconds.

    Measured on John Summit — ALL THE TIME (a 138 BPM track): the offline pass
    got 138 in 91ms, and the live estimator then reported 60, 64, 86, 147, 172
    and 179 over the course of the song at confidences from 0.31 to 0.87 —
    confident and wrong — dragging the HUD chip from 138 to 174. Note that 172
    is 138 × 1.25, not an octave of it, so the octave correction below could
    never have caught it.
  */
  let priorBpm = 0;

  /**
   * How much better a live estimate must fit than the prior before it is
   * allowed to win.
   *
   * The prior is not unconditional — a DJ set genuinely changes tempo, and a
   * track whose analysis was wrong should still be recoverable. But the bar is
   * deliberately high, because every observed disagreement so far has been the
   * live estimator being wrong.
   */
  const PRIOR_OVERRIDE_RATIO = 1.35;

  /** Within this fraction, a live estimate is "the same tempo" as the prior. */
  const PRIOR_AGREE = 0.04;

  /** Candidate step (ms). ~2ms is finer than the ear can resolve at these rates. */
  const PERIOD_STEP_MS = 2;

  /** Onsets below this can't support a stable estimate. */
  const MIN_ONSETS = 8;

  /** Only the recent past matters — tracks change tempo, and DJ sets certainly do. */
  const WINDOW_MS = 12000;

  /** Ring of recent onset timestamps (ms, playback or performance clock). */
  let onsets = [];

  /**
   * Score how well a set of onsets fits one beat period.
   *
   * @param {number[]} times onset timestamps (ms)
   * @param {number} periodMs candidate beat length
   * @returns {{score: number, phaseMs: number}} score is 0..1
   */
  function fitPeriod(times, periodMs) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < times.length; i += 1) {
      const turns = (times[i] / periodMs) * Math.PI * 2;
      re += Math.cos(turns);
      im += Math.sin(turns);
    }
    const n = times.length || 1;
    const score = Math.sqrt(re * re + im * im) / n;
    // Angle → where in the period the onsets sit, normalised to 0..periodMs.
    let phaseMs = (Math.atan2(im, re) / (Math.PI * 2)) * periodMs;
    if (phaseMs < 0) phaseMs += periodMs;
    return { score, phaseMs };
  }

  /**
   * Estimate tempo from a list of onset times.
   *
   * @param {number[]} times onset timestamps in ms, any order
   * @param {object} [opts]
   * @param {number} [opts.minBpm]
   * @param {number} [opts.maxBpm]
   * @returns {{bpm: number, periodMs: number, confidence: number, phaseMs: number}|null}
   *   null when there is not enough evidence to claim a tempo
   */
  function estimate(times, opts = {}) {
    const list = (times || []).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (list.length < MIN_ONSETS) return null;

    const minBpm = opts.minBpm || MIN_BPM;
    const maxBpm = opts.maxBpm || MAX_BPM;
    const minPeriod = 60000 / maxBpm;
    const maxPeriod = 60000 / minBpm;

    // Work relative to the first onset so the phase is meaningful and the
    // trigonometry stays in a sane numeric range for large clock values.
    const base = list[0];
    const rel = list.map((t) => t - base);

    let best = null;
    for (let p = minPeriod; p <= maxPeriod; p += PERIOD_STEP_MS) {
      const { score, phaseMs } = fitPeriod(rel, p);
      if (!best || score > best.score) best = { score, phaseMs, periodMs: p };
    }
    if (!best) return null;

    /*
      Octave correction. Half and double the winning period describe the same
      onsets equally well, so compare them on score and, when close, take the
      one nearer where tempo perception actually sits. Without this a 128BPM
      house track reads as 64 about as often as not.
    */
    const candidates = [best];
    for (const factor of [0.5, 2]) {
      const p = best.periodMs * factor;
      if (p >= minPeriod && p <= maxPeriod) {
        const alt = fitPeriod(rel, p);
        candidates.push({ score: alt.score, phaseMs: alt.phaseMs, periodMs: p });
      }
    }
    /*
      Tie-break toward the prior when there is one. A full-song measurement is a
      far better statement about where this track's tempo sits than a global
      constant about where music in general sits.
    */
    const target = (opts.prior || priorBpm) || PREFERRED_BPM;

    let chosen = best;
    for (const c of candidates) {
      if (c === best) continue;
      // Accept an octave sibling that is nearly as good but musically likelier.
      const nearlyAsGood = c.score > best.score * 0.85;
      const closer = Math.abs(60000 / c.periodMs - target)
        < Math.abs(60000 / chosen.periodMs - target);
      if (nearlyAsGood && closer) chosen = c;
    }

    /*
      The prior itself is a candidate, and it wins unless the live window fits
      something else dramatically better.

      This is the part that fixes the observed failure. Octave correction only
      considers ×0.5 and ×2, so it cannot rescue a raw winner at ×1.25 of the
      truth — and that is exactly what happened. Scoring the known period
      directly, and requiring a challenger to beat it by PRIOR_OVERRIDE_RATIO,
      turns "confident and wrong" into "confident, wrong, and ignored".
    */
    const prior = opts.prior || priorBpm;
    if (prior) {
      const priorPeriod = 60000 / prior;
      if (priorPeriod >= minPeriod && priorPeriod <= maxPeriod) {
        const disagrees = Math.abs(chosen.periodMs - priorPeriod) / priorPeriod > PRIOR_AGREE;
        if (disagrees) {
          const fit = fitPeriod(rel, priorPeriod);
          if (chosen.score < fit.score * PRIOR_OVERRIDE_RATIO) {
            chosen = { score: fit.score, phaseMs: fit.phaseMs, periodMs: priorPeriod };
          }
        }
      }
    }

    return {
      bpm: 60000 / chosen.periodMs,
      periodMs: chosen.periodMs,
      confidence: chosen.score,
      phaseMs: chosen.phaseMs + base,   // back onto the caller's clock
    };
  }

  /**
   * Record a kick onset.
   * @param {number} timeMs
   */
  function note(timeMs) {
    if (!Number.isFinite(timeMs)) return;
    onsets.push(timeMs);
    const cutoff = timeMs - WINDOW_MS;
    if (onsets.length > 128 || onsets[0] < cutoff) {
      onsets = onsets.filter((t) => t >= cutoff);
    }
  }

  /** Estimate from the onsets recorded so far, or null. */
  function current(opts) {
    return estimate(onsets, opts);
  }

  /**
   * Adopt a tempo measured elsewhere across the whole song.
   *
   * Called by the renderer when local playback's offline analysis finishes.
   * Pass 0 or null to clear it.
   *
   * @param {number} bpm
   */
  function setPrior(bpm) {
    priorBpm = Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : 0;
  }

  /** The prior currently in force, or 0. */
  function prior() {
    return priorBpm;
  }

  /**
   * Where the beats of a KNOWN period fall, from the onsets seen so far.
   *
   * The point of separating this from `estimate` is that a tempo which came
   * from the full song does not need re-deriving every second — but its phase
   * does, because the clock has to stay aligned to the music. This answers
   * "given that the period is P, where is the downbeat" without ever putting
   * the period itself back up for debate.
   *
   * @param {number} periodMs
   * @returns {{phaseMs: number, confidence: number}|null}
   */
  function phaseFor(periodMs) {
    if (!Number.isFinite(periodMs) || periodMs <= 0) return null;
    const list = onsets.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (list.length < MIN_ONSETS) return null;
    const base = list[0];
    const { score, phaseMs } = fitPeriod(list.map((t) => t - base), periodMs);
    return { phaseMs: phaseMs + base, confidence: score };
  }

  /** Forget everything — call on track change. */
  function reset() {
    onsets = [];
    // The prior belongs to a song, so it goes with the song. The renderer sets
    // a new one when the next track's analysis lands.
    priorBpm = 0;
  }

  /** How many onsets are currently held (for diagnostics). */
  function count() {
    return onsets.length;
  }

  window.Tempo = {
    estimate, note, current, reset, count, fitPeriod,
    setPrior, prior, phaseFor,
    MIN_BPM, MAX_BPM, MIN_ONSETS, PREFERRED_BPM,
    PRIOR_OVERRIDE_RATIO, PRIOR_AGREE,
  };
})();
