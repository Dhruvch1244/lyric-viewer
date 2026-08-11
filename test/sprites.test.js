'use strict';

/*
  Unit tests for the artist-sprite registry/parsing logic (src/renderer/sprites.js).

  Like beatmap.js, this is a browser IIFE that attaches to `window`. It only uses
  `document` inside the per-frame draw path (never at load time), so a bare
  `window` stub is enough to require it and test the pure parsing/recolour logic.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/sprites.js');
const ArtistSprites = global.window.ArtistSprites;

test('splitArtists handles the common collaborator separators', () => {
  assert.deepEqual(ArtistSprites.splitArtists('Seedhe Maut x DJ SA'), ['Seedhe Maut', 'DJ SA']);
  assert.deepEqual(ArtistSprites.splitArtists('A feat. B'), ['A', 'B']);
  assert.deepEqual(ArtistSprites.splitArtists('A & B, C'), ['A', 'B', 'C']);
  assert.deepEqual(ArtistSprites.splitArtists(''), []);
});

test('splitArtists de-duplicates repeated names case-insensitively', () => {
  assert.deepEqual(ArtistSprites.splitArtists('A x A'), ['A']);
});

test('actorsFor expands a known group into its branded members', () => {
  const { label, actors } = ArtistSprites.actorsFor('Seedhe Maut');
  assert.equal(label, 'Seedhe Maut');
  assert.equal(actors.length, 2);
  assert.deepEqual(actors.map((a) => a.name), ['Encore ABJ', 'Calm']);
});

test('actorsFor generates a single procedural dancer for an unknown artist', () => {
  const { actors } = ArtistSprites.actorsFor('Nobody Special');
  assert.equal(actors.length, 1);
  assert.equal(actors[0].look.procedural, true);
});

test('recolorFromArt themes procedural dancers but leaves branded looks intact', () => {
  const procedural = ArtistSprites.actorsFor('Nobody Special').actors;
  ArtistSprites.recolorFromArt(procedural, ['#ff0000', '#00ff00']);
  assert.equal(procedural[0].look.accent, '#ff0000');
  assert.equal(procedural[0].look.hoodie, '#00ff00');

  const branded = ArtistSprites.actorsFor('Seedhe Maut').actors;
  ArtistSprites.recolorFromArt(branded, ['#ff0000', '#00ff00']);
  assert.equal(branded[0].look.accent, '#ffcf3f'); // Encore ABJ's branded accent, unchanged
  assert.equal(branded[1].look.accent, '#39e6c8'); // Calm's branded accent, unchanged
});

test('recolorFromArt ignores calls without at least two colours', () => {
  const actors = ArtistSprites.actorsFor('Nobody Special').actors;
  const before = actors[0].look.accent;
  ArtistSprites.recolorFromArt(actors, ['#ff0000']); // too few colours → no-op
  assert.equal(actors[0].look.accent, before);
});

/* ------------------------------------------------- beat-locked choreography */

/** An envelope with the app's beat clock locked at a given phase. */
const beatEnv = (beatPhase, extra = {}) => ({
  intensity: 0.3,
  pulse: 0,
  drop: 0,
  buildup: 0,
  anticipation: 0,
  beat: 0,
  beatPhase,
  beatPeriodMs: 500,
  tempoLocked: true,
  ...extra,
});

test('a locked dancer advances one beat per phase wrap, not per second', () => {
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  actor.update(1000, beatEnv(0));
  actor.update(1250, beatEnv(0.5));
  assert.ok(Math.abs(actor.beats - 0.5) < 1e-9, `got ${actor.beats}`);

  // Phase wraps back past zero: that is the next downbeat, whatever the clock
  // time between the two frames happened to be.
  actor.update(1500, beatEnv(0.02));
  assert.ok(Math.abs(actor.beats - 1.02) < 1e-9, `got ${actor.beats}`);
});

