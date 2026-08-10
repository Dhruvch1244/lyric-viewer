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
  cleanArtist,
  versionTags,
  normalize,
  tokenSimilarity,
  scoreCandidate,
  parseLrc,
  normaliseCues,
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

/*
  Gap markers — timestamped LRC lines with no text. Every one of the ten LRCLIB
  entries sampled while writing these carried between 1 and 8 of them, and as
  cues they rendered as empty active lines that blanked the screen.
*/

test('parseLrc folds a blank gap marker into the previous cue as endMs', () => {
  const cues = parseLrc('[00:14.15]Yeah\n[00:17.73]\n[00:27.85]Been tryna call');
  assert.deepEqual(cues, [
    { timeMs: 14150, text: 'Yeah', endMs: 17730 },
    { timeMs: 27850, text: 'Been tryna call' },
  ]);
});

test('parseLrc folds a whitespace-only gap marker too', () => {
  const cues = parseLrc('[00:01.00]sung\n[00:04.00]   ');
  assert.deepEqual(cues, [{ timeMs: 1000, text: 'sung', endMs: 4000 }]);
});

test('parseLrc drops a gap marker that has no line to close', () => {
  const cues = parseLrc('[00:00.00]\n[00:05.00]first words');
  assert.deepEqual(cues, [{ timeMs: 5000, text: 'first words' }]);
});

test('parseLrc keeps the earliest end when gap markers repeat', () => {
  const cues = parseLrc('[00:01.00]sung\n[00:03.00]\n[00:04.00]\n[00:09.00]next');
  assert.deepEqual(cues, [
    { timeMs: 1000, text: 'sung', endMs: 3000 },
    { timeMs: 9000, text: 'next' },
  ]);
});

test('parseLrc folds by time order, not file order', () => {
  const cues = parseLrc('[00:09.00]late\n[00:03.00]\n[00:01.00]early');
  assert.deepEqual(cues, [
    { timeMs: 1000, text: 'early', endMs: 3000 },
    { timeMs: 9000, text: 'late' },
  ]);
});

test('normaliseCues repairs a cue list cached before gap markers were folded', () => {
  const stored = [
    { timeMs: 1000, text: 'one' },
    { timeMs: 3000, text: '' },
    { timeMs: 9000, text: 'two' },
  ];
  const { cues, kept } = normaliseCues(stored);
  assert.deepEqual(cues, [
    { timeMs: 1000, text: 'one', endMs: 3000 },
    { timeMs: 9000, text: 'two' },
  ]);
  // `kept` maps survivors back to their source index so a cached translation
  // can be filtered to match instead of captioning the wrong lines.
  assert.deepEqual(kept, [0, 2]);
});

test('normaliseCues preserves an endMs that is already present', () => {
  const { cues } = normaliseCues([{ timeMs: 100, text: 'x', endMs: 900 }]);
  assert.deepEqual(cues, [{ timeMs: 100, text: 'x', endMs: 900 }]);
});

test('normaliseCues ignores a nonsensical endMs and unusable entries', () => {
  const { cues } = normaliseCues([
    { timeMs: 100, text: 'x', endMs: 50 },   // ends before it starts
    null,
    { timeMs: 'later', text: 'y' },          // unusable timestamp
  ]);
  assert.deepEqual(cues, [{ timeMs: 100, text: 'x' }]);
});

test('normaliseCues tolerates junk input', () => {
  assert.deepEqual(normaliseCues(null), { cues: [], kept: [] });
  assert.deepEqual(normaliseCues([]), { cues: [], kept: [] });
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

/* --- artist credit cleaning ------------------------------------------------
   YouTube Music and VEVO decorate the artist field, which poisons matching
   against LRCLIB and the artwork APIs and looks wrong on screen. */

test('cleanArtist strips YouTube "- Topic" auto-channel suffixes', () => {
  assert.equal(cleanArtist('Seedhe Maut - Topic'), 'Seedhe Maut');
  assert.equal(cleanArtist('DIVINE — Topic'), 'DIVINE');
  assert.equal(cleanArtist('KR$NA - topic'), 'KR$NA');
});

test('cleanArtist strips VEVO and official-channel decoration', () => {
  // VEVO channel names are concatenated, so this is a suffix strip.
  assert.equal(cleanArtist('TheWeekndVEVO'), 'TheWeeknd');
  assert.equal(cleanArtist('BillieEilishVEVO'), 'BillieEilish');
  assert.equal(cleanArtist('Arijit Singh - Official Channel'), 'Arijit Singh');
});

test('cleanArtist leaves a normal credit untouched', () => {
  assert.equal(cleanArtist('Seedhe Maut'), 'Seedhe Maut');
  assert.equal(cleanArtist('Calvin Harris & Dua Lipa'), 'Calvin Harris & Dua Lipa');
  assert.equal(cleanArtist(''), '');
});

test('cleanArtist keeps a hyphenated name that is not a Topic channel', () => {
  assert.equal(cleanArtist('Jay-Z'), 'Jay-Z');
  assert.equal(cleanArtist('Anne-Marie'), 'Anne-Marie');
});

/* --- version-aware matching ------------------------------------------------
   A studio LRC file lines up with the studio cut only, so a live or slowed
   edit must not win on title/artist similarity alone. */

test('versionTags finds recording-version markers in a raw title', () => {
  assert.deepEqual([...versionTags('Song Name (Live)')], ['live']);
  assert.deepEqual([...versionTags('Song Name - Slowed + Reverb')].sort(), ['reverb', 'slowed']);
  assert.deepEqual([...versionTags('Plain Song')], []);
});

test('scoreCandidate prefers the studio cut for a studio track', () => {
  const target = { title: 'Nanchaku', artist: 'Seedhe Maut', durationMs: 180000 };
  const studio = {
    syncedLyrics: '[00:01.00]x', trackName: 'Nanchaku',
    artistName: 'Seedhe Maut', duration: 180,
  };
  const live = {
    syncedLyrics: '[00:01.00]x', trackName: 'Nanchaku (Live)',
    artistName: 'Seedhe Maut', duration: 181,
  };
  assert.ok(
    scoreCandidate(studio, target) > scoreCandidate(live, target),
    'studio entry should outrank the live cut'
  );
});

test('scoreCandidate prefers the live cut when the track IS the live cut', () => {
  const target = { title: 'Nanchaku (Live)', artist: 'Seedhe Maut', durationMs: 181000 };
  const studio = {
    syncedLyrics: '[00:01.00]x', trackName: 'Nanchaku',
    artistName: 'Seedhe Maut', duration: 180,
  };
  const live = {
    syncedLyrics: '[00:01.00]x', trackName: 'Nanchaku (Live)',
    artistName: 'Seedhe Maut', duration: 181,
  };
  assert.ok(
    scoreCandidate(live, target) > scoreCandidate(studio, target),
    'live entry should outrank the studio cut'
  );
});

test('scoreCandidate matches a track whose artist arrived as a Topic channel', () => {
  const target = { title: 'Nanchaku', artist: 'Seedhe Maut - Topic', durationMs: 180000 };
  const candidate = {
    syncedLyrics: '[00:01.00]x', trackName: 'Nanchaku',
    artistName: 'Seedhe Maut', duration: 180,
  };
  // Without cleanArtist the "Topic" token drags artist similarity down.
  assert.ok(scoreCandidate(candidate, target) > 2.5);
});
