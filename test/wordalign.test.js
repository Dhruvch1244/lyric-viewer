'use strict';

/*
  Unit tests for word-level sync (src/main/wordalign.js).

  The interesting cases are all the ways the two sources DISAGREE — Whisper
  mishears, invents ad-libs, skips lines, and emits zero-length spans — because
  the whole value of the module is that a bad word does not desynchronise the
  rest of the song.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachWordTimings, wordSimilarity, normWord, tidyLine, MIN_WORD_MS,
} = require('../src/main/wordalign');

/** Build a transcribed word list from "word@start-end" shorthand. */
function heard(...specs) {
  return specs.map((s) => {
    const [text, range] = s.split('@');
    const [a, b] = range.split('-').map(Number);
    return { text, startMs: a, endMs: b };
  });
}

/* ------------------------------------------------------------- primitives */

test('normWord strips case, punctuation and diacritics', () => {
  assert.equal(normWord('Mind?'), 'mind');
  assert.equal(normWord("don't"), 'dont');
  assert.equal(normWord('café'), 'cafe');
  assert.equal(normWord('—'), '');
});

test('wordSimilarity scores exact, near and unrelated words apart', () => {
  assert.equal(wordSimilarity('mind', 'mind'), 1);
  assert.ok(wordSimilarity('jhooke', 'jhuke') > 0.4, 'near-miss should score partial');
  assert.ok(wordSimilarity('mind', 'ocean') < 0.3, 'unrelated should score low');
});

test('wordSimilarity refuses to guess on very short words', () => {
  // Bigrams are meaningless below 3 characters and would call these a match.
  assert.equal(wordSimilarity('a', 'i'), 0);
  assert.equal(wordSimilarity('to', 'so'), 0);
});

/* ---------------------------------------------------------------- happy path */

test('attachWordTimings puts measured times on a perfectly heard line', () => {
  const cues = [{ timeMs: 1000, text: 'you say do i', endMs: 3000 }];
  const r = attachWordTimings(cues, heard('you@1000-1400', 'say@1400-1700', 'do@1700-1900', 'i@1900-2200'));
  assert.equal(r.coverage, 1);
  const w = r.cues[0].words;
  assert.deepEqual(w.map((x) => x.word), ['you', 'say', 'do', 'i']);
  assert.equal(w[0].startMs, 1000);
  assert.equal(w[1].startMs, 1400);
});

test('attachWordTimings keeps the LYRIC spelling, not what was heard', () => {
  // The entire point: correct words, measured timing.
  const cues = [{ timeMs: 0, text: 'sabhi jhuke aur', endMs: 2000 }];
  const r = attachWordTimings(cues, heard('sabhi@0-500', 'jhooke@500-1200', 'aur@1200-1800'));
  assert.deepEqual(r.cues[0].words.map((w) => w.word), ['sabhi', 'jhuke', 'aur']);
  assert.equal(r.cues[0].words[1].startMs, 500, 'near-miss should still anchor');
});

/* ------------------------------------------------------------- disagreement */

test('an unmatched word is interpolated between its neighbours', () => {
  const cues = [{ timeMs: 0, text: 'one mystery three', endMs: 3000 }];
  // Whisper missed the middle word entirely.
  const r = attachWordTimings(cues, heard('one@0-500', 'three@2000-2500'));
  const w = r.cues[0].words;
  assert.equal(w.length, 3);
  assert.ok(w[1].startMs >= w[0].endMs, 'must start after the word before it');
  assert.ok(w[1].endMs <= w[2].startMs + 1, 'must end by the word after it');
});

test('a mondegreen does not desynchronise the words after it', () => {
  const cues = [{ timeMs: 0, text: 'cross your mind tonight', endMs: 4000 }];
  const r = attachWordTimings(cues, heard('cross@0-400', 'xylophone@400-900', 'mind@900-1400', 'tonight@1400-2000'));
  const w = r.cues[0].words;
  // "your" fails to match, but "mind" and "tonight" must keep their real times.
  assert.equal(w[2].startMs, 900);
  assert.equal(w[3].startMs, 1400);
});

test('words never leak outside their own line', () => {
  const cues = [
    { timeMs: 0, text: 'first line here', endMs: 2000 },
    { timeMs: 5000, text: 'second line here', endMs: 7000 },
  ];
  // Deliberately absurd timings that would drag line 1 into line 2's territory.
  const r = attachWordTimings(cues, heard('first@0-100', 'line@6000-6500', 'here@6500-9000',
    'second@5000-5500', 'line@5500-6000', 'here@6000-6800'));
  for (const w of r.cues[0].words) {
    assert.ok(w.endMs <= 2000 + 1, `word ran past its line: ${JSON.stringify(w)}`);
  }
  for (const w of r.cues[1].words) {
    assert.ok(w.startMs >= 5000 - 1, `word started before its line: ${JSON.stringify(w)}`);
  }
});

test('coverage reports how much actually anchored', () => {
  const cues = [{ timeMs: 0, text: 'alpha beta gamma delta', endMs: 4000 }];
  const r = attachWordTimings(cues, heard('alpha@0-500', 'beta@500-1000'));
  assert.equal(r.coverage, 0.5);
  // A caller can use this to reject an alignment and keep the estimate instead.
  const none = attachWordTimings(cues, heard('zzz@0-100', 'qqq@100-200'));
  assert.ok(none.coverage < 0.3);
});

/* ------------------------------------------------------------------ repair */

test('degenerate zero-length spans from Whisper are repaired', () => {
  // Observed for real: "cross" came back as [5.00, 5.00].
  const cues = [{ timeMs: 0, text: 'ever cross your', endMs: 3000 }];
  const r = attachWordTimings(cues, heard('ever@0-500', 'cross@500-500', 'your@600-1200'));
  for (const w of r.cues[0].words) {
    assert.ok(w.endMs - w.startMs >= MIN_WORD_MS, `zero-length span survived: ${JSON.stringify(w)}`);
  }
});

test('tidyLine keeps words ordered and non-overlapping', () => {
  const words = [
    { word: 'a', startMs: 500, endMs: 400 },   // inverted
    { word: 'b', startMs: 300, endMs: 900 },   // starts before the one before it
    { word: 'c', startMs: 1000, endMs: 1000 }, // zero length
  ];
  tidyLine(words, 0, 3000);
  for (let i = 0; i < words.length; i += 1) {
    assert.ok(words[i].endMs > words[i].startMs, `word ${i} not positive`);
    if (i > 0) assert.ok(words[i].startMs >= words[i - 1].endMs, `word ${i} overlaps`);
  }
});

/* ------------------------------------------------------------------- junk */

test('attachWordTimings passes cues through untouched when there is nothing to align', () => {
  const cues = [{ timeMs: 0, text: 'hello', endMs: 1000 }];
  assert.equal(attachWordTimings(cues, []).cues, cues);
  assert.equal(attachWordTimings(cues, null).cues, cues);
  assert.deepEqual(attachWordTimings([], heard('a@0-1')).cues, []);
  assert.deepEqual(attachWordTimings(null, heard('a@0-1')).cues, []);
});
