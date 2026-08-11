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

/* ------------------------------------------------------------------ priors */
/*
  These exist because of a bug that only real audio could surface. On John
  Summit — ALL THE TIME (138 BPM) the offline analysis got 138 in 91ms, and the
  live estimator then reported 60, 64, 86, 147, 172 and 179 across one play at
  confidences up to 0.87 — confident and wrong — dragging the clock and the HUD
  chip to 174. Note 172 ≈ 138 × 1.25: not an octave, so octave correction could
  never have caught it.
*/

/**
 * A window that reproduces the observed failure: a 138 BPM kick train with
 * enough competing structure at 1.25x that the raw estimator prefers 172.4.
 *
 * A *clean* 172.5 train would be the wrong test — that signal genuinely is
 * 172.5 BPM, and a prior that overrode it would be a bug of its own. The real
 * failure was a marginal call between two similar scores, which is exactly what
 * this builds.
 */
function confusingWindow() {
  const out = [];
  for (let i = 0; i < 20; i += 1) out.push(i * (60000 / 138));
  for (let i = 0; i < 22; i += 1) out.push(i * (60000 / 172.5) + 7);
  return out.sort((a, b) => a - b);
}

test('the raw estimator really is fooled by this window', () => {
  // Pins the premise of the test below. If this ever stops failing, the fix
  // being verified is no longer being exercised and the next test is vacuous.
  const r = Tempo.estimate(confusingWindow());
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 172.4) < 2,
    `expected the known 172.4 misread, got ${r.bpm.toFixed(1)}`);
  assert.ok(r.confidence > 0.4 && r.confidence < 0.7,
    `expected a marginal confidence, got ${r.confidence.toFixed(2)}`);
});

test('a prior is respected when the live window disagrees', () => {
  const r = Tempo.estimate(confusingWindow(), { prior: 138 });
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 138) < 3,
    `prior ignored: got ${r.bpm.toFixed(1)} instead of 138`);
});

test('a prior does not distort agreement with the live estimate', () => {
  // When the live window agrees with the prior, the answer must be the tempo,
  // not some blend of the two.
  const r = Tempo.estimate(train(138, 32), { prior: 138 });
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 138) < 2, `got ${r.bpm.toFixed(1)}`);
});

test('a dramatically better live fit still overrides the prior', () => {
  // The prior must not be unconditional: a DJ set genuinely changes tempo, and
  // a wrong analysis has to be recoverable. An unambiguous train should win
  // against a prior that fits it badly.
  const r = Tempo.estimate(train(100, 32), { prior: 138 });
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 100) < 3,
    `prior wrongly held: got ${r.bpm.toFixed(1)} instead of 100`);
});

test('setPrior rejects nonsense and reset clears it', () => {
  Tempo.reset();
  Tempo.setPrior(138);
  assert.equal(Tempo.prior(), 138);

  // Out of the search range, or not a number at all.
  Tempo.setPrior(5);
  assert.equal(Tempo.prior(), 0, 'accepted a sub-range prior');
  Tempo.setPrior(900);
  assert.equal(Tempo.prior(), 0, 'accepted an over-range prior');
  Tempo.setPrior(NaN);
  assert.equal(Tempo.prior(), 0, 'accepted NaN');

  // The prior belongs to a song, so a track change must drop it.
  Tempo.setPrior(138);
  Tempo.reset();
  assert.equal(Tempo.prior(), 0, 'prior survived a reset');
});

test('a stored prior applies without being passed explicitly', () => {
  // The renderer sets it once via setPrior and then calls current() with no
  // options, so the stored path is the one that actually ships.
  Tempo.reset();
  Tempo.setPrior(138);
  for (const t of confusingWindow()) Tempo.note(t);
  const r = Tempo.current();
  assert.ok(r);
  assert.ok(Math.abs(r.bpm - 138) < 3,
    `stored prior ignored: got ${r.bpm.toFixed(1)}`);
  Tempo.reset();
});

test('phaseFor tracks the beat of a known period without re-deriving it', () => {
  // This is what the renderer runs once a tempo is known: the period is fixed,
  // only the phase follows the music.
  Tempo.reset();
  const period = 60000 / 138;
  const offset = 137;                        // where the downbeat actually sits
  for (const t of train(138, 24, { startMs: offset })) Tempo.note(t);

  const ph = Tempo.phaseFor(period);
  assert.ok(ph, 'no phase from a clean train');
  assert.ok(ph.confidence > 0.9, `low phase confidence ${ph.confidence.toFixed(2)}`);
  // Phase is modulo the period, so compare on the circle.
  const diff = Math.abs(((ph.phaseMs - offset) % period + period) % period);
  const wrapped = Math.min(diff, period - diff);
  assert.ok(wrapped < 12, `phase off by ${wrapped.toFixed(1)}ms`);
  Tempo.reset();
});

test('phaseFor says nothing when there is not enough evidence', () => {
  Tempo.reset();
  assert.equal(Tempo.phaseFor(60000 / 138), null);
  Tempo.note(0);
  Tempo.note(400);
  assert.equal(Tempo.phaseFor(60000 / 138), null, 'answered from two onsets');
  Tempo.reset();
});

test('phaseFor rejects a nonsense period', () => {
  Tempo.reset();
  for (const t of train(138, 24)) Tempo.note(t);
  assert.equal(Tempo.phaseFor(0), null);
  assert.equal(Tempo.phaseFor(-5), null);
  assert.equal(Tempo.phaseFor(NaN), null);
  Tempo.reset();
});
