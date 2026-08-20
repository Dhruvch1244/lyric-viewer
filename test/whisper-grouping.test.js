'use strict';

/*
  Unit tests for grouping Whisper's flat word-level timestamps into
  line-shaped cues (src/renderer/whisper.js, groupWordsIntoLines).

  Like wordtiming.js this is a browser IIFE attaching to `window`, and the
  function under test touches nothing but its arguments, so a bare stub is
  enough to require it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/whisper.js');
const { groupWordsIntoLines } = global.window.Whisper;

function chunk(text, startS, endS) {
  return { text, timestamp: [startS, endS] };
}

test('groups closely-spaced words into one line', () => {
  const lines = groupWordsIntoLines([
    chunk(' hello', 1.0, 1.4),
    chunk(' world', 1.5, 2.0),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'hello world');
  assert.equal(lines[0].timeMs, 1000);
  assert.equal(lines[0].endMs, 2000);
  assert.equal(lines[0].words.length, 2);
  assert.equal(lines[0].words[0].word, 'hello');
  assert.equal(lines[0].words[0].startMs, 1000);
  assert.equal(lines[0].words[1].endMs, 2000);
});

test('splits a new line after a long pause', () => {
  const lines = groupWordsIntoLines([
    chunk('hello', 1.0, 1.4),
    chunk('world', 1.5, 2.0),
    // 1.5s silence before the next word — well past the 700ms gap threshold.
    chunk('goodbye', 3.5, 4.0),
    chunk('now', 4.1, 4.4),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'hello world');
  assert.equal(lines[1].text, 'goodbye now');
  assert.equal(lines[1].timeMs, 3500);
});

test('splits a legato run with no pauses once it hits the max words per line', () => {
  const words = Array.from({ length: 20 }, (_, i) => chunk(`w${i}`, i * 0.3, i * 0.3 + 0.25));
  const lines = groupWordsIntoLines(words);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words.length, 14);
  assert.equal(lines[1].words.length, 6);
});

test('trims whitespace-padded word text (BPE tokens often carry a leading space)', () => {
  const lines = groupWordsIntoLines([chunk('  hello  ', 0, 0.5)]);
  assert.equal(lines[0].words[0].word, 'hello');
  assert.equal(lines[0].text, 'hello');
});

test('drops chunks with empty text or a missing timestamp', () => {
  const lines = groupWordsIntoLines([
    chunk('hello', 0, 0.5),
    { text: '   ', timestamp: [0.5, 0.6] },
    { text: 'world', timestamp: null },
    chunk('there', 0.6, 1.0),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'hello there');
});

test('never produces an end time before its start time for an open-ended final chunk', () => {
  // transformers.js can leave timestamp[1] null for a chunk that ran to the
  // end of the clip mid-utterance.
  const lines = groupWordsIntoLines([chunk('hello', 1.0, null)]);
  assert.equal(lines[0].words[0].endMs >= lines[0].words[0].startMs, true);
});

test('returns nothing for an empty or entirely-filtered input', () => {
  assert.deepEqual(groupWordsIntoLines([]), []);
  assert.deepEqual(groupWordsIntoLines([{ text: '', timestamp: [0, 1] }]), []);
});

/* ------------------------------------------- the segment fallback path */
/*
  Word timing comes from the decoder's cross-attention weights. Pointed at an
  ONNX export that has none, transformers.js throws rather than degrading, and
  because `transcribe` had no catch that turned a per-word-timing problem into
  a total transcription failure -- measured, against
  onnx-community/whisper-base, which is what this file used to name.

  These cover the two halves of the fix: the model id that has the attentions,
  and the fallback that keeps a transcription even when it does not.
*/

const { segmentsToLines, DEFAULT_MODEL } = global.window.Whisper;

test('the default model is an export that carries cross attentions', () => {
  // `return_timestamps: 'word'` cannot work without them, and the failure is
  // invisible until a real transcription runs. Verified by running both repos
  // against 8s of synthesised speech: the plain one threw, the _timestamped
  // one returned 11 word-level chunks.
  assert.match(DEFAULT_MODEL, /_timestamped$/,
    'a model id without the cross-attention export breaks transcription entirely, not just word timing');
});

test('segments become one cue each, with no words[]', () => {
  // A segment is a whole phrase. Presenting it as a single "word" spanning
  // several seconds would be a lie that align.rs would reject anyway.
  const lines = segmentsToLines([
    chunk(' The quick brown fox jumps over the lazy dog.', 0, 4.36),
    chunk(' Testing 12345.', 4.36, 7.16),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'The quick brown fox jumps over the lazy dog.');
  assert.equal(lines[0].timeMs, 0);
  assert.equal(lines[0].endMs, 4360);
  assert.equal(lines[0].words, undefined, 'a segment must not claim per-word timing');
  assert.equal(lines[1].timeMs, 4360);
});

test('segments with no end timestamp collapse to a point rather than going backwards', () => {
  const lines = segmentsToLines([{ text: ' trailing', timestamp: [3.0, null] }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].timeMs, 3000);
  assert.equal(lines[0].endMs, 3000);
});

test('empty and malformed segments are dropped, not turned into blank cues', () => {
  const lines = segmentsToLines([
    chunk('   ', 0, 1),
    { text: 'no timestamp' },
    null,
    chunk(' real', 1, 2),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'real');
});
