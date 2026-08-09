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
