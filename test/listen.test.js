'use strict';

/*
  Unit tests for the recorder choice in src/renderer/listen.js.

  Two recorders, one slot, and a backend round trip in the middle of claiming
  it — that middle is why this module was split out of renderer.js. The
  failures worth catching are all invisible ones: a recording started against
  the song that just ended, two recorders running at once, or a native
  recording left running in the backend with nothing in the renderer that
  remembers it exists.

  Everything below drives the real module through fake dependencies that
  record what they were asked to do, which is the only way to assert the
  teardown happened — a leaked recorder produces no error, just a temp file
  nobody deletes.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/listen.js');
const { create } = global.window.TranscriptionListen;

/**
 * A fake backend + capture pair that logs every call.
 * @param {{native?: boolean|Promise<boolean>, capture?: boolean, isolation?: boolean, pcm?: any}} opts
 */
function harness(opts = {}) {
  const calls = [];
  const player = {
    startNativeSongRecording: () => {
      calls.push('start-native');
      return Promise.resolve(opts.native !== false);
    },
    stopNativeSongRecording: (track, language) => {
      calls.push(`stop-native:${track.title}:${language}`);
      return Promise.resolve({ status: 'queued' });
    },
    discardNativeSongRecording: () => { calls.push('discard-native'); },
    transcribeAudio: (payload) => {
      calls.push(`transcribe:${payload.track.title}:${payload.language}:${payload.vocalIsolation}`);
      return Promise.resolve({ status: 'ok' });
    },
  };
  const capture = {
    start: () => { calls.push('start-capture'); return opts.capture !== false; },
    reset: () => { calls.push('reset-capture'); },
    take: () => { calls.push('take-capture'); return 'pcm' in opts ? opts.pcm : new Float32Array(4); },
  };
  const listener = create({
    player,
    getCapture: () => (opts.capture === null ? null : capture),
    wantsIsolation: () => Boolean(opts.isolation),
  });
  return { calls, player, capture, listener };
}

const SONG = { title: 'Bhairav', artist: 'Seedhe Maut' };
const NEXT = { title: 'Nanchaku', artist: 'Seedhe Maut' };

test('the native recorder is preferred when the backend accepts', async () => {
  const h = harness();
  assert.equal(await h.listener.begin(SONG), 'native');
  assert.deepEqual(h.calls, ['start-native']);
  assert.equal(h.listener.mode(), 'native');
  assert.equal(h.listener.track(), SONG);
});

test('a backend that cannot record falls back to the webview recorder', async () => {
  // This is the getDisplayMedia case: AudioReactive is active, but the audio
  // only exists as a MediaStream in this process, so there is no WASAPI
  // thread to tap. The renderer cannot tell from isActive() alone — it asks.
  const h = harness({ native: false });
  assert.equal(await h.listener.begin(SONG), 'webview');
  assert.deepEqual(h.calls, ['start-native', 'start-capture']);
});

test('vocal isolation forces the webview recorder without asking the backend', async () => {
  // Demucs is not in the sidecar, so the native path physically cannot honour
  // the setting. Starting a native recording and discovering that later would
  // silently drop the isolation the user asked for.
  const h = harness({ isolation: true });
  assert.equal(await h.listener.begin(SONG), 'webview');
  assert.deepEqual(h.calls, ['start-capture'], 'the backend was asked despite isolation being on');
});

test('a rejected native start is treated as a refusal, not an error', async () => {
  const h = harness();
  h.player.startNativeSongRecording = () => Promise.reject(new Error('command missing'));
  assert.equal(await h.listener.begin(SONG), 'webview');
});

test('a backend with no native recording command at all still records', async () => {
  // An older backend against a newer frontend. The command is simply absent
  // rather than failing, and the webview path must pick it up.
  const h = harness();
  delete h.player.startNativeSongRecording;
  assert.equal(await h.listener.begin(SONG), 'webview');
  assert.deepEqual(h.calls, ['start-capture']);
});

test('when neither recorder starts, the slot is released for a later retry', async () => {
  const h = harness({ native: false, capture: false });
  assert.equal(await h.listener.begin(SONG), null);
  assert.equal(h.listener.isListening(), false, 'the song is still marked as being recorded');
  // And a second attempt actually gets to try again.
  assert.deepEqual(h.calls, ['start-native', 'start-capture']);
});

test('a second begin while one is active is a no-op', async () => {
  const h = harness();
  await h.listener.begin(SONG);
  assert.equal(await h.listener.begin(NEXT), null);
  assert.equal(h.listener.track(), SONG, 'the second song took over the slot');
  assert.deepEqual(h.calls, ['start-native']);
});

test('a begin racing another begin cannot start two recorders', async () => {
  // Both calls are in flight before either backend promise resolves — the
  // slot has to be claimed synchronously for the second to bounce.
  const h = harness();
  const a = h.listener.begin(SONG);
  const b = h.listener.begin(SONG);
  assert.deepEqual(await Promise.all([a, b]), ['native', null]);
  assert.deepEqual(h.calls, ['start-native']);
});

