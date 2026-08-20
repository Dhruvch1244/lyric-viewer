'use strict';

/*
  Unit tests for offline song analysis (src/renderer/analyze.js).

  The band split is deliberately plain arithmetic over a Float32Array rather
  than Web Audio biquads, precisely so the algorithm can be tested here with no
  browser and no AudioContext. These tests are the payoff.

  What matters is that a measurement taken offline says the same thing the live
  path would: a loud passage lands in the right place, a bass tone reads as bass
  and a hiss does not, and a click train at a known tempo comes back at that
  tempo through the same estimator the live clock uses.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const SongAnalysis = require('../src/renderer/analyze.js');

const RATE = 44100;

/** Build `seconds` of samples from a per-sample function. */
function build(seconds, fn) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = fn(i / RATE, i);
  return out;
}

const sine = (hz, amp = 1) => (t) => Math.sin(2 * Math.PI * hz * t) * amp;

test('a quiet song and a loud song differ in shape, not in scale', () => {
  // Normalised against the track's own peak, so a quietly mastered song must
  // produce the same envelope as a loud one with the same dynamics.
  const quiet = SongAnalysis.analyseSamples(build(2, sine(440, 0.05)), RATE);
  const loud = SongAnalysis.analyseSamples(build(2, sine(440, 0.9)), RATE);
  const mid = (a) => a.level[Math.floor(a.level.length / 2)];
  assert.ok(Math.abs(mid(quiet) - mid(loud)) < 0.02,
    `${mid(quiet)} vs ${mid(loud)} — normalisation should erase the level difference`);
});

test('a loud passage lands in the window it actually occupies', () => {
  // Silence, then a loud second, then silence.
  const sig = build(3, (t) => (t >= 1 && t < 2 ? Math.sin(2 * Math.PI * 200 * t) : 0));
  const a = SongAnalysis.analyseSamples(sig, RATE);
  const at = (sec) => a.level[Math.floor((sec * 1000) / a.windowMs)];
  assert.ok(at(1.5) > 0.5, `middle should be loud, got ${at(1.5)}`);
  assert.ok(at(0.5) < 0.1, `start should be quiet, got ${at(0.5)}`);
  assert.ok(at(2.5) < 0.1, `end should be quiet, got ${at(2.5)}`);
});

test('the band split separates a bass tone from a bright one', () => {
  const low = SongAnalysis.analyseSamples(build(2, sine(60)), RATE);
  const high = SongAnalysis.analyseSamples(build(2, sine(9000)), RATE);
  const mid = (a, band) => a[band][Math.floor(a[band].length / 2)];

  assert.ok(mid(low, 'bass') > mid(low, 'treble'),
    'a 60Hz tone should read as bass');
  assert.ok(mid(high, 'treble') > mid(high, 'bass'),
    'a 9kHz tone should read as treble');
});

test('a click train recovers its tempo through the live estimator', () => {
  // 120 BPM = a click every 500ms. This is the same Tempo.estimate the beat
  // clock uses, so agreement here means the offline path and the live path
  // cannot disagree about a song's tempo.
  global.window = {};
  require('../src/renderer/tempo.js');
  const Tempo = global.window.Tempo;

  const periodS = 0.5;
  const sig = build(20, (t) => {
    const phase = t % periodS;
    // A short decaying low thump, which is what a kick looks like to the filter.
    return phase < 0.05 ? Math.sin(2 * Math.PI * 55 * t) * (1 - phase / 0.05) : 0;
  });

  const a = SongAnalysis.analyseSamples(sig, RATE);
  assert.ok(a.onsets.length >= 20, `expected ~40 onsets, got ${a.onsets.length}`);

  const est = Tempo.estimate(a.onsets);
  assert.ok(est, 'a steady click train must yield an estimate');
  assert.ok(Math.abs(est.bpm - 120) < 3, `expected ~120 BPM, got ${est.bpm.toFixed(1)}`);
});

test('onsets fire once per hit, not continuously through it', () => {
  // A single long tone must not read as a stream of onsets: the detector has to
  // re-arm on a fall before it can fire again.
  const sig = build(4, sine(55));
  const a = SongAnalysis.analyseSamples(sig, RATE);
  assert.ok(a.onsets.length <= 2, `a sustained tone should not repeat, got ${a.onsets.length}`);
});

test('silence produces no onsets and a flat envelope', () => {
  const a = SongAnalysis.analyseSamples(build(2, () => 0), RATE);
  assert.equal(a.onsets.length, 0);
  assert.ok(a.level.every((v) => v === 0));
});

test('tolerates empty and degenerate input', () => {
  assert.equal(SongAnalysis.analyseSamples(null, RATE).level.length, 0);
  assert.equal(SongAnalysis.analyseSamples(new Float32Array(0), RATE).level.length, 0);
  assert.equal(SongAnalysis.analyseSamples(build(1, () => 0), 0).level.length, 0);
  // Shorter than one window: no windows, but no crash either.
  assert.equal(SongAnalysis.analyseSamples(new Float32Array(10), RATE).level.length, 0);
});

/* ------------------------------------------------ measured beat grid --- */
/*
  `beatPhaseAt` is what lets the beat clock keep phase with no live audio at
  all: the native pass (beats.rs) measures where every beat is, and this reads
  the current position against that list. Its failures are all silent ones — an
  off-by-one lands the clock a whole beat out, which looks like the visuals
  simply feeling wrong rather than like a bug.
*/

