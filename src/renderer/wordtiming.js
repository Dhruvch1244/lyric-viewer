'use strict';

/*
  Per-word timing for a lyric line.

  No lyric source we can reach carries word-level timing. LRCLIB's "enhanced
  LRC" extension (`<00:14.15>word`) would, but a survey of 153 synced entries
  across 8 songs found ZERO using it — every entry is line-level only. So word
  timing has to be estimated from the line's text and its start/end.

  The estimate used to divide the line by CHARACTER COUNT, which mis-weights
  badly: "strength" is eight characters and one syllable, "area" is four
  characters and three. Sung duration tracks syllables, not letters, so that
  handed long-but-quick words far too much of the line and clipped short-but-
  slow ones.

  Counting syllables instead is both more accurate and, for this app, tractable
  in the two script families it actually has to serve:

    - Indic scripts (Devanagari, Gurmukhi): a syllable IS an akshara, and an
      akshara is one base letter plus its combining marks. Unicode already
      separates those categories, so counting base letters and subtracting
      viramas (which fuse two consonants into one syllable) is close to exact —
      considerably better than anything available for English.
    - Latin: count vowel groups. Rough, but it is the standard approach and it
      is a large improvement on character count.

  Exposed on window.WordTiming.
*/

(function () {
  /**
   * Cap on how far a line's words may be spread.
   *
   * A line held over a long instrumental would otherwise stretch its last word
   * across the whole gap, leaving it "mid-sung" for several seconds.
   */
  const MAX_SPREAD_MS = 8000;

  /**
   * Floor on a single word's share, as a fraction of an even split. Without it
   * a one-syllable word next to a long one gets so little time that its
   * highlight is never actually visible at 60fps.
   */
  const MIN_SHARE = 0.35;

  /** Devanagari + Gurmukhi virama (halant): fuses two consonants into one syllable. */
  const VIRAMA_RE = /[्੍]/gu;
  const INDIC_RE = /[\p{Script=Devanagari}\p{Script=Gurmukhi}]/u;

  /**
   * Estimated syllable count for one word. Always at least 1.
   *
   * @param {string} word
   * @returns {number}
   */
  function syllables(word) {
    // Strip punctuation but KEEP combining marks (\p{M}) — the virama counted
    // below is one, so removing them first would leave nothing to subtract.
    const clean = String(word || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}']/gu, '');
    if (!clean) return 1;

    if (INDIC_RE.test(clean)) {
      // \p{L} matches base letters only — matras and nuktas are combining marks
      // (category Mn) and are excluded, which is exactly the akshara count.
      const base = (clean.match(/\p{L}/gu) || []).length;
      const fused = (clean.match(VIRAMA_RE) || []).length;
      return Math.max(1, base - fused);
    }

    /*
      Vowel groups. Deliberately NO silent-'e' correction: it is an English
      rule, and this app's core repertoire is romanized Hindi and Punjabi where
      a trailing 'e' is virtually always pronounced ("jale", "dukhe", "bane",
      "toote" are all two syllables). Applying it would undercount every one of
      them to buy a small gain on English words like "make".

      These weights are only ever used RELATIVE to the other words on the same
      line, so a consistent slight over-count on one language costs far less
      than a systematic under-count on the other.
    */
    const groups = clean.match(/[aeiouy]+/g) || [];
    return Math.max(1, groups.length);
  }

  /**
   * Split a line into words with estimated start/end times.
   *
   * @param {string} text line text
   * @param {number} startMs when the line begins
   * @param {number} endMs when the line stops being sung
   * @returns {Array<{word: string, startMs: number, endMs: number}>}
   */
  function build(text, startMs, endMs) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const span = Math.max(0, Math.min(endMs - startMs, MAX_SPREAD_MS));

    // Weight per word, floored so no word can be starved into invisibility.
    const raw = words.map(syllables);
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
    const floor = mean * MIN_SHARE;
    const weights = raw.map((n) => Math.max(n, floor));
    const total = weights.reduce((a, b) => a + b, 0) || words.length;

    let cursor = startMs;
    return words.map((word, i) => {
      const share = (weights[i] / total) * span;
      const timing = { word, startMs: cursor, endMs: cursor + share };
      cursor += share;
      return timing;
    });
  }

  window.WordTiming = { build, syllables, MAX_SPREAD_MS, MIN_SHARE };
})();
