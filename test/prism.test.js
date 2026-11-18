'use strict';

/*
  The mode families (presets.js FAMILIES) and the Prism library (prism.js).

  What matters: ◈ walks a short fixed cycle of modes and every look lands in
  exactly one of them, so nothing becomes unreachable; and a Prism id is
  stable form-warp-palette text, so a saved choice keeps meaning the same
  mode, and every mode's params stay inside what prism.fs branches on.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/renderer/presets.js');
require('../src/renderer/prism.js');
const VP = global.window.VisualPresets;
const Prism = global.window.PrismLibrary;

test('◈ cycles the four modes in order and wraps', () => {
  const ids = VP.FAMILIES.map((f) => f.id);
  assert.deepEqual(ids, ['overlay', 'milkdrop', 'shaders', 'prism']);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(VP.nextFamily(ids[i]).id, ids[(i + 1) % ids.length]);
  }
});

test('every look belongs to exactly one mode, and each mode default is a real look', () => {
  for (const p of VP.all) {
    const fam = VP.familyOf(p.id);
    assert.ok(VP.FAMILIES.some((f) => f.id === fam), `${p.id} has no mode`);
    assert.ok(VP.looksIn(fam).some((q) => q.id === p.id), `${p.id} not listed in ${fam}`);
  }
  for (const f of VP.FAMILIES) {
    assert.ok(VP.all.some((p) => p.id === f.defaultLook), `${f.id} default ${f.defaultLook} missing`);
    assert.equal(VP.familyOf(f.defaultLook), f.id);
  }
});

test('Prism has 500+ modes with unique, stable ids', () => {
  assert.ok(Prism.count >= 500, `only ${Prism.count}`);
  assert.equal(new Set(Prism.MODES.map((m) => m.id)).size, Prism.count);
  assert.equal(Prism.byId('3-2-1').params.form, 3);
  assert.equal(Prism.byId('3-2-1').params.warp, 2);
  assert.equal(Prism.byId('3-2-1').params.palette, 1);
  assert.equal(Prism.byId('no-such').id, Prism.MODES[0].id);
  assert.equal(Prism.byIndex(-1).id, Prism.MODES[Prism.count - 1].id);
});

test('Prism params stay inside the ranges prism.fs declares', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/shaders/prism.fs'), 'utf8');
  const meta = JSON.parse(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')));
  for (const name of ['form', 'warp', 'palette']) {
    const input = meta.INPUTS.find((i) => i.NAME === name);
    assert.ok(input, `prism.fs has no ${name} input`);
    for (const m of Prism.MODES) {
      assert.ok(m.params[name] >= input.MIN && m.params[name] <= input.MAX, `${m.id} ${name} out of range`);
    }
  }
});

test('Prism is in the catalogue as a library, so Shader Mix never draws it', () => {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/shaders/index.json'), 'utf8'));
  const entry = index.find((e) => e.file === 'prism.fs');
  assert.ok(entry && entry.library === 'prism');
  assert.deepEqual(entry.params, ['form', 'warp', 'palette']);
});
