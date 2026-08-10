'use strict';

/**
 * Vocal-activity gating for transcribed lyrics.
 *
 * Whisper's worst failure on music is inventing words over passages that have
 * no singing in them — intros, breakdowns, outros and long instrumental gaps.
 * It does not stay quiet; it emits plausible-looking filler, often the same
 * phrase on a loop, and those lines then scroll past on screen as if they were
 * real lyrics.
 *
 * The model gives us no confidence signal to filter on (transformers.js does
 * not implement Whisper's `no_speech_threshold` / `logprob_threshold`), so the
 * check has to come from the audio itself. This module measures how much energy
 * sits in the vocal band over time and lets the caller drop cues that landed
 * where nobody was singing.
 *
 * Method — deliberately cheap, since this runs over whole songs:
 *   1. Band-pass roughly 250 Hz – 4 kHz with two one-pole filters. That is
 *      where sung vowels live; it discards sub-bass and kick (below) and hats
 *      and cymbals (above), which is most of what an instrumental section is.
 *   2. Take RMS per 20 ms frame to get a band envelope.
 *   3. Threshold each frame against the track's own statistics, so a quiet
 *      ballad and a loud club track are judged on their own terms.
 *
 * HONEST LIMIT: this is an energy gate, not source separation. A dense synth
 * or guitar passage puts real energy in the vocal band and will read as
 * "possible vocals". So it reliably removes hallucinations over silence,
 * sparse intros and stripped breakdowns, and does NOT reliably remove them
 * over a wall of mid-range synths. Actually solving that needs vocal isolation
 * (Demucs or similar) — see NEXT_STEPS.md. The gate is therefore deliberately
 * conservative: when in doubt it keeps the line, because deleting a real lyric
 * is worse than leaving a questionable one.
 */

/** Envelope resolution. 20 ms is well below syllable rate, so onsets survive. */
const FRAME_MS = 20;

/** Vocal band edges in Hz. */
const HIGH_PASS_HZ = 250;
const LOW_PASS_HZ = 4000;

/**
 * Fraction of the track's median band energy below which a frame counts as
 * having no vocal. Low on purpose — see the conservative note above.
 */
const SILENCE_RATIO = 0.22;

/**
 * A cue survives if at least this fraction of its window looks voiced. Set low
 * so a line that starts slightly early, or has a pause in it, is still kept.
 */
const MIN_VOICED_FRACTION = 0.18;

/**
 * One-pole filter coefficient for a given cutoff.
 * @param {number} cutoffHz
 * @param {number} sampleRate
 * @returns {number} smoothing coefficient in (0,1)
 */
function poleCoeff(cutoffHz, sampleRate) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  return rc / (rc + dt);
}

/**
 * Band-limited RMS envelope of a mono signal.
 *
 * @param {Float32Array} pcm mono samples in -1..1
 * @param {number} sampleRate
 * @returns {Float32Array} one RMS value per FRAME_MS frame
 */
function bandEnvelope(pcm, sampleRate) {
  const frameLen = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frames = Math.floor(pcm.length / frameLen);
  const env = new Float32Array(frames);

  const aHp = poleCoeff(HIGH_PASS_HZ, sampleRate);
  const aLp = 1 - poleCoeff(LOW_PASS_HZ, sampleRate);

  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let lpPrev = 0;

  for (let f = 0; f < frames; f += 1) {
    const start = f * frameLen;
    let sumSq = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = pcm[start + i];
      // One-pole high-pass, then one-pole low-pass: a crude band-pass.
      const hp = aHp * (hpPrevOut + x - hpPrevIn);
      hpPrevIn = x;
      hpPrevOut = hp;
      lpPrev += aLp * (hp - lpPrev);
      sumSq += lpPrev * lpPrev;
    }
    env[f] = Math.sqrt(sumSq / frameLen);
  }
  return env;
}

/**
 * Median of a Float32Array, computed on a copy.
 * @param {Float32Array} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-frame voiced/unvoiced mask for a track.
 *
 * @param {Float32Array} pcm mono samples
 * @param {number} [sampleRate=16000]
 * @returns {{frameMs: number, mask: Uint8Array, voicedFraction: number}}
 */
function vocalMask(pcm, sampleRate = 16000) {
  const env = bandEnvelope(pcm, sampleRate);
  const mask = new Uint8Array(env.length);
  if (env.length === 0) return { frameMs: FRAME_MS, mask, voicedFraction: 0 };

  // Judge each frame against the track's own loudness, so quiet and loud
  // productions are treated alike.
  const threshold = median(env) * SILENCE_RATIO;

  let voiced = 0;
  for (let i = 0; i < env.length; i += 1) {
    const isVoiced = env[i] > threshold ? 1 : 0;
    mask[i] = isVoiced;
    voiced += isVoiced;
  }
  return { frameMs: FRAME_MS, mask, voicedFraction: voiced / env.length };
}

/**
 * Drop cues that fall where the track has no vocal-band activity.
 *
 * Each cue is judged over its own on-screen window (its start until the next
 * cue starts, capped at MAX_WINDOW_MS so a final line does not swallow the
 * whole outro).
 *
 * @param {Array<{timeMs: number, text: string}>} cues ascending by time
 * @param {{frameMs: number, mask: Uint8Array}} activity from vocalMask()
 * @returns {Array<{timeMs: number, text: string}>} surviving cues
 */
function filterCuesByVocalActivity(cues, activity) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  if (!activity || !activity.mask || activity.mask.length === 0) return cues;

  const { frameMs, mask } = activity;
  const MAX_WINDOW_MS = 6000;

  return cues.filter((cue, index) => {
    const next = cues[index + 1];
    const endMs = Math.min(
      next ? next.timeMs : cue.timeMs + MAX_WINDOW_MS,
      cue.timeMs + MAX_WINDOW_MS
    );

    const from = Math.max(0, Math.floor(cue.timeMs / frameMs));
    const to = Math.min(mask.length, Math.ceil(endMs / frameMs));
    if (to <= from) return true; // window off the end of the audio; keep it

    let voiced = 0;
    for (let i = from; i < to; i += 1) voiced += mask[i];
    return voiced / (to - from) >= MIN_VOICED_FRACTION;
  });
}

module.exports = {
  vocalMask,
  filterCuesByVocalActivity,
  bandEnvelope,
  FRAME_MS,
  SILENCE_RATIO,
  MIN_VOICED_FRACTION,
};
