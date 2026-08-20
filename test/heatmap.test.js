'use strict';

/*
  Unit tests for the song heatmap (src/renderer/heatmap.js).

  Browser IIFE attaching to `window`, touching nothing else.

  The behaviour worth pinning down is that the map is a property of the TRACK
  and not of one playthrough: binning by position, peak-holding across plays,
  and normalising against the song's own dynamics.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/heatmap.js');
const HeatMap = global.window.HeatMap;

const env = (level, bass = level, treble = level) => ({ level, bass, treble });

test('bins by position in the song, not by wall clock', () => {
  HeatMap.start(100000);           // 100s track, 96 bins
  HeatMap.note(0, env(0.5));
  HeatMap.note(99999, env(0.9));
  const c = HeatMap.cells();
  assert.equal(c.length, HeatMap.BIN_COUNT);
  assert.ok(c[0].level > 0, 'start of song should be populated');
  assert.ok(c[HeatMap.BIN_COUNT - 1].level > 0, 'end of song should be populated');
});

test('a bin keeps its PEAK, not an average', () => {
  HeatMap.start(10000);
  // Same bin, one loud moment among quiet ones. An average would bury it.
  for (let i = 0; i < 8; i += 1) HeatMap.note(50, env(0.1));
  HeatMap.note(50, env(1.0));
  for (let i = 0; i < 8; i += 1) HeatMap.note(50, env(0.1));
  assert.equal(HeatMap.cells()[0].level, 1);
});

test('peaks survive across replays of the same track', () => {
  HeatMap.start(10000);
  HeatMap.note(50, env(0.9));
  HeatMap.start(10000);            // same track again — must not reset
  HeatMap.note(50, env(0.2));
  assert.equal(HeatMap.cells()[0].level, 1, 'the earlier peak should still stand');
});

test('a different track length starts a fresh map', () => {
  HeatMap.start(10000);
  HeatMap.note(50, env(0.9));
  HeatMap.start(240000);
  assert.equal(HeatMap.cells()[0].level, 0);
});

test('cells normalise against the song own peak, not an absolute scale', () => {
  HeatMap.start(96000);            // 1s per bin
  HeatMap.note(500, env(0.2));     // bin 0
  HeatMap.note(1500, env(0.4));    // bin 1 — the loudest moment in this song
  const c = HeatMap.cells();
  assert.equal(c[1].level, 1, 'the loudest bin should read full');
  assert.ok(Math.abs(c[0].level - 0.5) < 0.01, 'others scale against it');
});

test('coverage reports how much of the song has actually been heard', () => {
  HeatMap.start(96000);
  assert.equal(HeatMap.coverage(), 0);
  for (let i = 0; i < 48; i += 1) {
    // MIN_SAMPLES per bin, or the bin does not count as known.
    HeatMap.note(i * 1000 + 500, env(0.5));
    HeatMap.note(i * 1000 + 600, env(0.5));
  }
  assert.ok(Math.abs(HeatMap.coverage() - 0.5) < 0.02, `got ${HeatMap.coverage()}`);
});

test('unheard bins are marked so a partial map can be drawn honestly', () => {
  HeatMap.start(96000);
  HeatMap.note(500, env(0.5));
  HeatMap.note(600, env(0.5));
  const c = HeatMap.cells();
  assert.equal(c[0].known, true);
  assert.equal(c[50].known, false);
});

test('load restores a saved map and rejects a malformed one', () => {
  HeatMap.start(96000);
  HeatMap.note(500, env(0.7));
  HeatMap.note(600, env(0.7));
  const saved = HeatMap.takeForSave();
  HeatMap.load(null);
  assert.equal(HeatMap.get(), null);
  HeatMap.load(saved);
  assert.ok(HeatMap.get());
  assert.equal(HeatMap.cells()[0].known, true);
  HeatMap.load({ durationMs: 1000, bins: [1, 2, 3] });   // wrong shape
  assert.equal(HeatMap.get(), null);
});

test('dirty tracks whether there is anything new to save', () => {
  HeatMap.start(96000);
  assert.equal(HeatMap.isDirty(), false);
  HeatMap.note(500, env(0.4));
  assert.equal(HeatMap.isDirty(), true);
  HeatMap.takeForSave();
  assert.equal(HeatMap.isDirty(), false);
  HeatMap.note(500, env(0.1));     // quieter than the peak — nothing learned
  assert.equal(HeatMap.isDirty(), false);
});

test('tolerates junk input', () => {
  HeatMap.start(0);
  assert.equal(HeatMap.get(), null);
  HeatMap.start(96000);
  HeatMap.note(-5, env(0.5));
  HeatMap.note(NaN, env(0.5));
  HeatMap.note(500, null);
  assert.equal(HeatMap.coverage(), 0);
});

test('load rejects a map recorded from a different-length recording', () => {
  // Same title and artist, different arrangement — a radio edit against an
  // extended mix. Adopting it would put the drop confidently in the wrong place.
  HeatMap.start(96000);
  HeatMap.note(500, env(0.8));
  const saved = HeatMap.takeForSave();

  HeatMap.start(300000);                 // a much longer cut of "the same" song
  assert.equal(HeatMap.load(saved), false);
  assert.equal(HeatMap.get().durationMs, 300000, 'the playing track keeps its own map');

  HeatMap.start(96000 + 500);            // within tolerance: the same recording
  assert.equal(HeatMap.load(saved), true);
});

/* ------------------------------------------------------------- anticipation */

