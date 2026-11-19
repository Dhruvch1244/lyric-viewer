'use strict';

/*
  The music video's pure parts (src/renderer/music-video.js): reading a pasted
  link, the first offset guess, and the sync decision that keeps the video on
  the song without fighting it (no seek storms, no seeking past the end).
*/

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../src/renderer/music-video.js');
const { parseVideoId, initialOffset, syncAction } = global.window.MusicVideo;

test('every common YouTube link shape gives the id, and junk gives null', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}?rel=0`,
    `youtube.com/watch?v=${id}`,
    `  ${id}  `,
  ]) assert.equal(parseVideoId(s), id, s);
  for (const s of ['', 'hello', 'https://vimeo.com/123', 'https://youtube.com/watch?v=short', 'https://evil.com/watch?v=dQw4w9WgXcQ']) {
    assert.equal(parseVideoId(s), null, s);
  }
});

test('the first offset guess treats a modest extra length as an intro', () => {
  assert.equal(initialOffset(250, 240), 10);
  assert.equal(initialOffset(241, 240), 0, 'a second over is just rounding');
  assert.equal(initialOffset(330, 240), 0, 'a long overrun is not assumed to be an intro');
  assert.equal(initialOffset(230, 240), 0, 'a shorter video starts at the start');
  assert.equal(initialOffset(0, 240), 0);
  assert.equal(initialOffset(250, 0), 0);
});

test('sync: seeks when off by more than the tolerance, but not again straight away', () => {
  const base = { playing: true, wantPlaying: true, duration: 300 };
  assert.equal(syncAction({ ...base, videoTime: 50, target: 50.2, sinceSeekMs: 5000 }), null);
  assert.equal(syncAction({ ...base, videoTime: 50, target: 51, sinceSeekMs: 5000 }), 'seek');
  assert.equal(syncAction({ ...base, videoTime: 50, target: 51, sinceSeekMs: 400 }), null, 'a seek is still landing');
});

test('sync: follows play/pause, and holds before the video starts or after it ends', () => {
  assert.equal(syncAction({ videoTime: 10, target: 10, playing: true, wantPlaying: false, sinceSeekMs: 5000, duration: 300 }), 'pause');
  assert.equal(syncAction({ videoTime: 10, target: 10, playing: false, wantPlaying: true, sinceSeekMs: 5000, duration: 300 }), 'play');
  assert.equal(syncAction({ videoTime: 0, target: -3, playing: true, wantPlaying: true, sinceSeekMs: 5000, duration: 300 }), 'pause', 'song is ahead of the video start');
  assert.equal(syncAction({ videoTime: 299, target: 310, playing: true, wantPlaying: true, sinceSeekMs: 5000, duration: 300 }), 'pause', 'past the end');
  assert.equal(syncAction({ videoTime: 0, target: -3, playing: false, wantPlaying: true, sinceSeekMs: 5000, duration: 300 }), null);
});

test('local sync eases small drift through the rate and seeks only on a jump', () => {
  const { localSync } = global.window.MusicVideo;
  const base = { wantPlaying: true, duration: 200 };
  assert.deepEqual(localSync({ ...base, videoTime: 50, target: 50 }), { action: 'steer', rate: 1 });
  const ahead = localSync({ ...base, videoTime: 50, target: 50.1 });
  assert.equal(ahead.action, 'steer');
  assert.ok(ahead.rate > 1 && ahead.rate <= 1.1, 'behind the song: play a little fast');
  const behind = localSync({ ...base, videoTime: 50.1, target: 50 });
  assert.ok(behind.rate < 1 && behind.rate >= 0.9, 'ahead of the song: play a little slow');
  assert.equal(localSync({ ...base, videoTime: 50, target: 52 }).action, 'seek');
  assert.equal(localSync({ ...base, videoTime: 50, target: 50.3 }).rate, 1.1, 'rate is clamped to ±10%');
});

test('local sync pauses when the song does, or when the song is outside the video', () => {
  const { localSync } = global.window.MusicVideo;
  assert.equal(localSync({ wantPlaying: false, videoTime: 5, target: 5, duration: 200 }).action, 'pause');
  assert.equal(localSync({ wantPlaying: true, videoTime: 0, target: -3, duration: 200 }).action, 'pause');
  assert.equal(localSync({ wantPlaying: true, videoTime: 199, target: 205, duration: 200 }).action, 'pause');
});

test('video files get the MIME type their container needs', () => {
  const { videoMime } = global.window.MusicVideo;
  assert.equal(videoMime('/v/dQw4w9WgXcQ.mp4'), 'video/mp4');
  assert.equal(videoMime('C:\\Videos\\Song.WEBM'), 'video/webm');
  assert.equal(videoMime('song.mkv'), 'video/x-matroska');
  assert.equal(videoMime('song'), 'video/mp4');
});
