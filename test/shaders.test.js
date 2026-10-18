'use strict';

/*
  Unit tests for the ISF shader catalogue (src/renderer/shaders/) and the one
  piece of shaders.js that is pure: `prepare`, which rewrites ISF audio inputs
  into images the vendored renderer can load.

  The catalogue checks exist for the same reason the MilkDrop name check does
  in presets.test.js: a look that names a shader the catalogue does not have
  falls back silently, so the mismatch has to be caught here.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/renderer/presets.js');
require('../src/renderer/shaders.js');
const { VisualPresets, ShaderFX } = global.window;

const DIR = path.join(__dirname, '..', 'src', 'renderer', 'shaders');
const catalogue = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));

/** The JSON header of an ISF file. */
function header(src) {
  return JSON.parse(/\/\*([\s\S]*?)\*\//.exec(src)[1]);
}

test('every catalogue entry is a readable ISF file with a parseable header', () => {
  assert.ok(catalogue.length >= 10, `only ${catalogue.length} shaders`);
  const names = new Set();
  for (const entry of catalogue) {
    assert.ok(!names.has(entry.name), `${entry.name} listed twice`);
    names.add(entry.name);
    const src = fs.readFileSync(path.join(DIR, entry.file), 'utf8');
    const h = header(src);
    assert.ok(Array.isArray(h.INPUTS), `${entry.name} has no INPUTS`);
    assert.match(src, /gl_FragColor/, `${entry.name} never writes a colour`);
    // A generator, not a filter: there is no input image to give it.
    assert.ok(!h.INPUTS.some((i) => i.NAME === 'inputImage'), `${entry.name} is a filter`);
  }
});

test('every drive mapping names an input the shader actually has', () => {
  for (const entry of catalogue.filter((e) => e.drive)) {
    const h = header(fs.readFileSync(path.join(DIR, entry.file), 'utf8'));
    const declared = new Set(h.INPUTS.map((i) => i.NAME));
    for (const name of Object.keys(entry.drive)) {
      assert.ok(declared.has(name), `${entry.name} drives "${name}", which it does not declare`);
    }
  }
});

test('every shader look names a shader in the catalogue', () => {
  const names = new Set(catalogue.map((e) => e.name));
  for (const preset of VisualPresets.all.filter((p) => p.engine === 'isf' && p.shader)) {
    assert.ok(names.has(preset.shader), `${preset.id} names "${preset.shader}", which is not in index.json`);
  }
});

test('prepare rewrites audio inputs to images and reports them', () => {
  const src = '/*{"INPUTS":[{"NAME":"w","TYPE":"audio"},{"NAME":"f","TYPE":"audioFFT"},{"NAME":"k","TYPE":"float"}]}*/\nvoid main(){}';
  const out = ShaderFX.prepare(src);
  assert.deepEqual(out.audio, { audio: ['w'], audioFFT: ['f'] });
  const h = header(out.src);
  assert.deepEqual(h.INPUTS.map((i) => i.TYPE), ['image', 'image', 'float']);
  assert.match(out.src, /void main\(\)\{\}$/);
});

test('prepare passes a header it cannot parse through untouched', () => {
  const src = '/* not json */ void main(){}';
  assert.equal(ShaderFX.prepare(src).src, src);
});

test('the vendored Vidvox shaders keep their MIT licence beside them', () => {
  const license = fs.readFileSync(path.join(DIR, 'vidvox', 'LICENSE'), 'utf8');
  assert.match(license, /MIT License/);
});
