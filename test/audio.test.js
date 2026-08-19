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

/* --------------------------------------------------------- waveform gate */
/*
  The native path emits a spectrum (512 B) and a waveform (1024 B) 50x a
  second. Only MilkDrop reads the waveform, so audio.js asks the backend to
  stop sending it when nothing has called `timeDomain` for a second. These
  drive the real module through a fake `window.player`, because the bug this
  guards against -- the waveform being switched off while MilkDrop is still
  drawing -- is a wiring bug, not an arithmetic one.

  Kept last in the file: starting capture flips module-level state that the
  pure-DSP tests above assume is untouched.
*/

/*
  audio.js subscribes to `native-audio` exactly once and keeps that
  subscription across stop/start, so the frame callback is captured here once
  and reused by every test rather than re-registered per fake backend.
*/
let emitFrame = null;

/** @returns {{calls: boolean[], emit: (frame: any) => void}} */
function fakeBackend() {
  const calls = [];
  global.window.player = {
    startAudioCapture: () => Promise.resolve(true),
    stopAudioCapture: () => {},
    setAudioWaveform: (enabled) => { calls.push(enabled); },
    onNativeAudio: (cb) => { emitFrame = cb; },
  };
  return { calls, emit: (frame) => emitFrame && emitFrame(frame) };
}

/** base64 of `n` mid-scale bytes, the shape audio.rs sends. */
function b64Bytes(n, value) {
  return Buffer.from(Uint8Array.from({ length: n }, () => value)).toString('base64');
}

test('the waveform is released when nothing has asked for it, and restored when something does', async () => {
  const backend = fakeBackend();
  const started = Audio.start();
  // startNative only resolves true once a real frame lands.
  backend.emit({ t: b64Bytes(1024, 128), f: b64Bytes(512, 40) });
  assert.equal(await started, true, 'native capture did not start');
  assert.deepEqual(backend.calls, [], 'asked the backend for anything before a frame ran');

  // Inside the idle window: still on, because MilkDrop may be mid-load.
  for (let i = 0; i < 30; i += 1) Audio.sample(i * 16);
  assert.deepEqual(backend.calls, [], 'released the waveform too early');

  // Past the idle window with no consumer: released.
  for (let i = 30; i < 70; i += 1) Audio.sample(i * 16);
  assert.deepEqual(backend.calls, [false], 'did not release an unread waveform');

  // Releasing it must not leave a stale waveform readable.
  const out = new Uint8Array(1024);
  out.fill(7);
  Audio.timeDomain(out);
  assert.ok(out.every((v) => v === 128), 'served a stale waveform after releasing it');

  // ...and asking IS the subscription, so the next call turns it back on.
  assert.deepEqual(backend.calls, [false, true], 'timeDomain did not re-request the waveform');

  // A consumer that keeps reading keeps it on -- one request, not one per
  // frame, and well past the idle window.
  for (let i = 0; i < 200; i += 1) { Audio.timeDomain(out); Audio.sample(i * 16); }
  assert.deepEqual(backend.calls, [false, true], 'chattered at the backend every frame');

  Audio.stop();
});

test('a backend without the waveform command does not break capture', async () => {
  // An older frontend/backend pairing: audio.rs defaults to sending the
  // waveform, so the gate must degrade to "always on" rather than throw.
  const backend = fakeBackend();
  delete global.window.player.setAudioWaveform;
  const started = Audio.start();
  backend.emit({ t: b64Bytes(1024, 128), f: b64Bytes(512, 40) });
  assert.equal(await started, true);
  for (let i = 0; i < 100; i += 1) Audio.sample(i * 16); // would call setAudioWaveform if it existed
  const out = new Uint8Array(1024);
  assert.equal(Audio.timeDomain(out), true, 'capture stopped working');
  Audio.stop();
});

test('a frame without the waveform key leaves the spectrum path working', () => {
  // What audio.rs emits once the gate is closed: `{ f }` with no `t`.
  const backend = fakeBackend();
  backend.emit({ f: b64Bytes(512, 200) });   // no throw, no NaN
  assert.ok(true);
});
