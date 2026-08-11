'use strict';

/*
  Kugou, the third synced lyric source (src/main/kugou.js).

  The network calls are not testable without the network. What is worth pinning
  down is the mapping onto the shared scorer, because the failure it prevents is
  silent and total: three sources have to agree what "a good match" means, and a
  unit mismatch in `duration` poisons the duration bonus so that every candidate
  looks like a different edit of the song. NetEase reports milliseconds; Kugou
  reports seconds; LRCLIB reports seconds.

  Plus the credit stripper, which now has to handle a shape NetEase never had.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { toCandidate } = require('../src/main/kugou');
const { stripCredits } = require('../src/main/netease');
const { scoreCandidate } = require('../src/main/lyrics');

/* --- the candidate mapping --- */

test('duration is passed through in seconds, as the scorer expects', () => {
  // Measured from the live API: Kugou's song search reports seconds. Treating
  // it as milliseconds would make a 180s track look 180,000s long and lose the
  // duration bonus on every candidate.
  const c = toCandidate({ songname: 'ALL THE TIME', singername: 'John Summit', duration: 180 }, '[00:01.00]x');
  assert.equal(c.duration, 180);

  const score = scoreCandidate(c, {
    title: 'ALL THE TIME', artist: 'John Summit', durationMs: 180000,
  });
  assert.ok(score > 3, `expected a strong match, got ${score}`);
});

test('the enumeration comma between artists is normalised', () => {
  const c = toCandidate({
    songname: 'x', singername: 'John Summit、The Chainsmokers、Ilsey', duration: 180,
  }, '[00:01.00]x');
  assert.equal(c.artistName, 'John Summit, The Chainsmokers, Ilsey');
});

test('the original song name wins over the display name', () => {
  // Kugou localises `songname` for some entries and keeps the release title in
  // `songname_original`; the scorer is comparing against what SMTC reported.
  const c = toCandidate({
    songname: 'ALL THE TIME (完整版)', songname_original: 'ALL THE TIME',
    singername: 'John Summit', duration: 180,
  }, '[00:01.00]x');
  assert.equal(c.trackName, 'ALL THE TIME');
});

test('a candidate without sync is refused by the scorer', () => {
  // The whole point of this source is line-level timing.
  const c = toCandidate({ songname: 'x', singername: 'y', duration: 100 }, '');
  assert.equal(scoreCandidate(c, { title: 'x', artist: 'y', durationMs: 100000 }), -1);
});

/* --- the credit stripper, extended for Kugou's header line --- */

test('a title-and-artist header line is dropped', () => {
  // Measured on the live API: Kugou opens with
  // "ALL THE TIME - John Summit/The Chainsmokers/Ilsey" at 00:00, which is not
  // a credit and matched no prefix — so it survived and became the first thing
  // on screen when the song started.
  const cues = [
    { timeMs: 0, text: 'ALL THE TIME - John Summit/The Chainsmokers/Ilsey' },
    { timeMs: 8000, text: 'You say do I ever cross your mind' },
  ];
  assert.deepEqual(stripCredits(cues, 'ALL THE TIME'), [cues[1]]);
});

test('the header rule needs the title, and never fires on a lyric', () => {
  // "<something> - <something>" is an ordinary lyric line, so this must match
  // against the title we asked for rather than against a shape.
  const cues = [
    { timeMs: 0, text: 'Love - the only thing worth having' },
    { timeMs: 4000, text: 'second line' },
  ];
  assert.deepEqual(stripCredits(cues, 'ALL THE TIME'), cues);
  assert.deepEqual(stripCredits(cues), cues, 'no hint means no header rule');
});

test('the Latin credit forms Kugou uses are stripped', () => {
  // NetEase writes "Lyricist:"; Kugou writes "Lyrics by：" with a full-width
  // colon. Both are credits and neither is a lyric.
  const cues = [
    { timeMs: 480, text: 'Lyrics by：John Walter Schuster' },
    { timeMs: 1210, text: 'Composed by：Andrew Taggart' },
    { timeMs: 2000, text: 'Arranged by：Alex Pall' },
    { timeMs: 3000, text: 'Mixed by：Someone' },
    { timeMs: 8000, text: 'You say do I ever cross your mind' },
  ];
  assert.deepEqual(stripCredits(cues, 'ALL THE TIME'), [cues[4]]);
});

test('a header line plus credits are both stripped, in that order', () => {
  const cues = [
    { timeMs: 0, text: 'Faded - Alan Walker' },
    { timeMs: 500, text: 'Lyrics by：Someone' },
    { timeMs: 9000, text: 'You were the shadow to my light' },
  ];
  assert.deepEqual(stripCredits(cues, 'Faded'), [cues[2]]);
});

test('a song that is nothing but credits returns empty, not a blank song', () => {
  // Empty lets the caller fall through to the next source.
  const cues = [
    { timeMs: 0, text: 'Faded - Alan Walker' },
    { timeMs: 500, text: 'Composed by：Someone' },
  ];
  assert.deepEqual(stripCredits(cues, 'Faded'), []);
});

test('a real first line is never eaten', () => {
  const cues = [{ timeMs: 900, text: 'You were the shadow to my light' }];
  assert.deepEqual(stripCredits(cues, 'Faded'), cues);
});
