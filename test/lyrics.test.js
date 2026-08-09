'use strict';

/*
  Unit tests for the pure lyric-matching helpers in src/main/lyrics.js.
  These functions have no Electron or network dependency, so they run under the
  built-in Node test runner (`node --test`) with no extra packages.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanTitle,
  normalize,
  tokenSimilarity,
  scoreCandidate,
  parseLrc,
  devanagariRatio,
  gurmukhiRatio,
  isDevanagariCues,
  detectIndic,
} = require('../src/main/lyrics');

test('cleanTitle strips platform noise, credits and quotes', () => {
  assert.equal(cleanTitle('Song Title (Official Music Video)'), 'Song Title');
  assert.equal(cleanTitle('Track | Seedhe Maut x DJ SA'), 'Track');
  assert.equal(cleanTitle('Name feat. Someone Else'), 'Name');
  assert.equal(cleanTitle('Tune (feat. Guest)'), 'Tune');
});

test('cleanTitle falls back to the raw title when cleaning empties it', () => {
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle('   '), ''); // trimmed fallback
  assert.equal(cleanTitle('|'), '|'); // pipe at index 0 is not a credit split
});

test('normalize lowercases, strips Latin diacritics and punctuation', () => {
  assert.equal(normalize('Café  DÉJÀ vu!'), 'cafe deja vu');
  assert.equal(normalize(''), '');
});

test('normalize preserves Devanagari base letters (combining marks are dropped)', () => {
  // Base consonants survive (they are \p{L})...
  assert.equal(normalize('कमल'), 'कमल');
  // ...while matras/virama (category Mn) are stripped like other punctuation, so a
  // fully-conjoined word keeps only its base letters. This is expected: normalize
  // is a comparison key, not a display string.
  assert.equal(normalize('नमस्ते'), 'नमस त');
});

test('tokenSimilarity ranges from 0 (disjoint) to 1 (identical)', () => {
  assert.equal(tokenSimilarity('hello world', 'hello world'), 1);
  assert.equal(tokenSimilarity('abc', 'xyz'), 0);
  assert.equal(tokenSimilarity('a b', 'a c'), 0.5); // 1 shared / max(2,2)
  assert.equal(tokenSimilarity('', 'anything'), 0);
});

test('scoreCandidate rejects entries without synced lyrics', () => {
  const score = scoreCandidate(
    { trackName: 'Hausla', artistName: 'Seedhe Maut', duration: 180 },
    { title: 'Hausla', artist: 'Seedhe Maut', durationMs: 180000 },
  );
  assert.equal(score, -1);
});

test('scoreCandidate rewards a strong title+artist+duration match', () => {
  const strong = scoreCandidate(
    { syncedLyrics: '[00:01.00]x', trackName: 'Hausla', artistName: 'Seedhe Maut', duration: 180 },
    { title: 'Hausla', artist: 'Seedhe Maut', durationMs: 180000 },
  );
  const weak = scoreCandidate(
    { syncedLyrics: '[00:01.00]x', trackName: 'Totally Different', artistName: 'Someone', duration: 300 },
    { title: 'Hausla', artist: 'Seedhe Maut', durationMs: 180000 },
  );
  assert.ok(strong > 4, `expected strong match > 4, got ${strong}`);
  assert.ok(strong > weak, 'strong match should outscore the weak one');
});

test('parseLrc parses, orders and de-tags timestamped cues', () => {
  const cues = parseLrc('[00:03.00]World\n[00:01.50]Hello\nno-timestamp line');
  assert.deepEqual(cues, [
    { timeMs: 1500, text: 'Hello' },
    { timeMs: 3000, text: 'World' },
  ]);
});

test('parseLrc expands multiple stamps on a single line', () => {
  const cues = parseLrc('[00:01.00][00:05.00]repeat');
  assert.deepEqual(cues, [
    { timeMs: 1000, text: 'repeat' },
    { timeMs: 5000, text: 'repeat' },
  ]);
});

test('devanagariRatio / gurmukhiRatio measure script share of letters only', () => {
  assert.equal(devanagariRatio('नमस्ते'), 1); // matras/virama are not counted as letters
  assert.equal(devanagariRatio('hello'), 0);
  assert.equal(gurmukhiRatio('ਪੰਜਾਬੀ') > 0.5, true);
  assert.equal(gurmukhiRatio('hello'), 0);
});

test('isDevanagariCues flags a predominantly Devanagari cue list', () => {
  assert.equal(isDevanagariCues([{ text: 'नमस्ते दुनिया' }]), true);
  assert.equal(isDevanagariCues([{ text: 'hello world' }]), false);
});

test('detectIndic identifies native script and romanized Hindi', () => {
  assert.deepEqual(detectIndic([{ text: 'नमस्ते दुनिया' }]), { indic: true, script: 'devanagari' });

  const romanized = detectIndic([{ text: 'tu mera dil hai yaar main tera' }]);
  assert.equal(romanized.indic, true);
  assert.equal(romanized.script, 'latin');

  assert.deepEqual(detectIndic([{ text: 'this is a plain english line' }]), { indic: false, script: 'latin' });
  assert.deepEqual(detectIndic([]), { indic: false, script: 'latin' });
});
