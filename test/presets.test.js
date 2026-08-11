'use strict';

/*
  Unit tests for the visual presets (src/renderer/presets.js).

  Browser IIFE attaching to `window`, touching nothing else.

  The behaviour worth pinning down is the invariant that made this file worth
  having: a preset's layer flags must COMPLETELY describe what it draws. Heatmap
  once carried `bare: true` and then undrew it mid-frame, which silently cost it
  every reactive layer; these tests exist so a new layer cannot switch itself on
  somewhere it was never designed, and so `bare` stays the property of exactly
  one preset.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/presets.js');
const VisualPresets = global.window.VisualPresets;

test('every preset declares the complete layer set', () => {
  // A preset that merely omits a key must read as "off", so adding a layer
  // later cannot silently enable it everywhere.
  for (const preset of VisualPresets.all) {
    for (const key of VisualPresets.LAYER_KEYS) {
      assert.equal(typeof preset.layers[key], 'boolean',
        `${preset.id} is missing layer "${key}"`);
    }
  }
});

test('ghost is the only bare preset', () => {
  // `bare` removes the 2D canvas from the page entirely. Anything else that
  // claims it loses every layer drawn on that canvas.
  const bare = VisualPresets.all.filter((p) => p.bare).map((p) => p.id);
  assert.deepEqual(bare, ['ghost']);
});

test('a bare preset draws no 2D layers at all', () => {
  const ghost = VisualPresets.byId('ghost');
  const on = VisualPresets.LAYER_KEYS.filter((k) => ghost.layers[k]);
  assert.deepEqual(on, [], `ghost would draw ${on.join(',')} onto a hidden canvas`);
});

test('the wormhole layer belongs to the wormhole preset and nothing else', () => {
  const withIt = VisualPresets.all.filter((p) => p.layers.wormhole).map((p) => p.id);
  assert.deepEqual(withIt, ['wormhole']);
});

test('soloLayer is a weaker relative of bare, and never the same preset', () => {
  // `bare` removes the 2D canvas from the page, so a preset that must DRAW
  // something cannot use it. Solo keeps the canvas and suppresses the extras.
  // A preset claiming both would be incoherent.
  for (const preset of VisualPresets.all) {
    assert.ok(!(preset.bare && preset.soloLayer),
      `${preset.id} claims both bare and soloLayer`);
    assert.equal(typeof preset.soloLayer, 'boolean', `${preset.id} lacks soloLayer`);
  }
});

test('a solo preset names exactly the layer it draws', () => {
  const solo = VisualPresets.all.filter((p) => p.soloLayer);
  assert.deepEqual(solo.map((p) => p.id), ['wormhole']);
  for (const preset of solo) {
    const on = VisualPresets.LAYER_KEYS.filter((k) => preset.layers[k]);
    assert.equal(on.length, 1, `${preset.id} is solo but draws ${on.join(',')}`);
  }
});

test('transparentBg is declared by every preset, and only claimed by wormhole', () => {
  // Same invariant as `bare` and `soloLayer`: an omitted flag must read as
  // false, so a preset written today cannot inherit a background policy added
  // tomorrow. The flag suppresses the GPU field, which is NOT a layer flag and
  // therefore renders under every look that does not opt out.
  for (const preset of VisualPresets.all) {
    assert.equal(typeof preset.transparentBg, 'boolean',
      `${preset.id} lacks transparentBg`);
  }
  const clear = VisualPresets.all.filter((p) => p.transparentBg).map((p) => p.id);
  assert.deepEqual(clear, ['wormhole']);
});

test('a transparent-background preset still draws something', () => {
  // Combining `transparentBg` with `bare` would remove the 2D canvas AND the
  // field, leaving a look with no picture at all — Ghost with extra steps.
  for (const preset of VisualPresets.all.filter((p) => p.transparentBg)) {
    assert.ok(!preset.bare, `${preset.id} claims both transparentBg and bare`);
    const on = VisualPresets.LAYER_KEYS.filter((k) => preset.layers[k]);
    assert.ok(on.length > 0, `${preset.id} has a transparent background and no layers`);
  }
});

test('the learned-song layers reach the presets that need them', () => {
  // Vinyl shows the record; the timeline underneath says where in the song it
  // sits, so Vinyl carries the heatmap layer too.
  assert.equal(VisualPresets.byId('heatmap').layers.heatmap, true);
  assert.equal(VisualPresets.byId('vinyl').layers.vinyl, true);
  assert.equal(VisualPresets.byId('vinyl').layers.heatmap, true);
  assert.equal(VisualPresets.byId('stage').layers.stage, true);
});

test('byId falls back to the default rather than returning nothing', () => {
  assert.equal(VisualPresets.byId('no-such-preset').id, VisualPresets.DEFAULT_ID);
  assert.equal(VisualPresets.byId(undefined).id, VisualPresets.DEFAULT_ID);
});

test('next cycles through every preset and comes back round', () => {
  const seen = new Set();
  let id = VisualPresets.DEFAULT_ID;
  for (let i = 0; i < VisualPresets.all.length; i += 1) {
    id = VisualPresets.next(id).id;
    seen.add(id);
  }
  assert.equal(seen.size, VisualPresets.all.length, 'the cycle must reach them all');
  assert.equal(id, VisualPresets.DEFAULT_ID, 'and return to where it started');
});

test('the random pool excludes the two modes you choose deliberately', () => {
  const ids = VisualPresets.RANDOM_POOL.map((p) => p.id);
  assert.ok(!ids.includes('ghost'), 'ghost is a mode you pick, not one you are handed');
  assert.ok(!ids.includes('minimal'), 'minimal is the performance fallback, not a look');
  assert.ok(ids.includes('wormhole'));
  assert.ok(ids.includes('vinyl'));
});

test('forTrack is stable for a track and spread across tracks', () => {
  const a = VisualPresets.forTrack('Seedhe Maut|Nazar').id;
  assert.equal(VisualPresets.forTrack('Seedhe Maut|Nazar').id, a,
    'the same song must look the same every time');
  const spread = new Set();
  for (let i = 0; i < 60; i += 1) spread.add(VisualPresets.forTrack(`artist ${i}|title ${i}`).id);
  assert.ok(spread.size > 2, `expected variety across tracks, got ${[...spread].join(',')}`);
});

test('affordable substitutes a coherent preset instead of gutting one', () => {
  const concert = VisualPresets.byId('concert');
  // Lite mode is an explicit choice, so it steps in immediately.
  assert.equal(VisualPresets.affordable(concert, 60, true).id, 'minimal');
  // Otherwise only when genuinely struggling — 41fps is smooth, and silently
  // swapping the look there is what users complained about.
  assert.equal(VisualPresets.affordable(concert, 41, false).id, 'concert');
  assert.equal(VisualPresets.affordable(concert, 20, false).id, 'minimal');
  // A cheap preset is never downgraded, however bad things get.
  const ghost = VisualPresets.byId('ghost');
  assert.equal(VisualPresets.affordable(ghost, 5, true).id, 'ghost');
});
