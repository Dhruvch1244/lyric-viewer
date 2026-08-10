'use strict';

/*
  Unit tests for the pure cue-shaping helpers in src/main/transcribe.js.

  chunksToCues is where Whisper's raw output is made safe for the lyric
  pipeline, so it carries the messy real-world cases: subtitle annotations it
  emits over instrumentals, the phrase loops it falls into on long musical
  passages, and the null end-timestamp on a final chunk. No model is loaded
  here — these run under `node --test` with no Electron and no network.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunksToCues } = require('../src/main/transcribe');

test('chunksToCues converts seconds to ms and trims text', () => {
  const cues = chunksToCues([
    { timestamp: [0, 2.5], text: ' City lights ' },
    { timestamp: [2.5, 5], text: 'are calling' },
  ]);
  assert.deepEqual(cues, [
    { timeMs: 0, text: 'City lights' },
    { timeMs: 2500, text: 'are calling' },
  ]);
});

test('chunksToCues keeps a final chunk whose end timestamp is null', () => {
  const cues = chunksToCues([{ timestamp: [7.25, null], text: 'fade out' }]);
  assert.deepEqual(cues, [{ timeMs: 7250, text: 'fade out' }]);
});

test('chunksToCues drops subtitle annotations and bare music notes', () => {
  const cues = chunksToCues([
    { timestamp: [0, 1], text: '[Music]' },
    { timestamp: [1, 2], text: '(applause)' },
    { timestamp: [2, 3], text: '[BLANK_AUDIO]' },
    { timestamp: [3, 4], text: '♪♪' },
    { timestamp: [4, 5], text: 'real lyric' },
  ]);
  assert.deepEqual(cues, [{ timeMs: 4000, text: 'real lyric' }]);
});

test('chunksToCues drops the "thanks for watching" hallucination family', () => {
  const cues = chunksToCues([
    { timestamp: [0, 1], text: 'Thanks for watching!' },
    { timestamp: [1, 2], text: 'Please subscribe' },
    { timestamp: [2, 3], text: 'Subtitles by the Amara.org community' },
    { timestamp: [3, 4], text: 'keep this one' },
  ]);
  assert.deepEqual(cues, [{ timeMs: 3000, text: 'keep this one' }]);
});

test('chunksToCues collapses consecutive repeats from instrumental looping', () => {
  const cues = chunksToCues([
    { timestamp: [0, 1], text: 'oh oh oh' },
    { timestamp: [1, 2], text: 'oh oh oh' },
    { timestamp: [2, 3], text: 'oh oh oh' },
    { timestamp: [3, 4], text: 'different now' },
  ]);
  assert.deepEqual(cues, [
    { timeMs: 0, text: 'oh oh oh' },
    { timeMs: 3000, text: 'different now' },
  ]);
});

test('chunksToCues allows a repeated line to return later in the song', () => {
  // A chorus legitimately recurs; only *consecutive* duplicates are looping.
  const cues = chunksToCues([
    { timestamp: [0, 1], text: 'hook line' },
    { timestamp: [1, 2], text: 'verse line' },
    { timestamp: [2, 3], text: 'hook line' },
  ]);
  assert.equal(cues.length, 3);
  assert.equal(cues[2].text, 'hook line');
});

test('chunksToCues skips chunks with an unusable start time', () => {
  const cues = chunksToCues([
    { timestamp: [null, 2], text: 'no start' },
    { timestamp: [NaN, 3], text: 'not a number' },
    { text: 'no timestamp at all' },
    { timestamp: [1.5, 2], text: 'good' },
  ]);
  assert.deepEqual(cues, [{ timeMs: 1500, text: 'good' }]);
});

test('chunksToCues sorts by time and tolerates junk input', () => {
  assert.deepEqual(chunksToCues(null), []);
  assert.deepEqual(chunksToCues(undefined), []);
  assert.deepEqual(chunksToCues([]), []);

  const cues = chunksToCues([
    { timestamp: [9, 10], text: 'later' },
    { timestamp: [1, 2], text: 'earlier' },
  ]);
  assert.deepEqual(cues.map((c) => c.text), ['earlier', 'later']);
});

test('chunksToCues never emits a negative timestamp', () => {
  const cues = chunksToCues([{ timestamp: [-0.4, 1], text: 'clamped' }]);
  assert.equal(cues[0].timeMs, 0);
});
