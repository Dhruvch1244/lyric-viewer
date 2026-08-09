'use strict';

/*
  Unit tests for the learn-on-listen beat map (src/renderer/beatmap.js).

  The module is a browser IIFE that attaches to `window`; it only touches `window`
  (no DOM/canvas), so we stub a bare global `window` before requiring it, then
  exercise the recording and playback logic directly.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/beatmap.js');
const BeatMap = global.window.BeatMap;

test('BeatMap is exposed with the expected API', () => {
  assert.ok(BeatMap, 'window.BeatMap should exist');
  for (const fn of ['startRecording', 'note', 'takeRecording', 'load', 'hasPlayback', 'tick']) {
    assert.equal(typeof BeatMap[fn], 'function', `BeatMap.${fn} should be a function`);
  }
});

test('recording de-duplicates drops within the min gap and sorts them', () => {
  BeatMap.startRecording();
  BeatMap.note(1000, { drop: true, kick: 0 });
  BeatMap.note(1200, { drop: true, kick: 0 }); // within 1500ms → ignored
  BeatMap.note(3000, { drop: true, kick: 0 });
  const map = BeatMap.takeRecording();
  assert.deepEqual(map.drops, [1000, 3000]);
  assert.equal(map.duration, 3000);
});

test('recording keeps strong, well-spaced kicks and drops weak/rapid ones', () => {
  BeatMap.startRecording();
  // Eight strong, >110ms-spaced kicks clear the "worth saving" bar (>=8 kicks).
  const kept = [500, 700, 900, 1100, 1300, 1500, 1700, 1900];
  for (const t of kept) BeatMap.note(t, { drop: false, kick: 0.8 });
  BeatMap.note(560, { drop: false, kick: 0.8 });  // within 110ms of 500 → dropped
  BeatMap.note(2000, { drop: false, kick: 0.3 }); // below strength threshold → dropped
  const map = BeatMap.takeRecording();
  assert.notEqual(map, null);
  assert.equal(map.drops.length, 0);
  assert.deepEqual(map.kicks.map((k) => k.t), kept);
});

test('takeRecording returns null when nothing meaningful was captured', () => {
  BeatMap.startRecording();
  BeatMap.note(100, { drop: false, kick: 0.1 }); // too weak to log
  assert.equal(BeatMap.takeRecording(), null);
});

test('hasPlayback reflects the loaded map', () => {
  BeatMap.load(null);
  assert.equal(BeatMap.hasPlayback(), false);
  BeatMap.load({ drops: [1000], kicks: [], duration: 2000 });
  assert.equal(BeatMap.hasPlayback(), true);
});

test('tick fires crossed drops/kicks and ramps anticipation before a drop', () => {
  BeatMap.load({
    drops: [5000],
    kicks: [{ t: 4200, v: 0.8 }, { t: 4600, v: 0.9 }],
    duration: 6000,
  });

  // First tick always re-seeks (lastTickPos starts at -Infinity): no events fire.
  let ev = BeatMap.tick(4000);
  assert.deepEqual(ev, { drop: false, kick: 0, buildup: 0 });

  // Crosses the first kick; anticipation ramps toward the 5000ms drop.
  ev = BeatMap.tick(4500);
  assert.equal(ev.drop, false);
  assert.equal(ev.kick, 0.8);
  assert.ok(Math.abs(ev.buildup - (1 - 500 / 1800)) < 1e-9, `buildup was ${ev.buildup}`);

  // Crosses the drop.
  ev = BeatMap.tick(5000);
  assert.equal(ev.drop, true);
  assert.equal(ev.buildup, 0); // no further drop ahead
});

test('tick treats a large backward/forward jump as a seek and fires nothing', () => {
  BeatMap.load({ drops: [1000, 8000], kicks: [], duration: 9000 });
  BeatMap.tick(500);   // seek-in, no fire
  BeatMap.tick(1500);  // crosses the 1000ms drop normally
  const ev = BeatMap.tick(200); // big backward jump → seek, must not re-fire
  assert.deepEqual(ev, { drop: false, kick: 0, buildup: 0 });
});
