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

test('a solo swirl preset names exactly the layer it draws', () => {
  // Scoped to the swirl engine on purpose. A solo MilkDrop look draws through
  // the other engine and correctly names no 2D layer at all; asserting "exactly
  // one" across both engines would be asserting the wrong thing.
  const solo = VisualPresets.all.filter((p) => p.soloLayer && p.engine === 'swirl');
  assert.deepEqual(solo.map((p) => p.id), ['wormhole']);
  for (const preset of solo) {
    const on = VisualPresets.LAYER_KEYS.filter((k) => preset.layers[k]);
    assert.equal(on.length, 1, `${preset.id} is solo but draws ${on.join(',')}`);
  }
});

test('transparentBg is declared by every preset', () => {
  // Same invariant as `bare` and `soloLayer`: an omitted flag must read as
  // false, so a preset written today cannot inherit a background policy added
  // tomorrow. The flag suppresses the GPU field, which is NOT a layer flag and
  // therefore renders under every look that does not opt out.
  for (const preset of VisualPresets.all) {
    assert.equal(typeof preset.transparentBg, 'boolean',
      `${preset.id} lacks transparentBg`);
  }
});

test('no swirl preset asks for a transparent background', () => {
  /*
    `transparentBg` belongs to the MilkDrop looks alone, where it suppresses a
    field that would otherwise draw underneath an opaque full-screen canvas.

    Wormhole carried it briefly. Watched against real music rather than in a
    screenshot, a tunnel floating on the bare desktop reads as a widget sitting
    on the screen; with the field behind it the smoke has something to be smoke
    *in*. If a swirl preset ever claims this flag again, that judgement is being
    reversed and it should be a deliberate decision rather than a stray edit.
  */
  const clear = VisualPresets.all
    .filter((p) => p.transparentBg && p.engine === 'swirl')
    .map((p) => p.id);
  assert.deepEqual(clear, []);
});

test('a transparent-background preset still draws something', () => {
  // Combining `transparentBg` with `bare` would remove the 2D canvas AND the
  // field, leaving a look with no picture at all — Ghost with extra steps.
  // What counts as "something" depends on the engine: a swirl look must name a
  // layer, a MilkDrop look IS its engine.
  for (const preset of VisualPresets.all.filter((p) => p.transparentBg)) {
    assert.ok(!preset.bare, `${preset.id} claims both transparentBg and bare`);
    if (preset.engine === 'milkdrop') {
      assert.equal(typeof preset.milkdrop, 'string', `${preset.id} draws nothing`);
      continue;
    }
    const on = VisualPresets.LAYER_KEYS.filter((k) => preset.layers[k]);
    assert.ok(on.length > 0, `${preset.id} has a transparent background and no layers`);
  }
});

test('every preset names an engine, and only known ones', () => {
  // Defaulted rather than required, so presets written before there was a
  // second engine keep working — but an unknown string must never survive
  // normalisation, or the renderer silently draws nothing.
  for (const preset of VisualPresets.all) {
    assert.ok(['swirl', 'milkdrop'].includes(preset.engine),
      `${preset.id} has engine "${preset.engine}"`);
  }
});

test('the swirl engine is still the default and the majority', () => {
  // The signature look must not be quietly demoted by adding preset packs.
  assert.equal(VisualPresets.byId(VisualPresets.DEFAULT_ID).engine, 'swirl');
  const swirl = VisualPresets.all.filter((p) => p.engine === 'swirl').length;
  assert.ok(swirl > VisualPresets.all.length / 2, 'the second engine has taken over');
});

test('every milkdrop preset names a starting preset and owns the screen', () => {
  const milk = VisualPresets.all.filter((p) => p.engine === 'milkdrop');
  assert.ok(milk.length > 0, 'no milkdrop presets registered');
  for (const preset of milk) {
    assert.equal(typeof preset.milkdrop, 'string',
      `${preset.id} has no starting preset name`);
    // The MilkDrop canvas fills the screen and is opaque, so the swirl field
    // and the 2D extras would be drawing underneath it for nothing.
    assert.equal(preset.transparentBg, true, `${preset.id} would draw the field under an opaque canvas`);
    assert.equal(preset.soloLayer, true, `${preset.id} would draw 2D extras under an opaque canvas`);
    assert.equal(preset.bare, false, `${preset.id} claims bare, which removes a canvas it needs`);
  }
});

