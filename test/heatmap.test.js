'use strict';

/*
  Unit tests for the song heatmap (src/renderer/heatmap.js).

  Browser IIFE attaching to `window`, touching nothing else.

  The behaviour worth pinning down is that the map is a property of the TRACK
  and not of one playthrough: binning by position, peak-holding across plays,
  and normalising against the song's own dynamics.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/heatmap.js');
const HeatMap = global.window.HeatMap;

const env = (level, bass = level, treble = level) => ({ level, bass, treble });

test('bins by position in the song, not by wall clock', () => {
  HeatMap.start(100000);           // 100s track, 96 bins
  HeatMap.note(0, env(0.5));
  HeatMap.note(99999, env(0.9));
  const c = HeatMap.cells();
  assert.equal(c.length, HeatMap.BIN_COUNT);
  assert.ok(c[0].level > 0, 'start of song should be populated');
  assert.ok(c[HeatMap.BIN_COUNT - 1].level > 0, 'end of song should be populated');
});

test('a bin keeps its PEAK, not an average', () => {
  HeatMap.start(10000);
  // Same bin, one loud moment among quiet ones. An average would bury it.
  for (let i = 0; i < 8; i += 1) HeatMap.note(50, env(0.1));
  HeatMap.note(50, env(1.0));
  for (let i = 0; i < 8; i += 1) HeatMap.note(50, env(0.1));
  assert.equal(HeatMap.cells()[0].level, 1);
});

test('peaks survive across replays of the same track', () => {
  HeatMap.start(10000);
  HeatMap.note(50, env(0.9));
  HeatMap.start(10000);            // same track again — must not reset
  HeatMap.note(50, env(0.2));
  assert.equal(HeatMap.cells()[0].level, 1, 'the earlier peak should still stand');
});

test('a different track length starts a fresh map', () => {
  HeatMap.start(10000);
  HeatMap.note(50, env(0.9));
  HeatMap.start(240000);
  assert.equal(HeatMap.cells()[0].level, 0);
});

test('cells normalise against the song own peak, not an absolute scale', () => {
  HeatMap.start(96000);            // 1s per bin
  HeatMap.note(500, env(0.2));     // bin 0
  HeatMap.note(1500, env(0.4));    // bin 1 — the loudest moment in this song
  const c = HeatMap.cells();
  assert.equal(c[1].level, 1, 'the loudest bin should read full');
  assert.ok(Math.abs(c[0].level - 0.5) < 0.01, 'others scale against it');
});

test('coverage reports how much of the song has actually been heard', () => {
  HeatMap.start(96000);
  assert.equal(HeatMap.coverage(), 0);
  for (let i = 0; i < 48; i += 1) {
    // MIN_SAMPLES per bin, or the bin does not count as known.
    HeatMap.note(i * 1000 + 500, env(0.5));
    HeatMap.note(i * 1000 + 600, env(0.5));
  }
  assert.ok(Math.abs(HeatMap.coverage() - 0.5) < 0.02, `got ${HeatMap.coverage()}`);
});

test('unheard bins are marked so a partial map can be drawn honestly', () => {
  HeatMap.start(96000);
  HeatMap.note(500, env(0.5));
  HeatMap.note(600, env(0.5));
  const c = HeatMap.cells();
  assert.equal(c[0].known, true);
  assert.equal(c[50].known, false);
});

test('load restores a saved map and rejects a malformed one', () => {
  HeatMap.start(96000);
  HeatMap.note(500, env(0.7));
  HeatMap.note(600, env(0.7));
  const saved = HeatMap.takeForSave();
  HeatMap.load(null);
  assert.equal(HeatMap.get(), null);
  HeatMap.load(saved);
  assert.ok(HeatMap.get());
  assert.equal(HeatMap.cells()[0].known, true);
  HeatMap.load({ durationMs: 1000, bins: [1, 2, 3] });   // wrong shape
  assert.equal(HeatMap.get(), null);
});

test('dirty tracks whether there is anything new to save', () => {
  HeatMap.start(96000);
  assert.equal(HeatMap.isDirty(), false);
  HeatMap.note(500, env(0.4));
  assert.equal(HeatMap.isDirty(), true);
  HeatMap.takeForSave();
  assert.equal(HeatMap.isDirty(), false);
  HeatMap.note(500, env(0.1));     // quieter than the peak — nothing learned
  assert.equal(HeatMap.isDirty(), false);
});

test('tolerates junk input', () => {
  HeatMap.start(0);
  assert.equal(HeatMap.get(), null);
  HeatMap.start(96000);
  HeatMap.note(-5, env(0.5));
  HeatMap.note(NaN, env(0.5));
  HeatMap.note(500, null);
  assert.equal(HeatMap.coverage(), 0);
});
