'use strict';

/*
  Unit tests for the artwork candidate layer (src/main/artwork.js).

  The network calls are not testable without hitting three live APIs. The two
  pure pieces are, and both matter:

    - `scoreCandidate` is shared by the automatic pick and the candidate list.
      If they ever diverge, the picker offers a "better" cover than the app
      chose on its own, which is baffling from the outside.
    - `dedupeCandidates` decides what the user actually sees. The sources
      overlap heavily, and a grid showing the same album four times hides the
      alternative they opened the panel to find.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { dedupeCandidates, scoreCandidate, MIN_MATCH_SCORE } = require('../src/main/artwork');
const { cleanTitle, versionTags } = require('../src/main/lyrics');

/** Score a candidate the way the app does, from a raw track. */
function score(candidate, track) {
  return scoreCandidate(
    candidate, track, cleanTitle(track.title), versionTags(track.title || '')
  );
}

test('an exact title and artist match scores above the acceptance threshold', () => {
  const s = score(
    { title: 'Nanchaku', artist: 'Seedhe Maut' },
    { title: 'Nanchaku', artist: 'Seedhe Maut' }
  );
  assert.ok(s >= MIN_MATCH_SCORE, `exact match scored ${s}, below ${MIN_MATCH_SCORE}`);
});

test('a different song by the same artist scores below an exact match', () => {
  const track = { title: 'Nanchaku', artist: 'Seedhe Maut' };
  const right = score({ title: 'Nanchaku', artist: 'Seedhe Maut' }, track);
  const wrong = score({ title: 'Shabd', artist: 'Seedhe Maut' }, track);
  assert.ok(wrong < right, `wrong song (${wrong}) did not score below right one (${right})`);
});

test('a live or remix cut is penalised against a studio track', () => {
  // The same guard the lyric matcher uses: a live cut carries different art.
  const track = { title: 'Nanchaku', artist: 'Seedhe Maut' };
  const studio = score({ title: 'Nanchaku', artist: 'Seedhe Maut' }, track);
  const live = score({ title: 'Nanchaku (Live)', artist: 'Seedhe Maut' }, track);
  assert.ok(live < studio, `live cut (${live}) was not penalised against studio (${studio})`);
});

test('a remix search prefers the remix', () => {
  // The penalty is symmetric — asking for a remix and being offered the studio
  // cut is just as wrong as the reverse.
  const track = { title: 'Nanchaku (Remix)', artist: 'Seedhe Maut' };
  const remix = score({ title: 'Nanchaku (Remix)', artist: 'Seedhe Maut' }, track);
  const studio = score({ title: 'Nanchaku', artist: 'Seedhe Maut' }, track);
  assert.ok(studio < remix, `studio (${studio}) outscored the requested remix (${remix})`);
});

test('an unrelated song falls below the acceptance threshold', () => {
  // This is the guard that stopped the app confidently showing another band's
  // album for an obscure track.
  const s = score(
    { title: 'Bohemian Rhapsody', artist: 'Queen' },
    { title: 'Nanchaku', artist: 'Seedhe Maut' }
  );
  assert.ok(s < MIN_MATCH_SCORE, `unrelated song scored ${s}, at or above ${MIN_MATCH_SCORE}`);
});

test('duplicates from the same source collapse to the best-scoring one', () => {
  const out = dedupeCandidates([
    { source: 'iTunes', title: 'Nanchaku', artist: 'Seedhe Maut', score: 1.2, fullUrl: 'a' },
    { source: 'iTunes', title: 'Nanchaku', artist: 'Seedhe Maut', score: 2.4, fullUrl: 'b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fullUrl, 'b');
});

test('the same album from different sources is kept', () => {
  // Two stores' scans of one cover are not identical, and offering both is a
  // real choice when one of them is a bad crop or a wrong regional variant.
  const out = dedupeCandidates([
    { source: 'iTunes', title: 'Nanchaku', artist: 'Seedhe Maut', score: 2, fullUrl: 'a' },
    { source: 'Deezer', title: 'Nanchaku', artist: 'Seedhe Maut', score: 2, fullUrl: 'b' },
  ]);
  assert.equal(out.length, 2);
});

test('deduping is case and whitespace insensitive', () => {
  // Stores disagree constantly about capitalisation and trailing spaces; a
  // duplicate that survives on that basis is a wasted tile.
  const out = dedupeCandidates([
    { source: 'iTunes', title: 'Nanchaku', artist: 'Seedhe Maut', score: 1, fullUrl: 'a' },
    { source: 'iTunes', title: '  NANCHAKU ', artist: 'seedhe maut', score: 3, fullUrl: 'b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fullUrl, 'b');
});

test('different songs are never collapsed together', () => {
  const out = dedupeCandidates([
    { source: 'iTunes', title: 'Nanchaku', artist: 'Seedhe Maut', score: 2, fullUrl: 'a' },
    { source: 'iTunes', title: 'Shabd', artist: 'Seedhe Maut', score: 2, fullUrl: 'b' },
  ]);
  assert.equal(out.length, 2);
});

test('deduping an empty list is not an error', () => {
  assert.deepEqual(dedupeCandidates([]), []);
});

test('candidates with missing fields do not crash the dedupe', () => {
  // Cover Art Archive routinely returns a recording with no artist credit.
  const out = dedupeCandidates([
    { source: 'Cover Art Archive', score: 1, fullUrl: 'a' },
    { source: 'Cover Art Archive', score: 2, fullUrl: 'b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fullUrl, 'b');
});