test('every named milkdrop preset actually exists in the shipped pack', () => {
  /*
    This test earns its keep: both starting presets were originally written from
    memory, both were wrong, and nothing complained — `loadPreset` falls back to
    the pack's first entry for a name it does not recognise, so the app showed a
    preset nobody chose and looked like it was working.

    The fallback is still right (packs are versioned independently of this app,
    and a name that disappears must not black the screen), which is exactly why
    the names need checking here instead.
  */
  /* The same four packs milkdrop.html loads, merged the same way. Checking only
     the base pack would let a name that exists solely in an extra pack pass
     here and then fall back at runtime if that pack were ever dropped. */
  const available = new Set();
  for (const file of ['butterchurnPresetsMD1', 'butterchurnPresetsExtra2',
    'butterchurnPresetsExtra', 'butterchurnPresets']) {
    const pack = require(`butterchurn-presets/lib/${file}.min.js`);
    const lib = pack.default || pack;
    const presets = typeof lib.getPresets === 'function' ? lib.getPresets() : lib;
    for (const name of Object.keys(presets)) available.add(name);
  }
  assert.ok(available.size > 300, `only ${available.size} presets loaded`);

  for (const preset of VisualPresets.all.filter((p) => p.engine === 'milkdrop')) {
    assert.ok(available.has(preset.milkdrop),
      `${preset.id} names "${preset.milkdrop}", which is not in the pack`);
  }
});

test('swirl presets never carry a milkdrop preset name', () => {
  // A stray name would be dead config that looks meaningful — the next reader
  // would reasonably assume the preset switches engines.
  for (const preset of VisualPresets.all.filter((p) => p.engine === 'swirl')) {
    assert.equal(preset.milkdrop, null, `${preset.id} names a MilkDrop preset it cannot use`);
  }
});

test('second-engine looks are never handed out at random', () => {
  // A MilkDrop preset that cannot run degrades to a blank screen with lyrics on
  // it. Being handed that unasked, for a song you did not choose it for, is far
  // worse than never being offered it — so it stays a deliberate choice.
  const poolIds = VisualPresets.RANDOM_POOL.map((p) => p.id);
  for (const id of VisualPresets.SECOND_ENGINE) {
    assert.ok(!poolIds.includes(id), `${id} can be assigned at random`);
  }
  assert.ok(VisualPresets.RANDOM_POOL.length > 0, 'the random pool is empty');
});

test('the random pool is still all swirl', () => {
  for (const preset of VisualPresets.RANDOM_POOL) {
    assert.equal(preset.engine, 'swirl', `${preset.id} is in the random pool`);
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

test('forTrack with no mood key behaves exactly like today (no LLM key configured)', () => {
  // Backward-compatibility guarantee: a user with no mood data at all must
  // see the unbiased hash-across-the-full-pool result, unchanged.
  const withoutMood = VisualPresets.forTrack('Seedhe Maut|Nazar').id;
  const withNeutral = VisualPresets.forTrack('Seedhe Maut|Nazar', 'neutral').id;
  const withUnknown = VisualPresets.forTrack('Seedhe Maut|Nazar', 'not-a-real-mood').id;
  assert.equal(withNeutral, withoutMood);
  assert.equal(withUnknown, withoutMood);
});

test('forTrack stays deterministic per (track, mood) pair', () => {
  const a = VisualPresets.forTrack('Artist|Title', 'energetic').id;
  assert.equal(VisualPresets.forTrack('Artist|Title', 'energetic').id, a);
});

test('a mood-biased pick only ever lands inside that mood\'s subset', () => {
  const energeticIds = ['concert', 'starfield', 'stage', 'geometry'];
  for (let i = 0; i < 40; i += 1) {
    const id = VisualPresets.forTrack(`artist ${i}|title ${i}`, 'energetic').id;
    assert.ok(energeticIds.includes(id), `${id} is not an energetic-mood preset`);
  }
});

test('different moods can pick different looks for the exact same song', () => {
  // Not guaranteed for every possible track key, but true often enough that a
  // fixed key with genuinely different pools on each side should diverge.
  const calm = VisualPresets.forTrack('Test Artist|Test Song', 'calm').id;
  const energetic = VisualPresets.forTrack('Test Artist|Test Song', 'energetic').id;
  assert.notEqual(calm, energetic);
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
