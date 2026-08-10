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
