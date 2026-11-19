'use strict';

/*
  Video FX (src/renderer/video-fx.js) and the ▶ Video panel's Effect picker.
  The shader itself needs a GPU (checked in a browser, see the commit); what
  is pinned here is that every effect the panel offers and every effect the
  Video Director asks for is one the engine actually has — a name mismatch
  would silently draw the plain video.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/renderer/video-fx.js');
const { MODES } = global.window.VideoFX;

test('every effect in the panel exists in the engine', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const select = html.match(/<select id="mv-fx"[\s\S]*?<\/select>/);
  assert.ok(select, 'mv-fx select present');
  const values = [...select[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  for (const v of values) assert.ok(v === 'auto' || MODES.includes(v), `panel offers unknown effect ${v}`);
  for (const m of MODES) assert.ok(values.includes(m), `engine effect ${m} missing from the panel`);
});

test('every effect the Video Director picks exists in the engine', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/music-video.js'), 'utf8');
  const block = src.match(/const SECTION_LOOK = \{[\s\S]*?\n {2}\};/);
  assert.ok(block, 'SECTION_LOOK present');
  const fx = [...block[0].matchAll(/fx: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(fx.length, 6, 'one effect per section kind');
  for (const f of fx) assert.ok(MODES.includes(f), `Director asks for unknown effect ${f}`);
});