/**
 * Fill a whole song: `level(binIndex)` supplies each bin's energy.
 *
 * Clears first, because `start` deliberately RESUMES a track of the same length
 * rather than wiping it — that is how peaks survive a replay — and these tests
 * reuse 96000ms so their bins line up with round numbers.
 */
function record(durationMs, level) {
  HeatMap.load(null);
  HeatMap.start(durationMs);
  const binMs = durationMs / HeatMap.BIN_COUNT;
  for (let i = 0; i < HeatMap.BIN_COUNT; i += 1) {
    for (let s = 0; s < HeatMap.MIN_SAMPLES; s += 1) {
      HeatMap.note(i * binMs + binMs / 2, env(level(i)));
    }
  }
}

test('lookahead says nothing about a song that has not been heard', () => {
  HeatMap.load(null);
  HeatMap.start(96000);
  const ahead = HeatMap.lookahead(1000, 6000);
  assert.equal(ahead.rise, 0);
  assert.equal(ahead.imminence, 0);
});

test('lookahead sees a rise before it arrives', () => {
  // 96s track, 1s per bin: quiet until bin 50, loud after.
  record(96000, (i) => (i < 50 ? 0.2 : 1.0));

  // Standing at 45s, the jump at 50s is inside a 6s window.
  const early = HeatMap.lookahead(45000, 6000);
  assert.ok(early.rise > 0.7, `expected a big rise, got ${early.rise}`);
  assert.ok(early.toPeakMs > 4000 && early.toPeakMs <= 5000, `got ${early.toPeakMs}`);

  // Standing at 49s it is the same rise, but now imminent.
  const late = HeatMap.lookahead(49000, 6000);
  assert.ok(late.imminence > early.imminence, 'imminence should grow as it nears');
});

test('lookahead reports no rise when the loud part is already playing', () => {
  record(96000, (i) => (i < 50 ? 0.2 : 1.0));
  const ahead = HeatMap.lookahead(60000, 6000);
  assert.equal(ahead.rise, 0, 'nothing ahead is louder than now');
  assert.equal(ahead.level, 1);
});

test('lookahead ignores a rise beyond its window', () => {
  record(96000, (i) => (i < 50 ? 0.2 : 1.0));
  assert.equal(HeatMap.lookahead(20000, 6000).rise, 0, '30s out is not anticipation');
});

/* ---------------------------------------------------------------- structure */

test('sections stay silent until enough of the song is known', () => {
  HeatMap.load(null);
  HeatMap.start(96000);
  for (let i = 0; i < 10; i += 1) {
    HeatMap.note(i * 1000 + 500, env(0.5));
    HeatMap.note(i * 1000 + 600, env(0.5));
  }
  assert.ok(HeatMap.coverage() < HeatMap.MIN_STRUCTURE_COVERAGE);
  assert.deepEqual(HeatMap.sections(), [], 'structure from a tenth of a track is fiction');
});