test('the phase is the distance past the most recent beat', () => {
  const grid = [0, 500, 1000, 1500];
  assert.equal(SongAnalysis.beatPhaseAt(grid, 0), 0);
  assert.equal(SongAnalysis.beatPhaseAt(grid, 120), 120);
  assert.equal(SongAnalysis.beatPhaseAt(grid, 500), 0, 'landing exactly on a beat is phase zero, not a full beat');
  assert.equal(SongAnalysis.beatPhaseAt(grid, 1499), 499);
  assert.equal(SongAnalysis.beatPhaseAt(grid, 1500), 0);
});

test('a position past the last beat keeps counting from it', () => {
  // The grid stops a window short of the end of the track; the clock must not
  // jump back to the start of the song there.
  assert.equal(SongAnalysis.beatPhaseAt([0, 500, 1000], 1750), 750);
});

test('a position before the first beat has no phase', () => {
  // An intro can precede the first measured beat. Reporting zero would pin the
  // clock on a beat that has not happened; null lets the caller fall back.
  assert.equal(SongAnalysis.beatPhaseAt([400, 900], 0), null);
  assert.equal(SongAnalysis.beatPhaseAt([400, 900], 399), null);
  assert.equal(SongAnalysis.beatPhaseAt([400, 900], 400), 0);
});

test('an uneven grid is read from the grid, not from an assumed period', () => {
  // The whole reason a list of positions is kept rather than a BPM: a real
  // grid breathes, and dividing by a fixed period would drift across the song.
  const grid = [0, 480, 1010, 1500, 1990];
  assert.equal(SongAnalysis.beatPhaseAt(grid, 1200), 190);
  assert.equal(SongAnalysis.beatPhaseAt(grid, 1600), 100);
});

test('a missing or unusable grid yields null rather than throwing', () => {
  assert.equal(SongAnalysis.beatPhaseAt(null, 100), null);
  assert.equal(SongAnalysis.beatPhaseAt(undefined, 100), null);
  assert.equal(SongAnalysis.beatPhaseAt([], 100), null);
  assert.equal(SongAnalysis.beatPhaseAt([500], 900), null, 'one beat is not a grid');
  assert.equal(SongAnalysis.beatPhaseAt([0, 500], NaN), null);
});

test('the search finds the right beat in a long grid', () => {
  // Binary search, so an off-by-one only shows up away from the ends.
  const grid = Array.from({ length: 1000 }, (_, i) => i * 500);
  for (const beat of [0, 1, 2, 499, 500, 998, 999]) {
    assert.equal(SongAnalysis.beatPhaseAt(grid, beat * 500 + 123), 123, `wrong beat near index ${beat}`);
  }
});

/* ------------------------------------------------------- key tinting --- */
/*
  `hueTowards` biases a palette by musical key (minor cool, major warm). A
  fixed rotation cannot express that — +20° warms a blue palette and cools a
  red one — so the tint is a partial move toward a target hue. The one thing
  that can be quietly wrong is the wraparound: a naive subtraction sends a
  colour near 0° the long way through every other hue on the wheel.
*/

test('a hue moves part of the way toward its target', () => {
  assert.equal(SongAnalysis.hueTowards(0, 100, 0.5), 50);
  assert.equal(SongAnalysis.hueTowards(200, 100, 0.5), 150);
  assert.equal(SongAnalysis.hueTowards(200, 100, 0), 200, 'zero amount must not move it');
  assert.equal(SongAnalysis.hueTowards(200, 100, 1), 100, 'a full amount lands on the target');
});

test('the nudge takes the short way round the wheel', () => {
  // 350 → 10 is +20, not −340. Going the long way would sweep the palette
  // through green and blue on the way to a warm tint.
  assert.equal(SongAnalysis.hueTowards(350, 10, 0.5), 0);
  assert.equal(SongAnalysis.hueTowards(10, 350, 0.5), 0);
  assert.equal(SongAnalysis.hueTowards(350, 30, 1), 30);
});

test('the result always lands in 0..360', () => {
  for (const [hue, target] of [[350, 10], [10, 350], [0, 180], [359, 1], [1, 359], [-40, 200], [400, 10]]) {
    const got = SongAnalysis.hueTowards(hue, target, 0.18);
    assert.ok(got >= 0 && got < 360, `hueTowards(${hue}, ${target}) = ${got}`);
  }
});

test('an exactly opposite hue moves by a consistent half-turn', () => {
  // 180° apart is the one genuinely ambiguous case — both directions are the
  // "short" way. It must pick one and not oscillate or return NaN.
  const got = SongAnalysis.hueTowards(0, 180, 0.5);
  assert.ok(Number.isFinite(got) && got >= 0 && got < 360, `got ${got}`);
  assert.equal(SongAnalysis.hueTowards(0, 180, 0.5), SongAnalysis.hueTowards(0, 180, 0.5));
});

test('a small amount keeps the colour recognisably its own', () => {
  // The tint biases the artwork's palette rather than replacing it, so the
  // shipped amount must move a hue by well under a quarter turn.
  const moved = Math.abs(SongAnalysis.hueTowards(200, 35, 0.18) - 200);
  assert.ok(moved < 40, `a 0.18 nudge moved the hue ${moved}°`);
});
