'use strict';

/*
  Unit tests for the vocal-activity gate in src/main/vocals.js.

  These build synthetic PCM with known loud/quiet regions, so the assertions
  are about the gate's behaviour rather than about any particular song. No
  model, no Electron, no network.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  vocalMask,
  filterCuesByVocalActivity,
  bandEnvelope,
  FRAME_MS,
} = require('../src/main/vocals');

const SR = 16000;

/**
 * Build mono PCM from a list of {seconds, hz, amp} segments. hz of 0 is
 * silence. 1 kHz sits inside the 250 Hz–4 kHz vocal band; 60 Hz is sub-bass
 * that the band-pass should largely reject.
 */
function buildPcm(segments) {
  const total = segments.reduce((n, s) => n + Math.round(s.seconds * SR), 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const seg of segments) {
    const len = Math.round(seg.seconds * SR);
    for (let i = 0; i < len; i += 1) {
      pcm[o + i] = seg.hz === 0 ? 0 : seg.amp * Math.sin((2 * Math.PI * seg.hz * i) / SR);
    }
    o += len;
  }
  return pcm;
}

test('bandEnvelope produces one frame per FRAME_MS', () => {
  const pcm = buildPcm([{ seconds: 1, hz: 1000, amp: 0.5 }]);
  const env = bandEnvelope(pcm, SR);
  assert.equal(env.length, Math.floor(1000 / FRAME_MS));
});

test('bandEnvelope passes vocal-band tone and rejects sub-bass', () => {
  const vocal = bandEnvelope(buildPcm([{ seconds: 1, hz: 1000, amp: 0.5 }]), SR);
  const bass = bandEnvelope(buildPcm([{ seconds: 1, hz: 60, amp: 0.5 }]), SR);

  // Compare steady-state frames, past the filters' settling time.
  const vocalMid = vocal[vocal.length - 5];
  const bassMid = bass[bass.length - 5];
  assert.ok(vocalMid > bassMid * 3, `vocal ${vocalMid} should dominate bass ${bassMid}`);
});

test('vocalMask marks loud vocal-band regions voiced and silence unvoiced', () => {
  // 2s tone, 2s silence, 2s tone
  const pcm = buildPcm([
    { seconds: 2, hz: 1000, amp: 0.5 },
    { seconds: 2, hz: 0, amp: 0 },
    { seconds: 2, hz: 1000, amp: 0.5 },
  ]);
  const { mask, frameMs, voicedFraction } = vocalMask(pcm, SR);

  const at = (sec) => mask[Math.floor((sec * 1000) / frameMs)];
  assert.equal(at(1), 1, 'first tone should be voiced');
  assert.equal(at(3), 0, 'silent gap should be unvoiced');
  assert.equal(at(5), 1, 'second tone should be voiced');

  assert.ok(voicedFraction > 0.5 && voicedFraction < 0.85, `got ${voicedFraction}`);
});

test('filterCuesByVocalActivity drops a cue sitting in the silent gap', () => {
  const pcm = buildPcm([
    { seconds: 2, hz: 1000, amp: 0.5 },
    { seconds: 4, hz: 0, amp: 0 },     // instrumental/silent stretch
    { seconds: 2, hz: 1000, amp: 0.5 },
  ]);
  const activity = vocalMask(pcm, SR);

  const cues = [
    { timeMs: 500, text: 'real line' },
    { timeMs: 3000, text: 'hallucinated over the gap' },
    { timeMs: 6500, text: 'real again' },
  ];
  const kept = filterCuesByVocalActivity(cues, activity);
  assert.deepEqual(kept.map((c) => c.text), ['real line', 'real again']);
});

test('filterCuesByVocalActivity keeps everything when the track is fully voiced', () => {
  const pcm = buildPcm([{ seconds: 6, hz: 1000, amp: 0.5 }]);
  const activity = vocalMask(pcm, SR);
  const cues = [
    { timeMs: 0, text: 'a' },
    { timeMs: 2000, text: 'b' },
    { timeMs: 4000, text: 'c' },
  ];
  assert.equal(filterCuesByVocalActivity(cues, activity).length, 3);
});

test('filterCuesByVocalActivity keeps a cue whose window runs past the audio', () => {
  const pcm = buildPcm([{ seconds: 2, hz: 1000, amp: 0.5 }]);
  const activity = vocalMask(pcm, SR);
  const cues = [{ timeMs: 9000, text: 'beyond the recording' }];
  assert.equal(filterCuesByVocalActivity(cues, activity).length, 1);
});

test('filterCuesByVocalActivity tolerates empty input', () => {
  assert.deepEqual(filterCuesByVocalActivity([], { frameMs: 20, mask: new Uint8Array(10) }), []);
  const cues = [{ timeMs: 0, text: 'x' }];
  // No usable mask: keep the cues rather than deleting a transcription.
  assert.deepEqual(filterCuesByVocalActivity(cues, { frameMs: 20, mask: new Uint8Array(0) }), cues);
  assert.deepEqual(filterCuesByVocalActivity(cues, null), cues);
});

test('vocalMask handles an empty signal without dividing by zero', () => {
  const { mask, voicedFraction } = vocalMask(new Float32Array(0), SR);
  assert.equal(mask.length, 0);
  assert.equal(voicedFraction, 0);
});