test('sections name a quiet intro, a build and a drop', () => {
  // Quiet · mid · loud · quiet, in four equal quarters.
  record(96000, (i) => {
    if (i < 24) return 0.15;
    if (i < 48) return 0.55;
    if (i < 72) return 1.0;
    return 0.15;
  });
  const kinds = HeatMap.sections().map((s) => s.kind);
  assert.deepEqual(kinds, ['intro', 'build', 'drop', 'outro'], `got ${kinds.join(',')}`);
});

test('a mid-energy stretch that leads nowhere is a verse, not a build', () => {
  // Mid · quiet · loud · quiet. The first mid stretch drops away instead of
  // climbing, so it is a verse; only a mid stretch that runs INTO the loud one
  // is a build. Levels are relative to this song's own peak, so the loud
  // quarter is what makes the first quarter read as mid at all.
  record(96000, (i) => {
    if (i < 24) return 0.5;
    if (i < 48) return 0.15;
    if (i < 72) return 1.0;
    return 0.15;
  });
  const kinds = HeatMap.sections().map((s) => s.kind);
  assert.deepEqual(kinds, ['verse', 'break', 'drop', 'outro'], `got ${kinds.join(',')}`);
});

test('a single loud bin is a cymbal, not a section', () => {
  record(96000, (i) => (i === 40 ? 1.0 : 0.5));
  const sections = HeatMap.sections();
  assert.equal(sections.length, 1, `one flat song, got ${sections.length} sections`);
});

test('sectionAt finds the section covering a position', () => {
  record(96000, (i) => (i < 48 ? 0.15 : 1.0));
  assert.equal(HeatMap.sectionAt(5000).kind, 'intro');
  assert.equal(HeatMap.sectionAt(90000).kind, 'drop');
  assert.equal(HeatMap.sectionAt(-1), null);
});

test('cells is not rebuilt while nothing changes', () => {
  // The renderer asks every frame. Rebuilding allocated 96 objects and an array
  // sixty times a second to hand back identical values, so the same array must
  // come back until a bin actually moves.
  record(96000, () => 0.5);
  const first = HeatMap.cells();
  assert.equal(HeatMap.cells(), first, 'same revision should return the same array');

  const binMs = 96000 / HeatMap.BIN_COUNT;
  HeatMap.note(binMs / 2, env(1.0));            // a new peak in bin 0
  const after = HeatMap.cells();
  assert.notEqual(after, first, 'a learned peak must invalidate it');
  assert.equal(after[0].level, 1);
});

test('structure follows the map when something new is learned', () => {
  record(96000, () => 0.5);
  assert.equal(HeatMap.sections().length, 1);
  // A loud second half arrives on a later play; the cached answer must not hold.
  const binMs = 96000 / HeatMap.BIN_COUNT;
  for (let i = 48; i < HeatMap.BIN_COUNT; i += 1) HeatMap.note(i * binMs + binMs / 2, env(1.0));
  assert.ok(HeatMap.sections().length > 1, 'the new drop should split the song');
});

/* ------------------------------------------- measured section boundaries --- */
/*
  `setSections` lets the native structure pass (structure.rs) say WHERE a song
  changes section, while the heat map keeps saying WHAT each section is. The
  two failure modes worth pinning: measured boundaries being ignored, and a
  previous song's boundaries surviving a track change — the second is worse,
  because a wrong boundary drawn confidently beats no boundary at all.
*/

/**
 * Fill EVERY bin of a track, so coverage is complete and no bin is left
 * unknown — an unknown bin smooths to zero and shows up as a spurious section
 * of its own, which would make these tests measure the fixture rather than the
 * code.
 */
