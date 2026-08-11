'use strict';

/*
  Per-line artist attribution (src/main/attribute.js).

  The network call is not testable without a provider key, and mocking one would
  only assert that the mock was called. What matters here is everything AROUND
  the call, because this feature's whole justification is that being confidently
  wrong is worse than making no claim:

    - the lineup parser, which decides how many dancers are even in play;
    - the validator, which is the only thing standing between a malformed model
      response and the wrong artist being shown for a whole verse;
    - the run smoother, which is what stops a single slipped line from flashing
      a dancer onto the mic for one second.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitArtists, normaliseSingers, smoothRuns, attributeLines, MAX_ARTISTS,
} = require('../src/main/attribute');

/* --- the lineup --- */

test('the credit shapes the sources actually produce all split', () => {
  assert.deepEqual(splitArtists('John Summit, The Chainsmokers, Ilsey'),
    ['John Summit', 'The Chainsmokers', 'Ilsey']);
  assert.deepEqual(splitArtists('Seedhe Maut & Prabh Deep'), ['Seedhe Maut', 'Prabh Deep']);
  assert.deepEqual(splitArtists('Drake feat. 21 Savage'), ['Drake', '21 Savage']);
  assert.deepEqual(splitArtists('Diplo x Skrillex'), ['Diplo', 'Skrillex']);
  assert.deepEqual(splitArtists('Eminem ft. Dido'), ['Eminem', 'Dido']);
});

test('a solo artist stays one artist', () => {
  // Anything unrecognised must stay whole. A lineup that is too short asks a
  // smaller question; a lineup that split one name in half asks nonsense.
  assert.deepEqual(splitArtists('Deadmau5'), ['Deadmau5']);
  assert.deepEqual(splitArtists('Earth, Wind & Fire').length > 1, true,
    'a comma is a split even when the band name contains one — accepted cost');
  assert.deepEqual(splitArtists(''), []);
  assert.deepEqual(splitArtists(null), []);
});

test('the same name twice is one artist', () => {
  // A repeat would give the model two indices pointing at one dancer.
  assert.deepEqual(splitArtists('Karan Aujla & karan aujla'), ['Karan Aujla']);
});

test('an enormous lineup is capped', () => {
  const credit = Array.from({ length: 20 }, (_, i) => `Artist ${i}`).join(', ');
  assert.equal(splitArtists(credit).length, MAX_ARTISTS);
});

/* --- validating what the model said --- */

test('a wrong-length answer is rejected outright', () => {
  // Accepting it would align the wrong lines to the wrong people for the rest
  // of the song, which is exactly the failure this feature exists to fix.
  assert.throws(() => normaliseSingers(4, [0, 1, 0], 2), /mismatch/);
  assert.throws(() => normaliseSingers(4, null, 2), /mismatch/);
  assert.throws(() => normaliseSingers(4, [0, 1, 0, 1, 0], 2), /mismatch/);
});

test('an index outside the lineup becomes unknown, not a wrong artist', () => {
  assert.deepEqual(normaliseSingers(5, [0, 1, 7, -3, 1], 2), [0, 1, -1, -1, 1]);
});

test('a missing answer never becomes artist zero', () => {
  // Number(null) and Number(false) are both 0, so a naive coercion turns "no
  // answer" into "the first artist sings this line" — the confident-and-wrong
  // outcome this module exists to remove. A numeric string is a loose
  // provider, not a missing answer, and is still accepted.
  assert.deepEqual(normaliseSingers(5, ['0', 1.5, null, undefined, false], 2),
    [0, -1, -1, -1, -1]);
});

/* --- smoothing --- */

test('a single slipped line is absorbed into the verse around it', () => {
  // On screen this is a dancer flashing onto the mic for one line and back,
  // which reads as a bug whether or not the model was right.
  assert.deepEqual(smoothRuns([0, 0, 0, 1, 0, 0, 0]), [0, 0, 0, 0, 0, 0, 0]);
});

test('a real handoff survives', () => {
  const verses = [0, 0, 0, 0, 1, 1, 1, 1];
  assert.deepEqual(smoothRuns(verses), verses);
});

test('a leading short run stands, having nothing before it', () => {
  assert.deepEqual(smoothRuns([1, 0, 0, 0, 0]), [1, 0, 0, 0, 0]);
});

test('smoothing tolerates empty and single-line input', () => {
  assert.deepEqual(smoothRuns([]), []);
  assert.deepEqual(smoothRuns([0]), [0]);
  assert.deepEqual(smoothRuns(null), []);
});

test('alternating lines collapse rather than strobing', () => {
  // Line-by-line alternation is almost never how a song is performed, and it
  // is the worst thing to render.
  assert.deepEqual(smoothRuns([0, 1, 0, 1, 0, 1]), [0, 0, 0, 0, 0, 0]);
});

/* --- the guard rails on the pass itself --- */

test('a solo artist is never sent to a provider', async () => {
  // There is no question to ask, and asking costs a request per song.
  const cues = [{ text: 'one' }, { text: 'two' }];
  assert.equal(await attributeLines(cues, { title: 'x', artist: 'Deadmau5' }), null);
});

test('no lyrics means no request', async () => {
  assert.equal(await attributeLines([], { title: 'x', artist: 'A & B' }), null);
  assert.equal(await attributeLines(null, { title: 'x', artist: 'A & B' }), null);
});