test('an unlocked dancer falls back to its own free-running tempo', () => {
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  const free = { ...beatEnv(0), tempoLocked: false };
  actor.update(1000, free);
  actor.update(2000, free);      // one second later
  assert.ok(actor.beats > 0, 'it still dances with no measured tempo');
  assert.ok(actor.beats < 2, `~1 cycle/sec, got ${actor.beats}`);
});

/* pose() fills and returns a REUSED object — it runs once per dancer per frame
   and allocating there was measurable GC pressure. Callers must consume it
   within the frame; these tests snapshot because they compare across calls. */
const snapshot = (p) => ({ ...p });

test('the pose repeats exactly once per beat when locked', () => {
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  actor.move = 'bob';
  actor.beats = 4;
  const onBeat = snapshot(actor.pose(0, beatEnv(0)));
  actor.beats = 5;               // exactly one beat later
  const nextBeat = snapshot(actor.pose(0, beatEnv(0)));
  assert.ok(Math.abs(onBeat.dy - nextBeat.dy) < 1e-9, 'same point in the cycle');

  // A quarter beat later, not a half: the bob is a sine, so it passes through
  // the same height at the half-beat and that would prove nothing.
  actor.beats = 4.25;
  assert.ok(Math.abs(actor.pose(0, beatEnv(0)).dy - onBeat.dy) > 1e-6);
});

test('anticipation coils the dancer down and drops its arms', () => {
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  actor.move = 'pump';           // a move that raises an arm
  actor.beats = 0.25;            // away from zero so the base pose is non-trivial
  const calm = snapshot(actor.pose(0, beatEnv(0.25)));
  const coiled = snapshot(actor.pose(0, beatEnv(0.25, { anticipation: 0.9 })));
  assert.ok(coiled.dy > calm.dy, 'sinks toward the floor');
  assert.ok(coiled.sq < calm.sq, 'and compresses');
  assert.ok(coiled.armR < calm.armR, 'arms come down as the body gathers');
});

test('a gathering troupe steers toward the middle of the stage', () => {
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  actor.active = true;
  actor.update(1000, beatEnv(0));                                  // settle
  actor.update(1016, beatEnv(0.1, { anticipation: 0.9 }));         // drop is coming
  assert.equal(actor.gathering, true);
  assert.ok(Math.abs(actor.tx - 0.5) <= 0.12, `target ${actor.tx} should be central`);
});

test('setBand confines the dancers and rejects an inverted band', () => {
  ArtistSprites.setBand(0.80, 0.92);
  const [actor] = ArtistSprites.actorsFor('Nobody Special').actors;
  actor.y = 0.10;                                 // well above the band
  actor.update(1000, beatEnv(0));
  assert.ok(actor.y >= 0.80, `clamped into the band, got ${actor.y}`);

  ArtistSprites.setBand(0.9, 0.2);                // inverted — must be ignored
  actor.y = 0.99;
  actor.update(1016, beatEnv(0));
  assert.ok(actor.y <= 0.92, 'the previous band still applies');

  ArtistSprites.setBand(0.60, 0.96);              // restore the default
});

/* ------------------------------------------------------------ sprite shapes */
/*
  Colour alone was not enough to tell artists apart. At ~40 pixels tall a
  recoloured identical figure reads as the same dancer, so a library of a dozen
  artists looked like one person in a dozen shirts. Procedural looks now vary
  their silhouette too, and these pin down the invariants that keeps safe.
*/

test('every head style produces a grid of the same size', () => {
  // The draw code positions feet, nameplate and ground shadow off GRID_H, so a
  // variant that changed the height would silently misplace all three.
  for (const head of ArtistSprites.HEAD_IDS) {
    const grid = ArtistSprites.gridFor({ head });
    assert.equal(grid.length, ArtistSprites.GRID_H, `${head} changed the height`);
    for (const row of grid) {
      assert.equal(row.length, ArtistSprites.GRID_W, `${head} changed the width`);
    }
  }
});

