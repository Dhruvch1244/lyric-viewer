'use strict';

/*
  Mapping an attribution onto the dancers (src/renderer/sprites.js).

  This is the sharp edge of per-line attribution. The credited artists and the
  dancers on screen are two different lists: a registry group is ONE credit and
  TWO dancers, so artist 1 of 2 can be actor 2 of 3. Treating one index as the
  other puts the wrong person on the mic — which is exactly the bug the whole
  feature exists to remove, so getting it wrong inside the fix would be worse
  than not shipping it.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/sprites.js');
const ArtistSprites = global.window.ArtistSprites;

/** A stand-in for a built cast; only `credit` and `name` are consulted. */
function cast(...pairs) {
  return pairs.map(([name, credit]) => ({ name, credit }));
}

test('a registry group means artist index is not actor index', () => {
  // The case that motivates all of this: two credits, three dancers.
  const actors = cast(
    ['Encore', 'Seedhe Maut'],
    ['Calm', 'Seedhe Maut'],
    ['Prabh Deep', 'Prabh Deep'],
  );
  const mapped = ArtistSprites.mapAttribution(
    actors, ['Seedhe Maut', 'Prabh Deep'], [0, 0, 1, 1],
  );
  // Artist 1 is Prabh Deep, who is ACTOR 2. A naive mapping would say actor 1,
  // which is Calm — the wrong member of the other group.
  assert.deepEqual(mapped, [0, 0, 2, 2]);
});

test('a plain collaboration maps straight through', () => {
  const actors = cast(
    ['John Summit', 'John Summit'],
    ['The Chainsmokers', 'The Chainsmokers'],
    ['Ilsey', 'Ilsey'],
  );
  assert.deepEqual(
    ArtistSprites.mapAttribution(actors, ['John Summit', 'The Chainsmokers', 'Ilsey'], [2, 0, 1]),
    [2, 0, 1],
  );
});

test('matching ignores case and surrounding space', () => {
  const actors = cast(['Drake', '  drake '], ['21 Savage', '21 SAVAGE']);
  assert.deepEqual(
    ArtistSprites.mapAttribution(actors, ['Drake', '21 Savage'], [0, 1]),
    [0, 1],
  );
});

test('an actor is found by its own name when the credit does not match', () => {
  const actors = cast(['Prabh Deep', 'some other credit string']);
  actors.push({ name: 'Seedhe Maut', credit: '' });
  assert.deepEqual(
    ArtistSprites.mapAttribution(actors, ['Prabh Deep', 'Seedhe Maut'], [0, 1]),
    [0, 1],
  );
});

test('shared or unknown stays unknown rather than becoming a dancer', () => {
  // -1 must survive the mapping. Turning it into an index would put someone
  // arbitrary on the mic for every chorus in the song.
  const actors = cast(['A', 'A'], ['B', 'B']);
  assert.deepEqual(ArtistSprites.mapAttribution(actors, ['A', 'B'], [-1, 0, -1, 1]), [-1, 0, -1, 1]);
});

test('an artist nobody on stage matches resolves to unknown, not to actor 0', () => {
  const actors = cast(['A', 'A'], ['B', 'B']);
  const mapped = ArtistSprites.mapAttribution(actors, ['A', 'Somebody Else'], [0, 1, 0]);
  assert.deepEqual(mapped, [0, -1, 0]);
});

test('when nothing matches at all, the caller is told to keep rotating', () => {
  // A null here restores 0.20.0's behaviour, which is uninformed rather than
  // wrong. Any mapping in this situation would be a guess dressed as fact.
  const actors = cast(['X', 'X'], ['Y', 'Y']);
  assert.equal(ArtistSprites.mapAttribution(actors, ['A', 'B'], [0, 1]), null);
});

test('an out-of-range or non-integer index is unknown', () => {
  const actors = cast(['A', 'A'], ['B', 'B']);
  assert.deepEqual(
    ArtistSprites.mapAttribution(actors, ['A', 'B'], [5, -2, 1.5, 0]),
    [-1, -1, -1, 0],
  );
});

test('nothing to map returns null rather than an empty answer', () => {
  const actors = cast(['A', 'A'], ['B', 'B']);
  assert.equal(ArtistSprites.mapAttribution([], ['A', 'B'], [0]), null);
  assert.equal(ArtistSprites.mapAttribution(actors, ['A'], [0]), null, 'solo needs no mapping');
  assert.equal(ArtistSprites.mapAttribution(actors, ['A', 'B'], []), null);
  assert.equal(ArtistSprites.mapAttribution(actors, null, [0]), null);
});

/* --- and the cast really does carry its credits --- */

test('actorsFor tags every dancer with the credit it came from', () => {
  // Without this the mapping above has nothing to match on.
  const { actors } = ArtistSprites.actorsFor('Karan Aujla & Ikky');
  assert.ok(actors.length >= 2, 'expected a dancer per collaborator');
  for (const actor of actors) {
    assert.equal(typeof actor.credit, 'string');
    assert.ok(actor.credit.length > 0, 'a dancer with no credit cannot be attributed');
  }
  assert.equal(actors[0].credit, 'Karan Aujla');
});
