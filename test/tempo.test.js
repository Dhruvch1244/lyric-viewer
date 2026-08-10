'use strict';

/*
  Unit tests for tempo estimation (src/renderer/tempo.js).

  Browser IIFE attaching to `window`, touching nothing else, so a bare stub is
  enough to require it. Synthetic onset trains at known tempi give exact ground
  truth — which is the point: a tempo detector that cannot be checked against a
  known answer is not worth shipping.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/tempo.js');
const Tempo = global.window.Tempo;

/**
 * A train of onsets at a given tempo.
 * @param {number} bpm
 * @param {number} beats
 * @param {object} [o] jitterMs, dropEvery, startMs
 */
function train(bpm, beats, o = {}) {
  const period = 60000 / bpm;
  const out = [];
  for (let i = 0; i < beats; i += 1) {
    if (o.dropEvery && i % o.dropEvery === 0 && i > 0) continue;
    const jitter = o.jitterMs ? (Math.sin(i * 12.9898) * o.jitterMs) : 0;
    out.push((o.startMs || 0) + i * period + jitter);
  }
  return out;
}

test('estimate recovers an exact tempo', () => {
  for (const bpm of [90, 120, 128, 140, 174]) {
    const r = Tempo.estimate(train(bpm, 32));
    assert.ok(r, `no estimate at ${bpm}`);
    assert.ok(Math.abs(r.bpm - bpm) < 2, `got ${r.bpm.toFixed(1)} for ${bpm}`);
    assert.ok(r.confidence > 0.9, `low confidence ${r.confidence.toFixed(2)} at ${bpm}`);
  }
});

test('estimate survives jitter a real detector would produce', () => {
  const r = Tempo.estimate(train(128, 32, { jitterMs: 18 }));
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 128) < 3, `got ${r.bpm.toFixed(1)}`);
});

test('estimate survives dropped kicks', () => {
  // Every 4th onset missing — a simple mean of successive intervals would be
  // dragged badly wrong by the doubled gaps.
  const r = Tempo.estimate(train(120, 40, { dropEvery: 4 }));
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 120) < 3, `got ${r.bpm.toFixed(1)}`);
});

test('estimate reports the phase of the beat', () => {
  const offset = 5000;
  const r = Tempo.estimate(train(120, 32, { startMs: offset }));
  assert.ok(r);
  // Beats land every 500ms starting at 5000, so the phase must sit on that grid.
  const err = Math.abs(((r.phaseMs - offset) % r.periodMs + r.periodMs) % r.periodMs);
  const wrapped = Math.min(err, r.periodMs - err);
  assert.ok(wrapped < 25, `phase off by ${wrapped.toFixed(0)}ms`);
});

test('estimate prefers the musically likely octave', () => {
  // 64 BPM and 128 BPM describe this train equally well; 128 is the real answer.
  const r = Tempo.estimate(train(128, 32));
  assert.ok(r.bpm > 100, `chose the half-tempo reading: ${r.bpm.toFixed(1)}`);
});

test('estimate declines when there is not enough evidence', () => {
  assert.equal(Tempo.estimate([]), null);
  assert.equal(Tempo.estimate([0, 500, 1000]), null);   // below MIN_ONSETS
  assert.equal(Tempo.estimate(null), null);
});

test('estimate gives low confidence on scattered onsets', () => {
  const random = [];
  let t = 0;
  for (let i = 0; i < 40; i += 1) { t += 120 + (i * 37) % 900; random.push(t); }
  const r = Tempo.estimate(random);
  // It will always return SOMETHING; the confidence is what tells the caller
  // whether to believe it, so that is what must stay low.
  if (r) assert.ok(r.confidence < 0.9, `unjustified confidence ${r.confidence.toFixed(2)}`);
});

test('note/current/reset track a rolling window', () => {
  Tempo.reset();
  assert.equal(Tempo.count(), 0);
  assert.equal(Tempo.current(), null);
  for (const t of train(120, 24)) Tempo.note(t);
  assert.equal(Tempo.count(), 24);
  const r = Tempo.current();
  assert.ok(r && Math.abs(r.bpm - 120) < 3);
  Tempo.reset();
  assert.equal(Tempo.count(), 0);
});

test('note drops onsets older than the rolling window', () => {
  Tempo.reset();
  Tempo.note(0);
  Tempo.note(1000);
  Tempo.note(50000);   // far beyond the window; older entries must go
  assert.equal(Tempo.count(), 1);
});

test('note ignores junk timestamps', () => {
  Tempo.reset();
  Tempo.note(NaN);
  Tempo.note(undefined);
  Tempo.note('x');
  assert.equal(Tempo.count(), 0);
});