test('glasses do not change the grid size either', () => {
  const grid = ArtistSprites.gridFor({ head: 'cap', glasses: true });
  assert.equal(grid.length, ArtistSprites.GRID_H);
  assert.equal(grid[0].length, ArtistSprites.GRID_W);
});

test('an unknown head style falls back to the cap rather than an empty sprite', () => {
  // Looks are persisted indirectly (via the registry and album recolouring) and
  // a typo must not produce an invisible dancer.
  assert.deepEqual(ArtistSprites.gridFor({ head: 'nonsense' }), ArtistSprites.gridFor({}));
});

test('head styles actually differ from one another', () => {
  const seen = new Set();
  for (const head of ArtistSprites.HEAD_IDS) {
    seen.add(ArtistSprites.gridFor({ head }).join('\n'));
  }
  assert.equal(seen.size, ArtistSprites.HEAD_IDS.length, 'two head styles are identical');
});

test('the cache key includes geometry, not just colours', () => {
  /*
    Two artists can easily share a palette — album-art recolouring makes that
    likely rather than rare — and without the geometry in the key the second
    would be served the first one's bitmap and wear the wrong hat.
  */
  const base = { skin: '#a', cap: '#b', brim: '#c', hoodie: '#d', hoodieDark: '#e',
    accent: '#f', pants: '#g', shoe: '#h' };
  const capped = ArtistSprites.lookSig({ ...base, head: 'cap' });
  const beanie = ArtistSprites.lookSig({ ...base, head: 'beanie' });
  const specs = ArtistSprites.lookSig({ ...base, head: 'cap', glasses: true });

  assert.notEqual(capped, beanie, 'head style missing from the cache key');
  assert.notEqual(capped, specs, 'glasses missing from the cache key');
});

test('a procedural look is stable for a given name', () => {
  // An artist must look the same on every machine and every replay, with
  // nothing stored — that is the whole point of deriving it from the name.
  const a = ArtistSprites.proceduralLook('Sub Focus', ArtistSprites.hashOf('Sub Focus'));
  const b = ArtistSprites.proceduralLook('Sub Focus', ArtistSprites.hashOf('Sub Focus'));
  assert.equal(ArtistSprites.lookSig(a), ArtistSprites.lookSig(b));
});

test('procedural looks vary in shape across a real library, not only in colour', () => {
  // The actual complaint: every artist without a hand-authored entry looked the
  // same. These are the artists in the user's own play history.
  const artists = ['The Weeknd', 'Marshmello', 'Post Malone', 'Sub Focus', 'KX5',
    'Don Toliver', 'Karan Aujla', 'Hugel', 'Pritam', 'John Summit', 'Karun',
    'XXXTENTACION', 'Vishal Dadlani', 'Ownboss'];
  const heads = new Set();
  const sigs = new Set();
  for (const name of artists) {
    const look = ArtistSprites.proceduralLook(name, ArtistSprites.hashOf(name));
    heads.add(look.head);
    sigs.add(ArtistSprites.lookSig(look));
  }
  assert.equal(sigs.size, artists.length, 'two artists render identically');
  assert.ok(heads.size >= 3,
    `only ${heads.size} distinct silhouettes across ${artists.length} artists`);
});

test('the Seedhe Maut duo are two visibly different figures', () => {
  // The one entry with two dancers on stage at once: identical shapes side by
  // side read as one dancer duplicated.
  const { actors } = ArtistSprites.actorsFor('Seedhe Maut');
  assert.equal(actors.length, 2);
  assert.notEqual(actors[0].look.head, actors[1].look.head);
});

test('album-art recolouring cannot change an artist silhouette', () => {
  // Recolouring is meant to theme a dancer to the cover, not to reshape it —
  // and the shape is the part carrying the identity.
  const { actors } = ArtistSprites.actorsFor('Some Unknown Artist');
  const before = actors[0].look.head;
  ArtistSprites.recolorFromArt(actors, ['#ff0000', '#00ff00']);
  assert.equal(actors[0].look.head, before);
});
