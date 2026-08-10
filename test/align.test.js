'use strict';

/*
  Unit tests for the forced aligner in src/main/align.js.

  The scenario throughout: correct lyric lines from LRCLIB's plain text, and
  transcribed cues whose TIMING is good but whose WORDS are partly wrong —
  which is exactly how Whisper behaves on music. The aligner must keep the
  correct words and borrow the timing.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { alignLyrics, splitPlainLyrics, alignSequences } = require('../src/main/align');

test('splitPlainLyrics drops blank lines and section headers', () => {
  const plain = '[Verse 1]\nCity lights\n\nare calling\n(Chorus)\nrun with me\n';
  assert.deepEqual(splitPlainLyrics(plain), ['City lights', 'are calling', 'run with me']);
  assert.deepEqual(splitPlainLyrics(''), []);
});

test('alignLyrics keeps the correct words and takes timing from the cues', () => {
  const lines = ['City lights are calling', 'Run with me tonight', 'Never look back'];
  const cues = [
    { timeMs: 1000, text: 'city lights are calling' },
    { timeMs: 5000, text: 'run with me tonight' },
    { timeMs: 9000, text: 'never look back' },
  ];
  const { cues: out, anchors, coverage } = alignLyrics(lines, cues);

  assert.equal(anchors, 3);
  assert.equal(coverage, 1);
  assert.deepEqual(out, [
    { timeMs: 1000, text: 'City lights are calling' },
    { timeMs: 5000, text: 'Run with me tonight' },
    { timeMs: 9000, text: 'Never look back' },
  ]);
});

test('alignLyrics interpolates a line the transcription misheard', () => {
  const lines = ['City lights are calling', 'Neon on the pavement', 'Never look back'];
  const cues = [
    { timeMs: 1000, text: 'city lights are calling' },
    { timeMs: 5000, text: 'kneeling on the payment' },  // misheard beyond recognition
    { timeMs: 9000, text: 'never look back' },
  ];
  const { cues: out, anchors } = alignLyrics(lines, cues);

  // The correct middle line survives, timed between its neighbours.
  assert.equal(out.length, 3);
  assert.equal(out[1].text, 'Neon on the pavement');
  assert.ok(out[1].timeMs > 1000 && out[1].timeMs < 9000, `got ${out[1].timeMs}`);
  assert.ok(anchors >= 2, 'the two clear lines should anchor');
});

test('alignLyrics keeps lines the transcription dropped entirely', () => {
  const lines = ['First line', 'Second line', 'Third line', 'Fourth line'];
  const cues = [
    { timeMs: 1000, text: 'first line' },
    { timeMs: 10000, text: 'fourth line' },   // middle two never transcribed
  ];
  const { cues: out } = alignLyrics(lines, cues);

  assert.deepEqual(out.map((c) => c.text), lines);
  // Middle lines spread between the anchors, strictly increasing.
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].timeMs > out[i - 1].timeMs, 'times must strictly increase');
  }
  assert.equal(out[0].timeMs, 1000);
  assert.equal(out[3].timeMs, 10000);
});

test('alignLyrics ignores extra hallucinated cues between real lines', () => {
  const lines = ['Real one', 'Real two'];
  const cues = [
    { timeMs: 1000, text: 'real one' },
    { timeMs: 3000, text: 'thanks for watching this video' }, // hallucination
    { timeMs: 5000, text: 'real two' },
  ];
  const { cues: out, anchors } = alignLyrics(lines, cues);

  assert.equal(anchors, 2);
  assert.deepEqual(out, [
    { timeMs: 1000, text: 'Real one' },
    { timeMs: 5000, text: 'Real two' },
  ]);
});

test('alignLyrics handles a lead-in before the first matched line', () => {
  const lines = ['Intro line', 'Main hook'];
  const cues = [{ timeMs: 20000, text: 'main hook' }];
  const { cues: out } = alignLyrics(lines, cues);

  assert.equal(out.length, 2);
  assert.ok(out[0].timeMs >= 0 && out[0].timeMs < out[1].timeMs);
  assert.equal(out[1].timeMs, 20000);
});

test('alignLyrics reports zero coverage and spreads evenly when nothing matches', () => {
  const lines = ['Alpha bravo', 'Charlie delta', 'Echo foxtrot'];
  const cues = [{ timeMs: 4000, text: 'completely unrelated words here' }];
  const { cues: out, anchors, coverage } = alignLyrics(lines, cues, { durationMs: 120000 });

  assert.equal(anchors, 0);
  assert.equal(coverage, 0);
  assert.equal(out.length, 3);
  // Evenly spread across the track, ascending — a weak but ordered fallback.
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].timeMs > out[i - 1].timeMs);
  }
  assert.ok(out[2].timeMs < 120000);
});

test('alignLyrics never emits duplicate or decreasing timestamps', () => {
  const lines = ['a', 'b', 'c', 'd'];
  const cues = [
    { timeMs: 1000, text: 'a' },
    { timeMs: 1000, text: 'b' },   // identical stamps from a chunk boundary
    { timeMs: 1000, text: 'c' },
    { timeMs: 1000, text: 'd' },
  ];
  const { cues: out } = alignLyrics(lines, cues);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].timeMs > out[i - 1].timeMs, `index ${i}: ${out[i].timeMs}`);
  }
});

test('alignLyrics tolerates empty input on either side', () => {
  assert.deepEqual(alignLyrics([], [{ timeMs: 0, text: 'x' }]).cues, []);
  assert.deepEqual(alignLyrics(['a'], []).cues, []);
  assert.deepEqual(alignLyrics(null, null).cues, []);
});

test('alignSequences preserves order and never crosses matches', () => {
  const lines = ['one', 'two', 'three'];
  const cues = [
    { timeMs: 0, text: 'one' },
    { timeMs: 1, text: 'two' },
    { timeMs: 2, text: 'three' },
  ];
  const m = alignSequences(lines, cues);
  assert.deepEqual(m, [0, 1, 2]);
  // Monotonic: a later line can never match an earlier cue.
  const present = m.filter((x) => x !== null);
  for (let i = 1; i < present.length; i += 1) assert.ok(present[i] > present[i - 1]);
});
