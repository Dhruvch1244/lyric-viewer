'use strict';

/*
  Unit tests for the Studio look's "programming" logic (src/renderer/studio.js):
  how a step is written from what was heard in it. Like sprites.js it is a
  browser IIFE on `window` that only touches a canvas inside draw(), so a bare
  `window` stub is enough to test the pure parts.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/studio.js');
const S = global.window.StudioView;

const KICK = S.ROWS.indexOf('Kick');
const HAT = S.ROWS.indexOf('Hat');
const LEAD = S.ROWS.indexOf('Lead');

/** Signals with one row set, the rest silent. */
function only(row, v) {
  const sig = [0, 0, 0, 0, 0, 0];
  sig[row] = v;
  return sig;
}

test('a kick heard during a step is written to that step', () => {
  const st = S.createState();
  S.observe(st, only(KICK, 0.9));
  S.commitStep(st, 4);
  assert.ok(st.pattern[KICK][4] > 0.5, 'the kick pad is lit');
  assert.equal(st.pattern[HAT][4], 0, 'nothing else is');
});

test('a quiet step clears what the last bar wrote there', () => {
  const st = S.createState();
  S.observe(st, only(KICK, 0.9));
  S.commitStep(st, 0);
  S.observe(st, only(KICK, 0.05));
  S.commitStep(st, 0);
  assert.equal(st.pattern[KICK][0], 0);
});

test('a steady hi-hat band is not a hit, a jump in it is', () => {
  const st = S.createState();
  // Settle the hat row's running average on a constant level. Its first
  // frames are a real rise from silence, so that step is committed and
  // discarded; the check is on a step that only ever hears the held level.
  for (let i = 0; i < 200; i += 1) S.observe(st, only(HAT, 0.3));
  S.commitStep(st, 0);
  for (let i = 0; i < 10; i += 1) S.observe(st, only(HAT, 0.3));
  S.commitStep(st, 1);
  assert.equal(st.pattern[HAT][1], 0, 'a held level is not an onset');
  S.observe(st, only(HAT, 0.6));
  S.commitStep(st, 2);
  assert.ok(st.pattern[HAT][2] > 0, 'a rise above the average is');
});

/** One bar at a steady loudness. */
function bar(st, level) {
  for (let i = 0; i < S.STEPS; i += 1) {
    S.observe(st, [0, 0, 0, 0, 0, 0], level);
    S.commitStep(st, i);
  }
}

test('a song that builds reads intro, verse, drop', () => {
  const st = S.createState();
  bar(st, 0.4);
  bar(st, 0.5);
  bar(st, 0.85);
  bar(st, 0.65);
  bar(st, 0);
  // 0.65 right after a 0.85 drop is ~79% of the (slowly fading) peak: Chorus.
  assert.deepEqual(st.clips.map((c) => c.label), ['Intro', 'Verse', 'Drop', 'Chorus', 'Intro']);
});

test('a quietly mastered song still gets a drop once it has been heard', () => {
  // A third of the level: the loud-bar reference fades to the song's own peak.
  const st = S.createState();
  for (let i = 0; i < 40; i += 1) bar(st, 0.8 / 3);
  bar(st, 0.65 / 3);
  const labels = st.clips.map((c) => c.label);
  assert.equal(labels[labels.length - 2], 'Drop');
  assert.equal(labels[labels.length - 1], 'Chorus');
});

test('a held pitch extends one note, a new pitch starts another', () => {
  const st = S.createState();
  for (const midi of [60, 60, 60, 64]) {
    st.pitchAcc = { midi, vel: 0.8 };
    S.observe(st, only(LEAD, 0.6));
    S.commitStep(st, 0);
  }
  assert.deepEqual(st.notes.map((n) => [n.midi, n.len]), [[60, 3], [64, 1]]);
});

test('pitchOf reads a spectral peak as the right note', () => {
  // A 440Hz peak at 48kHz / 1024: bin 9.39, between bins 9 and 10.
  const freq = new Uint8Array(512);
  freq[8] = 60; freq[9] = 220; freq[10] = 180; freq[11] = 40;
  assert.equal(S.pitchOf(freq, 48000), 69, 'A4');
  assert.equal(S.pitchOf(new Uint8Array(512), 48000), -1, 'silence is no note');
});
