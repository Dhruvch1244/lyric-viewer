'use strict';

/*
  Per-mood visual profiles (src/renderer/mood.js).

  The renderer application is diffuse and hard to assert on, but the
  classification is pure and is where the behaviour lives: a calm song and a
  furious one must not resolve to the same motion, free-text moods have to fall
  into sensible buckets, and energy has to break ties when no keyword matches.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/mood.js');
const { profileFor, classify, PROFILES } = global.window.MoodProfile;

test('keyword moods land in the right bucket', () => {
  assert.equal(classify('melancholic', 0.4), 'calm');
  assert.equal(classify('euphoric anthem', 0.7), 'energetic');
  assert.equal(classify('dark and driving', 0.6), 'dark');
  assert.equal(classify('warm and hopeful', 0.5), 'bright');
});

test('the intense buckets win over the mild ones', () => {
  // "dark" is checked before "calm"/"bright" on purpose: a "dark, heavy,
  // brooding" song is not calm even if it is slow.
  assert.equal(classify('heavy brooding', 0.3), 'dark');
  // "aggressive" is dark, not energetic, even though it is high-energy.
  assert.equal(classify('aggressive', 0.9), 'dark');
});

test('no keyword falls back to energy, with a wide neutral band', () => {
  assert.equal(classify('', 0.8), 'energetic');
  assert.equal(classify('', 0.2), 'calm');
  assert.equal(classify('', 0.45), 'neutral');
  assert.equal(classify('somethingunmapped', 0.45), 'neutral');
});

test('neutral changes nothing', () => {
  const p = profileFor('', 0.4);
  assert.equal(p.key, 'neutral');
  assert.equal(p.motion, 1);
  assert.equal(p.turbulence, 1);
  assert.equal(p.flicker, 1);
  assert.equal(p.warmth, 0);
});

test('calm and energetic pull motion in opposite directions', () => {
  const calm = profileFor('mellow', 0.2);
  const hype = profileFor('euphoric', 0.9);
  assert.ok(calm.motion < 0.85, `calm motion too high: ${calm.motion}`);
  assert.ok(hype.motion > 1.3, `energetic motion too low: ${hype.motion}`);
  assert.ok(hype.motion > calm.motion * 1.5);
});

test('energy blends within a bucket', () => {
  // Two calm songs of different energy differ, but both stay calm-ish.
  const low = profileFor('calm', 0.1);
  const high = profileFor('calm', 0.5);
  assert.equal(low.key, 'calm');
  assert.equal(high.key, 'calm');
  assert.ok(high.motion > low.motion, 'higher energy should move a touch more');
});

test('motion is clamped to a sane range', () => {
  for (const e of [-1, 0, 0.5, 1, 2, NaN]) {
    const p = profileFor('euphoric', e);
    assert.ok(p.motion >= 0.4 && p.motion <= 2, `out of range at energy ${e}: ${p.motion}`);
  }
});

test('warmth is cool for dark, warm for bright', () => {
  assert.ok(profileFor('dark', 0.5).warmth < 0);
  assert.ok(profileFor('bright', 0.5).warmth > 0);
});

test('every profile carries the full knob set', () => {
  for (const [key, p] of Object.entries(PROFILES)) {
    assert.equal(p.key, key);
    for (const knob of ['motion', 'turbulence', 'flicker', 'warmth']) {
      assert.equal(typeof p[knob], 'number', `${key}.${knob} missing`);
    }
  }
});
