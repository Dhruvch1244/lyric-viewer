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

/* ---- Director 2.0: live sections and cut timing ---- */

/** Run a scripted song through createLive at 60fps; returns the section log. */
function runLive(script, durationMs) {
  const live = Director.createLive();
  const log = [];
  let pos = 0;
  for (const part of script) {
    for (let t = 0; t < part.ms; t += 16) {
      const r = live.step({
        dt: 16, posMs: pos, durationMs, level: part.level,
        build: part.build || 0, drop: Boolean(part.dropAt !== undefined && t === part.dropAt),
      });
      if (r.changed || log.length === 0) log.push({ kind: r.kind, at: pos });
      pos += 16;
    }
  }
  return log;
}

const SONG = [
  { ms: 20000, level: 0.12 },                 // intro
  { ms: 40000, level: 0.35 },                 // verse
  { ms: 12000, level: 0.38, build: 0.6 },     // build
  { ms: 25000, level: 0.5, dropAt: 0 },       // drop
  { ms: 20000, level: 0.1 },                  // break
  { ms: 30000, level: 0.36 },                 // verse
];

test('live sections follow a first listen: intro, verse, build, drop, break', () => {
  const kinds = runLive(SONG, 180000).map((e) => e.kind);
  assert.equal(kinds[0], 'intro');
  for (const k of ['verse', 'build', 'drop', 'break']) assert.ok(kinds.includes(k), `missing ${k}: ${kinds}`);
  assert.ok(kinds.indexOf('build') < kinds.indexOf('drop'));
  assert.ok(kinds.indexOf('drop') < kinds.indexOf('break'));
});

test('a real drop cuts in at once', () => {
  const log = runLive(SONG, 180000);
  const drop = log.find((e) => e.kind === 'drop');
  assert.ok(drop && drop.at >= 72000 && drop.at < 72100, `drop at ${drop && drop.at}`);
});

test('live sections never flicker: each holds at least its dwell', () => {
  // Level jittering around the quiet threshold every second must not thrash.
  const jitter = Array.from({ length: 120 }, (_, i) => ({ ms: 1000, level: i % 2 ? 0.2 : 0.45 }));
  const log = runLive([{ ms: 30000, level: 0.45 }, ...jitter], 200000);
  for (let i = 1; i < log.length; i += 1) {
    const held = log[i].at - log[i - 1].at;
    const min = log[i - 1].kind === 'drop' ? Director.LIVE.dropHoldMs : Director.LIVE.dwellMs;
    assert.ok(held >= min - 16, `${log[i - 1].kind} held ${held}ms`);
  }
});

test('section cuts land on a bar line when the tempo is locked', () => {
  const P = 500;
  for (let beatCount = 0; beatCount < 8; beatCount += 1) {
    for (const clock of [0, 120, 499]) {
      const d = Director.cutDelay({ beatPeriodMs: P, beatClockMs: clock, beatCount, locked: true, leadMs: 380, kind: 'verse' });
      const beatsAhead = (clock + d) / P;
      assert.ok(Math.abs(beatsAhead - Math.round(beatsAhead)) < 1e-9, 'on a beat');
      assert.equal((beatCount + Math.round(beatsAhead)) % 4, 0, 'on a bar line');
      assert.ok(d >= 380, 'never sooner than the lead-in');
    }
  }
});

test('unlocked tempo cuts on the next beat; drops go now', () => {
  assert.equal(Director.cutDelay({ beatPeriodMs: 500, beatClockMs: 100, beatCount: 3, locked: false, leadMs: 220, kind: 'verse' }), 400);
  assert.equal(Director.cutDelay({ beatPeriodMs: 500, beatClockMs: 400, beatCount: 3, locked: false, leadMs: 220, kind: 'verse' }), 600);
  assert.equal(Director.cutDelay({ beatPeriodMs: 500, beatClockMs: 400, beatCount: 3, locked: true, leadMs: 40, kind: 'drop' }), 40);
});

test('every section kind has a transition', () => {
  for (const k of Director.kinds) {
    const t = Director.transitionFor(k);
    assert.ok(['flash', 'dip', 'glow'].includes(t.style));
  }
  assert.equal(Director.transitionFor('drop').style, 'flash');
});
