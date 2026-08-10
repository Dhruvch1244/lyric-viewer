'use strict';

/**
 * Word-level sync: correct words from the lyric source, measured timing from
 * Whisper.
 *
 * Neither source is usable alone. LRCLIB has the right WORDS but only line-level
 * timing — a survey of 153 synced entries found zero using the enhanced-LRC
 * word extension, so there is no word timing to be had there at any price.
 * Whisper measures WHEN each word was sung to within a few tens of ms, but
 * mishears the words badly over music. Combining them gives correct text on
 * measured timing, which is what karaoke-grade sync actually is.
 *
 * This is the same insight align.js already uses to put plain lyrics on
 * transcribed timing, moved down a level: there it aligns line sequences, here
 * it aligns word sequences.
 *
 * METHOD. Flatten the lyric lines into one word sequence, align it against
 * Whisper's word sequence with Needleman-Wunsch, and give every word that
 * matched its Whisper timestamp. Words that did not match — a mondegreen, an
 * ad-lib Whisper invented, a line it skipped — are interpolated between the
 * anchors on either side, so one bad word cannot desynchronise the rest.
 *
 * Global alignment (not local) is correct here for the same reason as in
 * align.js: both sequences cover the same song start to finish and order is
 * guaranteed. A chorus cannot migrate.
 *
 * Every result is then clamped inside its own line's bounds. That containment
 * matters more than the alignment being perfect: a word may be mistimed within
 * its line, but it can never drift into a neighbouring line, so the display
 * degrades to "roughly right inside the correct line" rather than to nonsense.
 */

/**
 * Below this two words are not the same word.
 *
 * Calibrated against what bigram overlap actually returns for the near-misses
 * Whisper produces on music, not against intuition: "jhooke"/"jhuke" — clearly
 * the same sung word — scores 0.44, because short words share few bigrams. A
 * floor of 0.62 looked reasonable and rejected exactly the cases this module
 * exists to catch. Unrelated pairs still score near zero ("mind"/"ocean" is 0),
 * so there is plenty of room below this.
 */
const MATCH_FLOOR = 0.42;

/** Cost of skipping a word on either side. Negative; tuned against MATCH_FLOOR. */
const GAP_PENALTY = -0.55;

/** A word must occupy at least this long, so its highlight is visible. */
const MIN_WORD_MS = 90;

/**
 * Normalise a word for comparison: lowercase, strip punctuation and diacritics.
 * @param {string} word
 * @returns {string}
 */
function normWord(word) {
  return String(word || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Similarity of two normalised words, 0..1.
 *
 * Exact match scores 1. Anything else falls back to character-bigram overlap,
 * which gives partial credit for the near-misses Whisper actually produces on
 * music ("dard" for "dart", "jhooke" for "jhuke") without accepting two
 * unrelated words.
 *
 * @param {string} a normalised
 * @param {string} b normalised
 * @returns {number}
 */
function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Very short words are all-or-nothing; bigrams are meaningless below 3 chars
  // and would happily call "a" and "I" a 50% match.
  if (a.length < 3 || b.length < 3) return 0;

  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * shared) / total : 0;
}

/**
 * Needleman-Wunsch over two word sequences.
 *
 * @param {string[]} want normalised lyric words
 * @param {string[]} heard normalised transcribed words
 * @returns {Array<number|null>} for each lyric word, the index of the heard
 *   word it matched, or null
 */
function alignWordSequences(want, heard) {
  const n = want.length;
  const m = heard.length;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for (let i = 1; i <= n; i += 1) { score[i][0] = score[i - 1][0] + GAP_PENALTY; back[i][0] = 1; }
  for (let j = 1; j <= m; j += 1) { score[0][j] = score[0][j - 1] + GAP_PENALTY; back[0][j] = 2; }

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      // Centre on the match floor so a weak pairing scores negative and the
      // aligner prefers a gap to a bad match.
      const diag = score[i - 1][j - 1] + (wordSimilarity(want[i - 1], heard[j - 1]) - MATCH_FLOOR);
      const up = score[i - 1][j] + GAP_PENALTY;
      const left = score[i][j - 1] + GAP_PENALTY;
      let best = diag; let dir = 0;
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
      if (wordSimilarity(want[i - 1], heard[j - 1]) >= MATCH_FLOOR) matches[i - 1] = j - 1;
      i -= 1; j -= 1;
    } else if (dir === 1) { i -= 1; } else { j -= 1; }
  }
  return matches;
}

/**
 * Force every word's span to be ordered, non-degenerate and inside the line.
 *
 * Whisper emits zero-length spans of its own accord — `"cross" [5.00, 5.00]`
 * was in the very first sample taken from it — and interpolation can produce
 * more. A zero-length span means a word that is never highlighted, so they are
 * repaired rather than passed on.
 *
 * @param {Array<{word: string, startMs: number, endMs: number}>} words
 * @param {number} lineStart
 * @param {number} lineEnd
 */