function fillTrack(durationMs, levelAt) {
  // `start` is a no-op when the duration matches the map it already holds —
  // that is how peak-holding across replays works — so these tests, which all
  // use the same length, have to clear it explicitly or each inherits the
  // previous one's energy.
  HeatMap.load(null);
  HeatMap.start(durationMs);
  HeatMap.setSections(null);
  const binMs = durationMs / HeatMap.BIN_COUNT;
  for (let i = 0; i < HeatMap.BIN_COUNT; i += 1) {
    const ms = (i + 0.5) * binMs;
    const v = levelAt(ms);
    for (let n = 0; n <= HeatMap.MIN_SAMPLES; n += 1) HeatMap.note(ms, env(v));
  }
}

test('measured boundaries replace the energy-tier ones', () => {
  // A track with no loudness change at all: the tier path finds exactly one
  // section, so any split here can only have come from the measured list.
  fillTrack(200000, () => 0.5);
  assert.equal(HeatMap.sections().length, 1, 'a flat track should have one tier section');

  HeatMap.setSections([0, 50000, 120000]);
  const s = HeatMap.sections();
  assert.equal(s.length, 3, `expected 3 measured sections, got ${s.length}`);
  assert.equal(s[0].startMs, 0);
  assert.ok(Math.abs(s[1].startMs - 50000) < 3000, `section 2 starts at ${s[1].startMs}`);
  assert.ok(Math.abs(s[2].startMs - 120000) < 3000, `section 3 starts at ${s[2].startMs}`);
});

test('measured sections are still named from their own energy', () => {
  // The composition that makes this worth doing: structure says where, the
  // heat map says what. A loud measured section must still come back "drop".
  fillTrack(200000, (ms) => (ms >= 100000 ? 1.0 : 0.1));
  HeatMap.setSections([0, 100000]);
  const s = HeatMap.sections();
  assert.equal(s.length, 2);
  assert.ok(s[1].level > s[0].level, 'the loud half did not read as louder');
  assert.equal(s[1].kind, 'drop', `loud measured section was named "${s[1].kind}"`);
  assert.notEqual(s[0].kind, 'drop', `quiet measured section was named "${s[0].kind}"`);
});

test('sections cover the whole track with no gaps', () => {
  fillTrack(200000, () => 0.5);
  HeatMap.setSections([0, 50000, 120000]);
  const s = HeatMap.sections();
  assert.equal(s[0].startMs, 0);
  for (let i = 1; i < s.length; i += 1) {
    assert.equal(s[i].startMs, s[i - 1].endMs, `gap or overlap before section ${i}`);
  }
  assert.ok(s[s.length - 1].endMs >= 200000 - 3000, `track ends at ${s[s.length - 1].endMs}`);
});

test('clearing the boundaries goes back to energy tiers', () => {
  fillTrack(200000, (ms) => (ms >= 100000 ? 1.0 : 0.1));
  HeatMap.setSections([0, 30000, 60000, 90000, 150000]);
  assert.ok(HeatMap.sections().length > 2);
  HeatMap.setSections(null);
  const s = HeatMap.sections();
  assert.equal(s.length, 2, `tier fallback should find the one loudness change, got ${s.length}`);
});

test('a boundary list too short to mean anything is ignored', () => {
  fillTrack(200000, () => 0.5);
  HeatMap.setSections([0]);
  assert.equal(HeatMap.sections().length, 1);
  HeatMap.setSections([]);
  assert.equal(HeatMap.sections().length, 1);
});

test('setting boundaries invalidates the memoised structure', () => {
  // sections() is cached against `revision` and asked for every frame. If
  // setSections did not bump it, measured boundaries would not appear until
  // the next bin changed — which for a fully-analysed local file is never.
  fillTrack(200000, () => 0.5);
  const before = HeatMap.sections().length;
  HeatMap.setSections([0, 100000]);
  assert.notEqual(HeatMap.sections().length, before, 'the cached structure was served after a change');
});

test('two boundaries inside one bin do not produce an empty section', () => {
  // 200s across 96 bins is ~2.1s per bin, so these three land together.
  fillTrack(200000, () => 0.5);
  HeatMap.setSections([0, 100000, 100100, 100200]);
  for (const s of HeatMap.sections()) {
    assert.ok(s.endMs > s.startMs, `empty section at ${s.startMs}`);
  }
});