test('a track change during a native start undoes the recording it just began', async () => {
  // The window this module exists for: `begin` awaits one backend round trip,
  // and the song can end inside it. Leaving the recording running would leave
  // the backend writing a temp file attributed to nothing.
  const h = harness();
  const started = h.listener.begin(SONG);
  h.listener.stop();                       // arrives while the start is in flight
  assert.equal(await started, null);
  assert.deepEqual(h.calls, ['start-native', 'discard-native']);
  assert.equal(h.listener.isListening(), false);
});

test('a track change during a webview start resets the capture it just began', async () => {
  const h = harness({ native: false });
  const started = h.listener.begin(SONG);
  h.listener.stop();
  assert.equal(await started, null);
  assert.deepEqual(h.calls, ['start-native', 'start-capture', 'reset-capture']);
});

test('stopping a pending listen tears down nothing, because nothing started yet', () => {
  const h = harness();
  h.listener.begin(SONG);                  // deliberately not awaited
  assert.equal(h.listener.mode(), 'pending');
  h.listener.stop();
  assert.deepEqual(h.calls, ['start-native'], 'tore down a recorder that had not started');
});

test('flushing a pending listen sends nothing', () => {
  // Same window as above, reached by a track change rather than a cancel.
  // There is no recording yet, so there is nothing to transcribe — and asking
  // the backend to stop one it never started would be a spurious error.
  const h = harness();
  h.listener.begin(SONG);
  assert.equal(h.listener.flush({}), null);
  assert.deepEqual(h.calls, ['start-native']);
});

test('stop discards a native recording rather than transcribing it', async () => {
  const h = harness();
  await h.listener.begin(SONG);
  h.listener.stop();
  assert.deepEqual(h.calls, ['start-native', 'discard-native']);
  assert.equal(h.listener.isListening(), false);
});

test('stop resets a webview recording', async () => {
  const h = harness({ native: false });
  await h.listener.begin(SONG);
  h.listener.stop();
  assert.deepEqual(h.calls, ['start-native', 'start-capture', 'reset-capture']);
});

test('stop with nothing listening does nothing', () => {
  const h = harness();
  h.listener.stop();
  assert.deepEqual(h.calls, []);
});

test('flush hands the native recording back under the song it belongs to', async () => {
  // The whole reason the track is held: the flush happens on the track change,
  // by which point `currentTrack` is already the NEXT song.
  const h = harness();
  await h.listener.begin(SONG);
  assert.equal(h.listener.flush({ language: 'hi' }), 'native');
  assert.deepEqual(h.calls, ['start-native', 'stop-native:Bhairav:hi']);
  assert.equal(h.listener.isListening(), false);
});

test('flush sends the webview recording through transcribeAudio', async () => {
  // Isolation on, so the recorder is webview from the start and the flag has
  // to survive all the way to transcribeAudio — dropping it there would
  // silently transcribe the full mix.
  const h = harness({ isolation: true });
  await h.listener.begin(SONG);
  assert.equal(h.listener.flush({ language: 'hi' }), 'webview');
  assert.deepEqual(h.calls, ['start-capture', 'take-capture', 'transcribe:Bhairav:hi:true']);
});

test('a webview recording with too little audio is dropped, not sent', async () => {
  // capture.take() returns null below its own MIN_USEFUL_SECONDS.
  const h = harness({ native: false, pcm: null });
  await h.listener.begin(SONG);
  assert.equal(h.listener.flush({}), null);
  assert.deepEqual(h.calls, ['start-native', 'start-capture', 'take-capture']);
});

test('flush with nothing listening does nothing', () => {
  const h = harness();
  assert.equal(h.listener.flush({}), null);
  assert.deepEqual(h.calls, []);
});

test('the slot is free again immediately after a flush, so the next song can be recorded', async () => {
  const h = harness();
  await h.listener.begin(SONG);
  h.listener.flush({});
  assert.equal(await h.listener.begin(NEXT), 'native');
  assert.equal(h.listener.track(), NEXT);
});

test('a missing PcmCapture degrades to native-only rather than throwing', async () => {
  // capture.js is only needed for the fallback path. If it is absent, the
  // native recorder must still work and the fallback must decline quietly.
  const h = harness({ capture: null, native: false });
  assert.equal(await h.listener.begin(SONG), null);
  assert.equal(h.listener.isListening(), false);
});

test('a native flush surviving a rejected backend call still frees the slot', async () => {
  const h = harness();
  h.player.stopNativeSongRecording = () => Promise.reject(new Error('busy'));
  await h.listener.begin(SONG);
  assert.equal(h.listener.flush({}), 'native');
  assert.equal(h.listener.isListening(), false);
  assert.equal(await h.listener.begin(NEXT), 'native');
});
