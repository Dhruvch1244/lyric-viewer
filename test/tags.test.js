'use strict';

/*
  Unit tests for ID3 reading (src/main/tags.js).

  The parser exists so local files can be identified without a dependency. What
  matters is that it reads the two frames it claims to, survives the tag
  variants actually found in the wild (v2.2's shorter frame ids, v2.4's
  synchsafe sizes, UTF-16), and falls back to the filename rather than throwing
  when a file has no usable tag at all.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseId3, identify } = require('../src/main/tags.js');

/** Encode n as a 4-byte synchsafe integer. */
function synchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** Build an ID3v2.3 tag with latin1 text frames. */
function tagV23(frames) {
  const bodies = frames.map(([id, text]) => {
    const payload = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  });
  const body = Buffer.concat(bodies);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(body.length),
  ]);
  return Buffer.concat([header, body]);
}

test('reads title and artist from a v2.3 tag', () => {
  const buf = tagV23([['TIT2', 'Nazar'], ['TPE1', 'Seedhe Maut']]);
  assert.deepEqual(parseId3(buf), { title: 'Nazar', artist: 'Seedhe Maut' });
});

test('reads frames in either order and ignores ones it does not want', () => {
  const buf = tagV23([['TALB', 'Bayaan'], ['TPE1', 'Calm'], ['TIT2', 'Kya Hua']]);
  assert.deepEqual(parseId3(buf), { title: 'Kya Hua', artist: 'Calm' });
});

test('handles a v2.4 tag, whose frame sizes are synchsafe', () => {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from('Nazar', 'latin1')]);
  const frame = Buffer.concat([
    Buffer.from('TIT2', 'latin1'), synchsafe(payload.length), Buffer.from([0, 0]), payload,
  ]);
  const buf = Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), synchsafe(frame.length), frame,
  ]);
  assert.equal(parseId3(buf).title, 'Nazar');
});

test('decodes UTF-16 text, which is what non-Latin titles arrive as', () => {
  const text = Buffer.from('\ufeffनज़र', 'utf16le');
  const payload = Buffer.concat([Buffer.from([1]), text]);
  const head = Buffer.alloc(10);
  head.write('TIT2', 0, 'latin1');
  head.writeUInt32BE(payload.length, 4);
  const frame = Buffer.concat([head, payload]);
  const buf = Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(frame.length), frame,
  ]);
  assert.equal(parseId3(buf).title, 'नज़र');
});

test('returns empties rather than throwing on junk', () => {
  assert.deepEqual(parseId3(null), { title: '', artist: '' });
  assert.deepEqual(parseId3(Buffer.alloc(4)), { title: '', artist: '' });
  assert.deepEqual(parseId3(Buffer.from('NOTATAG.......')), { title: '', artist: '' });
  // Truncated mid-frame: stop cleanly with whatever was already read.
  const good = tagV23([['TIT2', 'Nazar'], ['TPE1', 'Seedhe Maut']]);
  assert.doesNotThrow(() => parseId3(good.subarray(0, 24)));
});

test('identify falls back to an "Artist - Title" filename', () => {
  const empty = Buffer.alloc(0);
  assert.deepEqual(identify('C:/music/Seedhe Maut - Nazar.mp3', empty),
    { artist: 'Seedhe Maut', title: 'Nazar' });
  // En dash, as pasted from streaming sites.
  assert.deepEqual(identify('/m/DIVINE – Mera Bhai.flac', empty),
    { artist: 'DIVINE', title: 'Mera Bhai' });
  // A title containing a hyphen must not be truncated at the second one.
  assert.equal(identify('/m/KRSNA - Freeverse - Feast.mp3', empty).title, 'Freeverse - Feast');
  // No separator at all: the whole name is the title.
  assert.deepEqual(identify('/m/track01.mp3', empty), { artist: '', title: 'track01' });
});

test('tags win over the filename when both are present', () => {
  const buf = tagV23([['TIT2', 'Real Title'], ['TPE1', 'Real Artist']]);
  assert.deepEqual(identify('/m/Wrong - Name.mp3', buf),
    { title: 'Real Title', artist: 'Real Artist' });
});
