'use strict';

/*
  Unit tests for the NetEase lyric source (src/main/netease.js).

  The network calls are not testable without hitting a live service. The two
  pure pieces are, and both are places where being wrong corrupts a song rather
  than merely failing to improve it:

    - `toCandidate` feeds LRCLIB's scorer, which the two sources deliberately
      share. A units mistake there silently poisons the duration bonus that
      separates a remix from the studio cut.
    - `alignTranslation` decides what appears under every lyric line.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { alignTranslation, toCandidate } = require('../src/main/netease');

/** @returns {Array<{timeMs: number, text: string}>} */
function cues(...pairs) {
  return pairs.map(([timeMs, text]) => ({ timeMs, text }));
}

test('toCandidate converts duration from milliseconds to seconds', () => {
  /*
    NetEase reports milliseconds; LRCLIB reports seconds, and the shared scorer
    assumes seconds. Leaving this unconverted makes every candidate look
    thousands of seconds long, which trips the ">20s apart" penalty on every
    single result and quietly rejects the whole source.
  */
  const c = toCandidate({ name: 'X', artists: [{ name: 'A' }], duration: 215_000 }, '[00:01.00]hi');
  assert.equal(c.duration, 215);
});

test('toCandidate handles both the search and player field spellings', () => {
  // The two NetEase endpoints disagree: search returns artists/duration/album,
  // the player payload returns ar/dt/al. Both appear in the wild.
  const a = toCandidate({ name: 'X', artists: [{ name: 'A' }], duration: 1000, album: { name: 'Alb' } }, 'l');
  const b = toCandidate({ name: 'X', ar: [{ name: 'A' }], dt: 1000, al: { name: 'Alb' } }, 'l');
  assert.equal(a.artistName, 'A');
  assert.equal(b.artistName, 'A');
  assert.equal(a.albumName, 'Alb');
  assert.equal(b.albumName, 'Alb');
  assert.equal(a.duration, b.duration);
});

test('toCandidate joins multiple artists', () => {
  const c = toCandidate({ name: 'X', artists: [{ name: 'A' }, { name: 'B' }], duration: 0 }, 'l');
  assert.equal(c.artistName, 'A, B');
});

test('toCandidate carries the lyric through, because the scorer demands it', () => {
  // scoreCandidate returns -1 for any candidate without syncedLyrics.
  const c = toCandidate({ name: 'X', artists: [], duration: 0 }, '[00:01.00]hi');
  assert.equal(c.syncedLyrics, '[00:01.00]hi');
});

test('alignTranslation matches on timestamp, never on index', () => {
  /*
    This is the whole reason the function exists. NetEase translations are
    routinely shorter than the original — untranslated interjections and
    repeated hooks are simply absent — so zipping by index captions most of the
    song with the wrong line.
  */
  const original = cues([0, 'one'], [1000, 'two'], [2000, 'three'], [3000, 'four']);
  const translated = cues([0, 'ichi'], [2000, 'san'], [3000, 'shi']);

  const out = alignTranslation(original, translated);
  assert.ok(out);
  assert.equal(out.length, original.length, 'must be exactly as long as the lyric');
  assert.deepEqual(out.map((c) => c.text), ['ichi', '', 'san', 'shi']);
});

test('alignTranslation keeps the lyric timestamps, not the translation ones', () => {
  // The result is rendered against the lyric's clock; a stamp drawn from the
  // translation would drift the caption off the line it belongs to.
  const original = cues([0, 'a'], [1000, 'b'], [2000, 'c'], [3000, 'd']);
  const translated = cues([120, 'A'], [1120, 'B'], [2120, 'C'], [3120, 'D']);
  const out = alignTranslation(original, translated);
  assert.ok(out);
  assert.deepEqual(out.map((c) => c.timeMs), [0, 1000, 2000, 3000]);
});