function tidyLine(words, lineStart, lineEnd) {
  const n = words.length;
  if (n === 0) return words;

  const span = Math.max(lineEnd - lineStart, n * MIN_WORD_MS);
  let cursor = lineStart;

  for (let i = 0; i < n; i += 1) {
    const w = words[i];
    // Never before the line, never before the previous word.
    w.startMs = Math.max(cursor, Math.min(w.startMs, lineStart + span));
    // Leave room for the words still to come AND for this one — reserving only
    // for the others let the last word start exactly on the line's end and then
    // run MIN_WORD_MS past it.
    const remaining = n - i - 1;
    const latest = lineStart + span - (remaining + 1) * MIN_WORD_MS;
    w.startMs = Math.min(w.startMs, Math.max(cursor, latest));
    w.endMs = Math.max(w.startMs + MIN_WORD_MS, Math.min(w.endMs, lineStart + span));
    cursor = w.endMs;
  }
  /*
    Containment backstop.

    The forward pass can still overflow: if the measured times place the early
    words late in the line, the ones after them are pushed past its end, each
    needing its own minimum. Seen on real output — a line declared as ending at
    32.0s had measured words still arriving at 32.18s, because the line's stated
    end and the audio genuinely disagree.

    When that happens the measurements and the line bounds cannot both be
    honoured, and the bounds win: a word shown against the wrong LINE is a
    visible error, whereas a word slightly mistimed within the right line is
    not. Falling back to an even split for that line keeps it contained and
    readable. `span` is defined to always leave room for one, so this cannot
    fail in turn.
  */
  if (cursor > lineStart + span + 1) {
    const each = span / n;
    for (let i = 0; i < n; i += 1) {
      words[i].startMs = Math.round(lineStart + each * i);
      words[i].endMs = Math.round(lineStart + each * (i + 1));
    }
    return words;
  }

  // Otherwise the last word runs to the end of the line rather than stopping
  // short — but never past it.
  const last = words[n - 1];
  last.endMs = Math.min(Math.max(last.endMs, Math.min(lineEnd, lineStart + span)), lineStart + span);
  return words;
}

/**
 * Attach measured word timings to a cue list.
 *
 * @param {Array<{timeMs: number, text: string, endMs?: number}>} cues correct lyrics
 * @param {Array<{text: string, startMs: number, endMs: number}>} heard transcribed words
 * @returns {{cues: Array, anchors: number, coverage: number}} cues gain a
 *   `words` array; `coverage` is the fraction of lyric words that matched a
 *   transcribed one, so the caller can reject a weak alignment.
 */
function attachWordTimings(cues, heard) {
  if (!Array.isArray(cues) || cues.length === 0) return { cues: cues || [], anchors: 0, coverage: 0 };
  if (!Array.isArray(heard) || heard.length === 0) return { cues, anchors: 0, coverage: 0 };

  // Flatten to a word sequence, remembering which line each word came from.
  const tokens = [];
  cues.forEach((cue, lineIndex) => {
    const parts = String(cue.text || '').split(/\s+/).filter(Boolean);
    parts.forEach((raw) => tokens.push({ lineIndex, raw, norm: normWord(raw) }));
  });
  if (tokens.length === 0) return { cues, anchors: 0, coverage: 0 };

  const heardNorm = heard.map((h) => normWord(h.text));
  const matches = alignWordSequences(tokens.map((t) => t.norm), heardNorm);

  // Anchored words take the measured time; the rest stay null for now.
  const starts = new Array(tokens.length).fill(null);
  const ends = new Array(tokens.length).fill(null);
  let anchors = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const j = matches[i];
    if (j === null || !heard[j]) continue;
    starts[i] = heard[j].startMs;
    ends[i] = heard[j].endMs;
    anchors += 1;
  }

  // Interpolate the unmatched runs between their surrounding anchors, falling
  // back to the line's own bounds at the very start and end of the song.
  for (let i = 0; i < tokens.length; i += 1) {
    if (starts[i] !== null) continue;
    let prev = i - 1;
    while (prev >= 0 && starts[prev] === null) prev -= 1;
    let next = i + 1;
    while (next < tokens.length && starts[next] === null) next += 1;

    const line = cues[tokens[i].lineIndex];
    const lineStart = line.timeMs;
    const lineEnd = Number.isFinite(line.endMs) && line.endMs > line.timeMs
      ? line.endMs
      : lineStart + 3000;

    const from = prev >= 0 ? ends[prev] : lineStart;
    const to = next < tokens.length ? starts[next] : lineEnd;
    const gapCount = (next < tokens.length ? next : tokens.length) - (prev >= 0 ? prev + 1 : 0);
    const step = gapCount > 0 ? (to - from) / gapCount : MIN_WORD_MS;
    const slot = i - (prev >= 0 ? prev + 1 : 0);
    starts[i] = from + step * slot;
    ends[i] = from + step * (slot + 1);
  }

  // Regroup per line and tidy.
  const perLine = cues.map(() => []);
  tokens.forEach((t, i) => {
    perLine[t.lineIndex].push({ word: t.raw, startMs: Math.round(starts[i]), endMs: Math.round(ends[i]) });
  });

  const out = cues.map((cue, lineIndex) => {
    const words = perLine[lineIndex];
    if (words.length === 0) return cue;
    const lineEnd = Number.isFinite(cue.endMs) && cue.endMs > cue.timeMs
      ? cue.endMs
      : (cues[lineIndex + 1] ? cues[lineIndex + 1].timeMs : cue.timeMs + 3000);
    return { ...cue, words: tidyLine(words, cue.timeMs, lineEnd) };
  });

  return { cues: out, anchors, coverage: anchors / tokens.length };
}

module.exports = {
  attachWordTimings, alignWordSequences, wordSimilarity, normWord, tidyLine,
  MATCH_FLOOR, MIN_WORD_MS,
};
