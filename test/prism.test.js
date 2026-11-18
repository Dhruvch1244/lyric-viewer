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
  for (const name of ['form', 'warp', 'palette', 'form2', 'warp2', 'palette2']) {
    const input = meta.INPUTS.find((i) => i.NAME === name);
    assert.ok(input, `prism.fs has no ${name} input`);
    for (const m of Prism.MODES) {
      const v = m.params[name.replace('2', '')];
      assert.ok(v >= input.MIN && v <= input.MAX, `${m.id} ${name} out of range`);
    }
  }
});

test('Prism is in the catalogue as a library, so Shader Mix never draws it', () => {
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/shaders/index.json'), 'utf8'));
  const entry = index.find((e) => e.file === 'prism.fs');
  assert.ok(entry && entry.library === 'prism');
  assert.deepEqual(entry.params, ['form', 'warp', 'palette', 'form2', 'warp2', 'palette2', 'morph']);
});

test('Remix morphs to a related mode, one or two of form/warp/palette at a time', () => {
  const r = Prism.createRemix('artist|title');
  const start = r.params(0);
  assert.equal(start.morph, 0);
  assert.ok(r.trigger(10000, 'section'));
  const mid = r.params(10800);
  assert.ok(mid.morph > 0 && mid.morph < 1, `morph ${mid.morph}`);
  const changed = ['form', 'warp', 'palette'].filter((k) => mid[k] !== mid[`${k}2`]).length;
  assert.ok(changed >= 1 && changed <= 2, `${changed} dimensions changed`);
  // Settles onto the new mode.
  const done = r.params(12000);
  assert.equal(done.morph, 0);
  assert.equal(done.form, mid.form2);
  assert.equal(done.palette, mid.palette2);
});

test('Remix will not morph again within its minimum gap, and drops morph faster', () => {
  const r = Prism.createRemix('x');
  assert.ok(r.trigger(10000, 'drop'));
  assert.equal(r.trigger(12000, 'drop'), false);
  assert.equal(r.params(10900).morph, 0); // a drop's 900ms morph is finished
  assert.ok(r.trigger(16500, 'section'));
});

test('Remix is deterministic per song and keeps moving on its own', () => {
  const a = Prism.createRemix('same song');
  const b = Prism.createRemix('same song');
  assert.deepEqual(a.params(0), b.params(0));
  a.trigger(7000, 'section'); b.trigger(7000, 'section');
  assert.deepEqual(a.params(7500), b.params(7500));
  const idle = Prism.createRemix('quiet');
  assert.equal(idle.params(0).morph, 0, 'no morph on the first frame');
  assert.equal(idle.params(15000).morph, 0);
  idle.params(16000); // IDLE_MS since the first frame: starts a morph
  assert.ok(idle.params(16500).morph > 0, 'an idle song still morphs after IDLE_MS');
});
