'use strict';

/**
 * Force-align known lyric text to Whisper's timings.
 *
 * The insight this module exists for: LRCLIB has *plain* (unsynced) lyrics for
 * far more songs than it has synced ones, and Whisper is much better at
 * knowing WHEN someone sang than WHAT they sang. Neither source is good enough
 * alone — plain lyrics have no timing, and a raw transcription mishears words
 * badly on music. Combined they are strong: take the words from the real
 * lyrics and the clock from the transcription.
 *
 * That means a song with plain lyrics gets *correct* scrolling text, not a
 * best-effort transcription, which is a categorically better result than
 * either the transcription alone or nothing at all.
 *
 * Method: Needleman-Wunsch global alignment over the two line sequences,
 * scoring by token-overlap similarity. Global (not local) alignment is the
 * right choice because both sequences cover the same song start to finish and
 * order is guaranteed — a chorus cannot migrate. Lines that fail to match an
 * anchor get their time interpolated between the anchors around them, so a
 * mondegreen in the middle of a verse does not desynchronise everything after
 * it.
 */

const { tokenSimilarity } = require('./lyrics');

/** Below this, two lines are not considered the same line. */
const MATCH_FLOOR = 0.34;

/** Cost of skipping a line on either side. Negative; tuned against MATCH_FLOOR. */
const GAP_PENALTY = -0.45;

/** Fallback spacing when there is nothing to interpolate against. */
const DEFAULT_LINE_MS = 2600;

/**
 * Split a plain-lyrics document into display lines.
 *
 * Blank lines (verse breaks) and bracketed section headers ("[Chorus]",
 * "[Verse 2]") are dropped — they are structure, not something to sing.
 *
 * @param {string} plain Raw plain-lyrics text.
 * @returns {string[]} Non-empty lyric lines in order.
 */
function splitPlainLyrics(plain) {
  if (!plain) return [];
  return plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[[(].*[\])]$/.test(l));
}

/**
 * Align two line sequences with Needleman-Wunsch.
 *
 * @param {string[]} lines Correct lyric lines.
 * @param {Array<{timeMs:number,text:string}>} cues Transcribed cues (timing source).
 * @returns {Array<number|null>} For each line, the index of the cue it matched, or null.
 */
function alignSequences(lines, cues) {
  const n = lines.length;
  const m = cues.length;

  // score[i][j] = best score aligning first i lines with first j cues.
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  // 0 = diagonal (match), 1 = up (line skipped), 2 = left (cue skipped)
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for (let i = 1; i <= n; i += 1) {
    score[i][0] = score[i - 1][0] + GAP_PENALTY;
    back[i][0] = 1;
  }
  for (let j = 1; j <= m; j += 1) {
    score[0][j] = score[0][j - 1] + GAP_PENALTY;
    back[0][j] = 2;
  }

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = tokenSimilarity(lines[i - 1], cues[j - 1].text);
      // Centre the similarity on the match floor so a weak pairing scores
      // negative and the aligner prefers a gap over a bad match.
      const diag = score[i - 1][j - 1] + (sim - MATCH_FLOOR);
      const up = score[i - 1][j] + GAP_PENALTY;
      const left = score[i][j - 1] + GAP_PENALTY;

      let best = diag;
      let dir = 0;
      if (up > best) { best = up; dir = 1; }
      if (left > best) { best = left; dir = 2; }
      score[i][j] = best;
      back[i][j] = dir;
    }
  }

  const matches = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const dir = back[i][j];
    if (dir === 0) {
      // Only accept the pairing as an anchor if it is genuinely similar.
      if (tokenSimilarity(lines[i - 1], cues[j - 1].text) >= MATCH_FLOOR) {
        matches[i - 1] = j - 1;
      }
      i -= 1; j -= 1;
    } else if (dir === 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return matches;
}

/**
 * Produce synced cues from correct lyric lines plus transcribed timings.
 *
 * @param {string[]} lines Correct lyric lines, in order.
 * @param {Array<{timeMs:number,text:string}>} cues Transcribed cues, ascending.
 * @param {object} [options]
 * @param {number} [options.durationMs] Track length, used to spread trailing lines.
 * @returns {{cues: Array<{timeMs:number,text:string}>, anchors: number, coverage: number}}
 *   `anchors` is how many lines matched a transcribed cue directly; `coverage`
 *   is that as a fraction. Low coverage means the alignment is mostly guesswork
 *   and the caller should prefer the raw transcription.
 */
function alignLyrics(lines, cues, options = {}) {
  const clean = (lines || []).filter((l) => l && l.trim());
  if (clean.length === 0) return { cues: [], anchors: 0, coverage: 0 };
  if (!Array.isArray(cues) || cues.length === 0) {
    return { cues: [], anchors: 0, coverage: 0 };
  }

  const matches = alignSequences(clean, cues);
  const anchors = matches.filter((x) => x !== null).length;

  // Anchored lines take their matched cue's time; the rest are interpolated
  // between the nearest anchors on each side.
  const times = new Array(clean.length).fill(null);
  for (let i = 0; i < clean.length; i += 1) {
    if (matches[i] !== null) times[i] = cues[matches[i]].timeMs;
  }

  const firstAnchor = times.findIndex((t) => t !== null);
  if (firstAnchor === -1) {
    // Nothing matched: spread evenly across the track as a last resort.
    const span = options.durationMs && options.durationMs > 0
      ? options.durationMs
      : clean.length * DEFAULT_LINE_MS;
    const step = span / (clean.length + 1);
    return {
      cues: clean.map((text, i) => ({ timeMs: Math.round(step * (i + 1)), text })),
      anchors: 0,
      coverage: 0,
    };
  }

  // Lead-in: work backwards from the first anchor.
  for (let i = firstAnchor - 1; i >= 0; i -= 1) {
    times[i] = Math.max(0, times[i + 1] - DEFAULT_LINE_MS);
  }

  // Middle + tail.
  for (let i = firstAnchor + 1; i < clean.length; i += 1) {
    if (times[i] !== null) continue;
    const prevTime = times[i - 1];
    // Find the next anchored line to interpolate toward.
    let next = -1;
    for (let k = i + 1; k < clean.length; k += 1) {
      if (times[k] !== null) { next = k; break; }
    }
    if (next === -1) {
      const end = options.durationMs && options.durationMs > prevTime
        ? options.durationMs
        : prevTime + (clean.length - i) * DEFAULT_LINE_MS;
      const step = (end - prevTime) / (clean.length - i + 1);
      for (let k = i; k < clean.length; k += 1) times[k] = Math.round(prevTime + step * (k - i + 1));
      break;
    }
    const step = (times[next] - prevTime) / (next - i + 1);
    for (let k = i; k < next; k += 1) times[k] = Math.round(prevTime + step * (k - i + 1));
  }

  // Enforce strictly increasing times; equal stamps would make findCueIndex
  // skip a line entirely.
  const out = [];
  let last = -1;
  for (let i = 0; i < clean.length; i += 1) {
    let t = Math.max(0, Math.round(times[i]));
    if (t <= last) t = last + 1;
    last = t;
    out.push({ timeMs: t, text: clean[i] });
  }

  return { cues: out, anchors, coverage: anchors / clean.length };
}

module.exports = { alignLyrics, splitPlainLyrics, alignSequences, MATCH_FLOOR };
