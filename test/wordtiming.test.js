'use strict';

/*
  Unit tests for per-word lyric timing (src/renderer/wordtiming.js).

  Like beatmap.js and sprites.js this is a browser IIFE attaching to `window`,
  and it touches nothing but `window`, so a bare stub is enough to require it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/wordtiming.js');
const { build, syllables } = global.window.WordTiming;

/* ------------------------------------------------------------- syllables */

test('syllables counts English vowel groups', () => {
  assert.equal(syllables('a'), 1);
  assert.equal(syllables('the'), 1);
  assert.equal(syllables('blinded'), 2);
  assert.equal(syllables('beautiful'), 3);   // beau-ti-ful
});

test('syllables does not let long consonant clusters inflate the count', () => {
  // The whole point of the change: 8 characters, 1 syllable.
  assert.equal(syllables('strength'), 1);
  assert.equal(syllables('through'), 1);
  // ...while a short word with many vowels is correctly worth more.
  assert.equal(syllables('area') > syllables('strength'), true);
});

test('syllables keeps the pronounced trailing -e of romanized Hindi', () => {
  // No English silent-e rule: these are all two syllables when sung.
  for (const word of ['jale', 'dukhe', 'bane', 'toote']) {
    assert.equal(syllables(word), 2, `${word} should be 2`);
  }
});

test('syllables counts Devanagari aksharas, not code points', () => {
  assert.equal(syllables('नमस्ते'), 3);   // na-mas-te, virama fuses स्+त
  assert.equal(syllables('दिल'), 2);      // di-l  (matras are combining marks)
});

test('syllables counts Gurmukhi aksharas', () => {
  assert.equal(syllables('ਪੰਜਾਬੀ') >= 3, true);
});

test('syllables ignores punctuation and never returns zero', () => {
  assert.equal(syllables('...'), 1);
  assert.equal(syllables(''), 1);
  assert.equal(syllables('(yeah)'), 1);
  assert.equal(syllables(null), 1);
});

/* ----------------------------------------------------------------- build */

test('build spans exactly the line and stays contiguous', () => {
  const t = build('one two three', 1000, 4000);
  assert.equal(t.length, 3);
  assert.equal(t[0].startMs, 1000);
  assert.equal(Math.round(t[2].endMs), 4000);
  for (let i = 1; i < t.length; i += 1) {
    assert.equal(t[i].startMs, t[i - 1].endMs, 'no gaps between words');
  }
});

test('build gives a multi-syllable word more time than a long one-syllable word', () => {
  const t = build('strength beautiful', 0, 5000);
  const strength = t[0].endMs - t[0].startMs;
  const beautiful = t[1].endMs - t[1].startMs;
  assert.equal(beautiful > strength, true,
    'four syllables should outlast one, despite fewer characters');
});

test('build never starves a short word below the minimum share', () => {
  const t = build('I extraordinarily', 0, 4000);
  const short = t[0].endMs - t[0].startMs;
  // An even split would be 2000ms; the floor is 35% of the mean weight, so the
  // short word must still get a clearly visible slice.
  assert.equal(short > 200, true, `short word got only ${short}ms`);
});

test('build caps the spread so a held line does not smear its last word', () => {
  const t = build('one two', 0, 60000);
  assert.equal(t[t.length - 1].endMs <= 8000, true);
});

test('build tolerates empty and whitespace-only input', () => {
  assert.deepEqual(build('', 0, 1000), []);
  assert.deepEqual(build('   ', 0, 1000), []);
  assert.deepEqual(build(null, 0, 1000), []);
});

test('build handles a zero-length or inverted line without negative durations', () => {
  for (const t of [build('a b', 500, 500), build('a b', 900, 100)]) {
    for (const w of t) assert.equal(w.endMs >= w.startMs, true);
  }
});
