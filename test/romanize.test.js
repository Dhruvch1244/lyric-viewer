'use strict';

/*
  Unit tests for rule-based romanized-Hindi → Devanagari (src/main/romanize.js).

  Every expectation here is a word whose correct Devanagari spelling is not in
  dispute, so the tests are real ground truth rather than a snapshot of whatever
  the code happened to emit.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { wordToDevanagari, lineToDevanagari, cuesToDevanagari } = require('../src/main/romanize');

test('simple consonant-vowel words', () => {
  assert.equal(wordToDevanagari('dil'), 'दिल');
  assert.equal(wordToDevanagari('naam'), 'नाम');
  assert.equal(wordToDevanagari('sab'), 'सब');
  assert.equal(wordToDevanagari('kalam'), 'कलम');
});

test('word-final "a" is the long aa, word-internal "a" is the inherent schwa', () => {
  // Both rules exercised by the same words: "mera" is मेरा, not मेर.
  assert.equal(wordToDevanagari('mera'), 'मेरा');
  assert.equal(wordToDevanagari('tera'), 'तेरा');
  assert.equal(wordToDevanagari('apna'), 'अपना');
  // ...while the internal "a" of kalam adds nothing.
  assert.equal(wordToDevanagari('kalam'), 'कलम');
});

test('schwa deletion leaves a bare final consonant, not a virama', () => {
  assert.equal(wordToDevanagari('dil').endsWith('्'), false);
  assert.equal(wordToDevanagari('sab').endsWith('्'), false);
});

test('consonant clusters bind with a virama', () => {
  assert.equal(wordToDevanagari('pyaar'), 'प्यार');
  assert.equal(wordToDevanagari('kya'), 'क्या');
});

test('vowel matras', () => {
  assert.equal(wordToDevanagari('jale'), 'जले');
  assert.equal(wordToDevanagari('dukhe'), 'दुखे');
  assert.equal(wordToDevanagari('hai'), 'है');
  assert.equal(wordToDevanagari('toote'), 'तूते');
});

test('digraph consonants beat their own prefixes', () => {
  // "kh" must not be read as "k" then a stray "h".
  assert.equal(wordToDevanagari('kha'), 'खा');
  assert.equal(wordToDevanagari('bhai'), 'भै');
  assert.equal(wordToDevanagari('shab'), 'शब');
});

test('a nasal before a consonant becomes anusvara', () => {
  assert.equal(wordToDevanagari('zindagi'), 'ज़िंदगी');
  // ...but a word-final nasal stays a full consonant.
  assert.equal(wordToDevanagari('man'), 'मन');
});

test('perso-arabic sounds take their nukta forms', () => {
  assert.ok(wordToDevanagari('zindagi').startsWith('ज़'));
  assert.ok(wordToDevanagari('fan').startsWith('फ़'));
});

test('a word opening with a vowel uses the independent form', () => {
  assert.equal(wordToDevanagari('apna'), 'अपना');
  assert.ok(wordToDevanagari('is').startsWith('इ'));
});

test('lineToDevanagari leaves punctuation and spacing alone', () => {
  assert.equal(lineToDevanagari('dil, naam'), 'दिल, नाम');
  assert.equal(lineToDevanagari('(sab)'), '(सब)');
  assert.equal(lineToDevanagari(''), '');
});

test('cuesToDevanagari preserves timing and any word spans', () => {
  const cues = [{ timeMs: 100, endMs: 900, text: 'dil', words: [{ word: 'dil', startMs: 100, endMs: 900 }] }];
  const out = cuesToDevanagari(cues);
  assert.equal(out[0].text, 'दिल');
  assert.equal(out[0].timeMs, 100);
  assert.equal(out[0].endMs, 900);
  assert.deepEqual(out[0].words, cues[0].words);
});

test('tolerates junk input', () => {
  assert.equal(wordToDevanagari(''), '');
  assert.equal(wordToDevanagari(null), '');
  assert.deepEqual(cuesToDevanagari(null), []);
});
