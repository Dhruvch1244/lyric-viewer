'use strict';

/*
  Cover 3D's depth heuristic (src/renderer/cover3d.js).

  What matters: the result always uses the full 0..255 range (a flat map is
  a flat picture), a bright saturated subject in the middle comes forward of
  a dark plain ground, and a uniform image does not fall over (no NaN, no
  divide by zero).
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/cover3d.js');
const { buildDepth, boxBlur } = global.window.Cover3D;

function image(w, h, fn) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
    }
  }
  return a;
}

test('a bright saturated subject in the middle stands in front of a dark ground', () => {
  const w = 64, h = 64;
  const rgba = image(w, h, (x, y) => (Math.hypot(x - 32, y - 32) < 12 ? [250, 60, 40] : [20, 22, 30]));
  const d = buildDepth(rgba, w, h);
  const centre = d[32 * w + 32];
  const corner = d[2 * w + 2];
  assert.ok(centre > corner + 120, `centre ${centre} vs corner ${corner}`);
});

test('depth always spans the full range', () => {
  const w = 48, h = 48;
  const d = buildDepth(image(w, h, (x) => [x * 5, x * 5, x * 5]), w, h);
  assert.equal(Math.min(...d), 0);
  assert.equal(Math.max(...d), 255);
});

test('a uniform picture still gives a usable map (centre bias), never NaN', () => {
  const w = 32, h = 32;
  const d = buildDepth(image(w, h, () => [128, 128, 128]), w, h);
  assert.ok(d.every((v) => Number.isFinite(v)));
  assert.ok(d[16 * w + 16] > d[0], 'the middle still comes forward');
});

test('the blur preserves the mean and smooths a spike', () => {
  const w = 21, h = 21;
  const f = new Float32Array(w * h);
  f[10 * w + 10] = 441;
  boxBlur(f, w, h, 2, 1);
  const sum = f.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 441) < 1e-3, `sum ${sum}`);
  assert.ok(f[10 * w + 10] < 441 / 10);
});
