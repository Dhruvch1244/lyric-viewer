'use strict';

/*
  Unit tests for the offline translation gate (src/main/localtranslate.js).

  Only `canTranslate` is exercised here — it is the part that decides whether
  the model is allowed near a lyric list at all, and it is pure. Loading the
  model itself needs a ~75MB download and belongs in a manual check, not the
  unit suite.

  The gate matters more than it looks: on romanized Hindi or on English the
  model returns confident nonsense rather than failing, so a gate that is too
  loose puts garbage on screen.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const { canTranslate } = require('../src/main/localtranslate');

test('canTranslate accepts Devanagari lyrics', () => {
  assert.equal(canTranslate([
    { text: 'तेरा नाम मेरे दिल में है' },
    { text: 'सब झुके और श्रद्धा से बोले' },
  ]), true);
});

test('canTranslate rejects romanized Hindi — the model cannot read it', () => {
  // Measured: "Tera naam mere dil mein hai" -> "So this is a negative
  // divisible by the negative." Worse than showing nothing.
  assert.equal(canTranslate([
    { text: 'Tera naam mere dil mein hai' },
    { text: 'Sabhi jhooke aur shradhdha se bole' },
  ]), false);
});

test('canTranslate rejects English — a hi->en model mangles it rather than passing it through', () => {
  assert.equal(canTranslate([
    { text: 'I have been on my own for long enough' },
    { text: 'Maybe you can show me how to love' },
  ]), false);
});

test('canTranslate handles a mixed, code-switched list by majority script', () => {
  const mostlyDeva = [
    { text: 'तेरा नाम मेरे दिल में है' },
    { text: 'सब झुके और श्रद्धा से बोले' },
    { text: 'कलम जले दर्द दुखे' },
    { text: 'yeah' },
  ];
  assert.equal(canTranslate(mostlyDeva), true);

  const mostlyLatin = [
    { text: 'I have been on my own for long enough' },
    { text: 'Maybe you can show me how to love' },
    { text: 'तेरा नाम' },
  ];
  assert.equal(canTranslate(mostlyLatin), false);
});

test('canTranslate tolerates junk input', () => {
  assert.equal(canTranslate(null), false);
  assert.equal(canTranslate([]), false);
  assert.equal(canTranslate([{}, { text: '' }, null]), false);
});
