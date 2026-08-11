'use strict';

/*
  Unit tests for the spectral analysis in src/renderer/audio.js.

  The capture plumbing needs a browser and a sound card; the DSP does not, and
  the DSP is where being wrong is invisible. These check the three pure
  functions against spectra whose right answer is known by construction.

  Why this layer got deeper at all: played against a real 138 BPM track, the old
  bass-rise onset test produced a stream noisy enough that the tempo estimator
  reported 60, 64, 86, 147, 172 and 179 across one song.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/audio.js');
const Audio = global.window.AudioReactive;

/** A spectrum with a flat value everywhere. */
function flat(value, n = 512) {
  return Uint8Array.from({ length: n }, () => value);
}

/** A spectrum with all energy in one bin. */
function spike(bin, value = 255, n = 512) {
  const a = new Uint8Array(n);
  a[bin] = value;
  return a;
}

test('bands cover the spectrum without gaps or overlaps', () => {
  const edges = Audio.BAND_EDGES;
  assert.equal(edges[0], 0);
  for (let i = 1; i < edges.length; i += 1) {
    assert.ok(edges[i] > edges[i - 1], `edge ${i} does not advance`);
  }
  assert.equal(edges.length - 1, Audio.BAND_COUNT);
});

test('a flat spectrum reads the same in every band', () => {
  // Bands are different widths, so an unweighted sum would make the wide
  // high bands read louder than the narrow low ones on identical input.
  const out = Audio.computeBands(flat(128), new Array(Audio.BAND_COUNT).fill(0));
  for (const v of out) assert.ok(Math.abs(v - 128 / 255) < 0.001, `band read ${v}`);
});

test('computeBands normalises to 0..1', () => {
  const loud = Audio.computeBands(flat(255), new Array(Audio.BAND_COUNT).fill(0));
  const quiet = Audio.computeBands(flat(0), new Array(Audio.BAND_COUNT).fill(0));
  for (const v of loud) assert.equal(v, 1);
  for (const v of quiet) assert.equal(v, 0);
});

test('computeBands writes in place and allocates nothing', () => {
  // It runs 60 times a second; a fresh array per frame is pure garbage.
  const out = new Array(Audio.BAND_COUNT).fill(0);
  const same = Audio.computeBands(flat(200), out);
  assert.equal(same, out);
});

test('energy low in the spectrum lands in a low band', () => {
  const out = Audio.computeBands(spike(1), new Array(Audio.BAND_COUNT).fill(0));
  assert.ok(out[0] > 0, 'bin 1 did not register in band 0');
  assert.ok(out[Audio.BAND_COUNT - 1] === 0, 'bin 1 leaked into the top band');
});

test('the centroid rises as energy moves up the spectrum', () => {
  // This is the whole point of measuring it: brightness separates a filtered
  // breakdown from a full-range drop even when both are equally loud.
  const low = Audio.spectralCentroid(spike(10));
  const mid = Audio.spectralCentroid(spike(256));
  const high = Audio.spectralCentroid(spike(500));
  assert.ok(low < mid && mid < high, `centroid did not rise: ${low} ${mid} ${high}`);
});

test('the centroid of a flat spectrum sits in the middle', () => {
  const c = Audio.spectralCentroid(flat(128));
  assert.ok(Math.abs(c - 0.5) < 0.01, `got ${c}`);
});

test('the centroid of silence is zero rather than NaN', () => {
  // Divide-by-zero here would poison every visual that reads it, and silence
  // is the normal state between tracks.
  assert.equal(Audio.spectralCentroid(flat(0)), 0);
});

test('flux counts energy appearing, not energy leaving', () => {
  /*
    Positive-only is the crux. Counting decay as well would make every note-OFF
    look like a note-on, which is exactly the false-positive class this was
    added to remove.
  */
  const quiet = flat(10);
  const loud = flat(200);
  assert.ok(Audio.spectralFlux(loud, quiet) > 0, 'a rise produced no flux');
  assert.equal(Audio.spectralFlux(quiet, loud), 0, 'a fall produced flux');
});

test('flux is zero for an unchanged spectrum', () => {
  const a = flat(120);
  assert.equal(Audio.spectralFlux(a, Uint8Array.from(a)), 0);
});

test('a broadband transient produces far more flux than a single-bin move', () => {
  // This is what separates a drum from a bass note, and it is the reason the
  // onset test now requires flux as well as a level rise.
  const base = flat(10);
  const drum = flat(120);                 // many bins rise at once
  const bassNote = Uint8Array.from(base);
  for (let i = 0; i < 4; i += 1) bassNote[i] = 255;   // a few bins rise a lot

  const drumFlux = Audio.spectralFlux(drum, base);
  const noteFlux = Audio.spectralFlux(bassNote, base);
  assert.ok(drumFlux > noteFlux * 5,
    `drum ${drumFlux.toFixed(4)} vs bass note ${noteFlux.toFixed(4)}`);
});

test('flux can be restricted to a bin range', () => {
  // The kick test uses the low end only; a hi-hat must not feed it.
  const base = flat(0);
  const highs = flat(0);
  for (let i = 200; i < 300; i += 1) highs[i] = 255;
  assert.equal(Audio.spectralFlux(highs, base, 0, 16), 0);
  assert.ok(Audio.spectralFlux(highs, base) > 0);
});