test('alignTranslation refuses a stamp set that does not line up', () => {
  // An unrelated translation would otherwise be presented as this song's, with
  // every line confidently captioned by something from another track.
  const original = cues([0, 'a'], [1000, 'b'], [2000, 'c'], [3000, 'd'], [4000, 'e']);
  const translated = cues([57_000, 'x'], [61_000, 'y'], [66_000, 'z']);
  assert.equal(alignTranslation(original, translated), null);
});

test('alignTranslation requires more than a couple of coincidental pairings', () => {
  const original = cues(...Array.from({ length: 20 }, (_, i) => [i * 1000, `line ${i}`]));
  // Only two of twenty land near a lyric stamp.
  const translated = cues([0, 'A'], [1000, 'B'], [90_000, 'C']);
  assert.equal(alignTranslation(original, translated), null);
});

test('alignTranslation ignores blank translation lines', () => {
  // LRC files carry timestamped-but-empty lines to mark the end of a phrase;
  // pairing one would blank a caption that should have had text.
  const original = cues([0, 'a'], [1000, 'b'], [2000, 'c'], [3000, 'd']);
  const translated = cues([0, 'A'], [1000, '   '], [2000, 'C'], [3000, 'D']);
  const out = alignTranslation(original, translated);
  assert.ok(out);
  assert.equal(out[1].text, '');
});

test('alignTranslation tolerates small timing differences', () => {
  const original = cues([0, 'a'], [1000, 'b'], [2000, 'c'], [3000, 'd']);
  const translated = cues([80, 'A'], [1150, 'B'], [2200, 'C'], [3300, 'D']);
  const out = alignTranslation(original, translated);
  assert.ok(out, 'rejected a translation that was only a few hundred ms off');
  assert.deepEqual(out.map((c) => c.text), ['A', 'B', 'C', 'D']);
});

test('alignTranslation returns null for empty or missing input', () => {
  assert.equal(alignTranslation(cues([0, 'a']), []), null);
  assert.equal(alignTranslation(cues([0, 'a']), null), null);
  assert.equal(alignTranslation(null, cues([0, 'a'])), null);
});

/* ------------------------------------------------------------ credit lines */
/*
  Found by running three real lookups: all three came back with a production
  credit as line one, stamped at 00:00. NetEase LRCs almost always open with
  them and they are not lyrics.
*/

const { stripCredits } = require('../src/main/netease');

test('stripCredits removes leading CJK production credits', () => {
  const out = stripCredits(cues(
    [0, '作词 : John Walter Schuster/Andrew Taggart'],
    [0, '作曲 : Alex Pall'],
    [2451, 'Do I ever cross your mind?'],
  ));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Do I ever cross your mind?');
});

test('stripCredits removes leading Latin credits too', () => {
  const out = stripCredits(cues(
    [0, 'Produced by: Metro Boomin'],
    [0, 'Written by: Someone'],
    [1000, 'real words'],
  ));
  assert.deepEqual(out.map((c) => c.text), ['real words']);
});

test('stripCredits only strips from the front', () => {
  // A line later in the song starting with one of these words is far likelier
  // to be a lyric than a credit; removing it would punch a hole in the track.
  const out = stripCredits(cues(
    [0, '作词 : X'],
    [1000, 'first real line'],
    [2000, '作曲 : Y'],
    [3000, 'last real line'],
  ));
  assert.equal(out.length, 3);
  assert.equal(out[1].text, '作曲 : Y');
});

test('stripCredits leaves a normal lyric untouched', () => {
  const input = cues([0, 'one'], [1000, 'two']);
  assert.deepEqual(stripCredits(input), input);
});

test('stripCredits returns empty when there is nothing but credits', () => {
  // The caller treats empty as "not found" and falls through to the next
  // source, which is better than showing a song made of credits.
  assert.deepEqual(stripCredits(cues([0, '作词 : X'], [0, '作曲 : Y'])), []);
});

test('stripCredits tolerates junk input', () => {
  assert.deepEqual(stripCredits(null), []);
  assert.deepEqual(stripCredits([]), []);
});
