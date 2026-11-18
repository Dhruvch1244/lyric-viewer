'use strict';

/*
  The Scene Director (src/renderer/director.js).

  Pinned down: every scene it names exists (a typo in a shader name would be
  a black screen on every drop), the section's character is respected
  (drops are never calm, intros never lasers), and the direction is the same
  for the same song so a favourite plays back the way it looked.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/renderer/presets.js');
require('../src/renderer/prism.js');
require('../src/renderer/director.js');
const { Director, VisualPresets, PrismLibrary } = global.window;

const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/shaders/index.json'), 'utf8'));
const shaderNames = new Set(catalogue.filter((e) => !e.library).map((e) => e.name));

const songs = Array.from({ length: 40 }, (_, i) => `artist ${i}|title ${i}`);
const moods = ['calm', 'energetic', 'dark', 'bright', 'neutral', undefined];
const genres = ['metal', 'jazz', 'pop', undefined];

function* plans() {
  for (const trackKey of songs) {
    for (const kind of Director.kinds) {
      for (const mood of moods) {
        for (const genre of genres) {
          yield { q: { trackKey, kind, startMs: 30000, mood, genre }, p: Director.plan({ trackKey, kind, startMs: 30000, mood, genre }) };
        }
      }
    }
  }
}

test('every scene the Director names exists', () => {
  for (const { q, p } of plans()) {
    assert.ok(VisualPresets.all.some((l) => l.id === p.look), `${q.kind}: no look ${p.look}`);
    if (p.shader) assert.ok(shaderNames.has(p.shader), `${q.kind}: no shader "${p.shader}"`);
    if (p.prism) assert.equal(PrismLibrary.byId(p.prism).id, p.prism, `${q.kind}: no Prism mode ${p.prism}`);
    assert.notEqual(p.look, 'milkdrop', 'MilkDrop is too slow to switch per section');
  }
});

test('drops hit hard and quiet sections stay quiet', () => {
  const calmOverlay = new Set(Director.CALM_OVERLAY);
  const dropShaders = new Set([...Director.SHADERS.drop, ...Director.SHADERS.hardDrop]);
  for (const { q, p } of plans()) {
    if (q.kind === 'drop') {
      assert.ok(!calmOverlay.has(p.look), `a drop got the calm look ${p.look}`);
      if (p.shader) assert.ok(dropShaders.has(p.shader), `a drop got ${p.shader}`);
    }
    if (q.kind === 'intro' || q.kind === 'outro' || q.kind === 'break') {
      assert.ok(!p.shader, `a ${q.kind} got the shader ${p.shader}`);
    }
  }
});

test('the same song is directed the same way, different sections differently', () => {
  const q = { trackKey: 'a|b', kind: 'verse', startMs: 42000, mood: 'bright' };
  assert.deepEqual(Director.plan(q), Director.plan({ ...q }));
  const seen = new Set();
  for (let s = 0; s < 20; s += 1) seen.add(JSON.stringify(Director.plan({ ...q, startMs: s * 15000 })));
  assert.ok(seen.size > 3, `only ${seen.size} different verse scenes across 20 sections`);
});

test('genre sets how hard a drop goes', () => {
  assert.equal(Director.intensityFor('Heavy Metal'), 'hard');
  assert.equal(Director.intensityFor('lo-fi hip hop'), 'soft');
  assert.equal(Director.intensityFor('Bollywood'), 'normal');
  assert.equal(Director.intensityFor(null), 'normal');
  for (const s of songs) {
    const p = Director.plan({ trackKey: s, kind: 'drop', startMs: 1000, genre: 'jazz' });
    assert.equal(p.look, 'prism', 'a soft-genre drop is Prism, not lasers');
  }
});
