'use strict';

/*
  Unit tests for LLM transcript correction (src/main/correct.js).

  The network call is not the interesting part. `mergeCorrections` is: it is the
  gate between a language model's free-text output and the cue list the app
  scrolls against, and every rule in it exists because breaking it corrupts a
  song rather than merely failing to improve it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeCorrections } = require('../src/main/correct');

/** @returns {Array<{timeMs: number, text: string}>} */
function cues(...texts) {
  return texts.map((text, i) => ({ timeMs: i * 1000, text }));
}

test('corrected text replaces the original', () => {
  const { cues: out, changed } = mergeCorrections(
    cues('sweet dreams are made of cheese'),
    ['sweet dreams are made of this']
  );
  assert.equal(out[0].text, 'sweet dreams are made of this');
  assert.equal(changed, 1);
});

test('timings are never touched', () => {
  // Whisper's timings are the load-bearing part of a transcript; the model is
  // only ever allowed to change words.
  const input = cues('a', 'b', 'c');
  const { cues: out } = mergeCorrections(input, ['x', 'y', 'z']);
  assert.deepEqual(out.map((c) => c.timeMs), [0, 1000, 2000]);
});

test('a line count mismatch rejects the whole batch', () => {
  // A model that merged two lines has shifted every timing after it. An
  // uncorrected transcript is much better than a misaligned one.
  assert.throws(() => mergeCorrections(cues('a', 'b', 'c'), ['a', 'b']), /mismatch/i);
  assert.throws(() => mergeCorrections(cues('a', 'b'), ['a', 'b', 'c']), /mismatch/i);
  assert.throws(() => mergeCorrections(cues('a'), null), /mismatch/i);
  assert.throws(() => mergeCorrections(cues('a'), 'a'), /mismatch/i);
});

test('a blank correction never deletes a lyric', () => {
  const { cues: out, changed } = mergeCorrections(cues('real words here'), ['   ']);
  assert.equal(out[0].text, 'real words here');
  assert.equal(changed, 0);
});

test('unchanged lines are reported as unchanged', () => {
  // `changed` decides whether the corrected transcript is adopted at all, so a
  // no-op pass must not claim to have done something.
  const { cues: out, changed } = mergeCorrections(cues('same', 'same too'), ['same', 'same too']);
  assert.equal(changed, 0);
  assert.deepEqual(out.map((c) => c.text), ['same', 'same too']);
});

test('whitespace-only differences do not count as corrections', () => {
  const { changed } = mergeCorrections(cues('hello world'), ['  hello world  ']);
  assert.equal(changed, 0);
});

test('word timings are dropped from lines whose text changed', () => {
  // Those timings were measured against the OLD words. Keeping them would point
  // each highlight at the wrong word for the rest of the line.
  const input = [
    { timeMs: 0, text: 'wrong words', words: [{ w: 'wrong', tMs: 0 }, { w: 'words', tMs: 400 }] },
    { timeMs: 1000, text: 'right already', words: [{ w: 'right', tMs: 1000 }] },
  ];
  const { cues: out } = mergeCorrections(input, ['correct words', 'right already']);

  assert.equal(out[0].words, undefined, 'stale word timings survived a rewrite');
  assert.ok(Array.isArray(out[1].words), 'untouched line lost its word timings');
});

test('non-string model output is treated as a blank, not a crash', () => {
  // Providers do occasionally return a null or a number inside the array.
  const { cues: out, changed } = mergeCorrections(cues('keep me', 'and me'), [null, 42]);
  assert.deepEqual(out.map((c) => c.text), ['keep me', 'and me']);
  assert.equal(changed, 0);
});

test('other cue fields are carried through', () => {
  const input = [{ timeMs: 0, text: 'a', endMs: 900, source: 'whisper' }];
  const { cues: out } = mergeCorrections(input, ['b']);
  assert.equal(out[0].endMs, 900);
  assert.equal(out[0].source, 'whisper');
});

test('an empty original line may be filled in', () => {
  // The blank guard protects lines that HAD words; it must not stop the model
  // supplying words for a line that had none.
  const { cues: out, changed } = mergeCorrections(cues(''), ['now it has words']);
  assert.equal(out[0].text, 'now it has words');
  assert.equal(changed, 1);
});
