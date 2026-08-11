'use strict';

const path = require('path');

/*
  Minimal ID3v2 tag reading.

  Only the two frames that matter here — title and artist — and deliberately no
  dependency: a tag parser is a few dozen lines for this subset, and the project
  already carries three large runtime dependencies.

  Anything unreadable falls back to the filename, which for a music library is
  usually "Artist - Title.mp3" and is right more often than a missing tag is.
  Getting this wrong is cheap: the identity only feeds the lyric lookup, which
  already tolerates a bad guess by finding nothing.
*/

/** ID3v2 sizes are "synchsafe": 7 bits per byte, top bit always clear. */
function synchsafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21)
    | ((buf[offset + 1] & 0x7f) << 14)
    | ((buf[offset + 2] & 0x7f) << 7)
    | (buf[offset + 3] & 0x7f);
}

/**
 * Decode one text frame's payload, honouring its encoding byte.
 * @param {Buffer} buf @returns {string}
 */
function decodeText(buf) {
  if (buf.length < 2) return '';
  const encoding = buf[0];
  const body = buf.subarray(1);
  let text;
  if (encoding === 1) text = body.toString('utf16le');        // UTF-16 with BOM
  else if (encoding === 2) text = body.swap16().toString('utf16le'); // UTF-16BE
  else if (encoding === 3) text = body.toString('utf8');
  else text = body.toString('latin1');
  // Strip a BOM and any trailing NULs used as padding/terminator.
  return text.replace(/^﻿/, '').replace(/\0+$/, '').trim();
}

/**
 * Read title/artist from an ID3v2 header.
 *
 * @param {Buffer} buf the first few KB of the file is enough
 * @returns {{title: string, artist: string}} empty strings when absent
 */
function parseId3(buf) {
  const none = { title: '', artist: '' };
  if (!buf || buf.length < 10) return none;
  if (buf.toString('latin1', 0, 3) !== 'ID3') return none;

  const major = buf[3];
  if (major < 2 || major > 4) return none;
  const size = synchsafe(buf, 6);
  const end = Math.min(buf.length, 10 + size);

  // v2.2 uses 3-character frame ids and 3-byte sizes; v2.3+ uses 4 and 4.
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;
  const TITLE = major === 2 ? 'TT2' : 'TIT2';
  const ARTIST = major === 2 ? 'TP1' : 'TPE1';

  const out = { title: '', artist: '' };
  let p = 10;
  while (p + headerLen <= end) {
    const id = buf.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;              // padding, or corrupt

    let frameSize;
    if (major === 2) {
      frameSize = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
    } else if (major === 4) {
      frameSize = synchsafe(buf, p + 4);             // v2.4 sizes are synchsafe
    } else {
      frameSize = buf.readUInt32BE(p + 4);
    }
    if (frameSize <= 0 || p + headerLen + frameSize > end) break;

    const body = buf.subarray(p + headerLen, p + headerLen + frameSize);
    if (id === TITLE) out.title = decodeText(body);
    else if (id === ARTIST) out.artist = decodeText(body);
    if (out.title && out.artist) break;

    p += headerLen + frameSize;
  }
  return out;
}

/**
 * Best-effort artist/title for a file: tags first, filename second.
 *
 * @param {string} filePath
 * @param {Buffer} head the opening bytes of the file
 * @returns {{title: string, artist: string}}
 */
function identify(filePath, head) {
  const tags = parseId3(head);
  if (tags.title && tags.artist) return tags;

  const base = path.basename(filePath, path.extname(filePath));
  // "Artist - Title" is the near-universal convention. An en/em dash counts;
  // people paste those in from streaming sites all the time.
  const split = base.split(/\s+[-–—]\s+/);
  const fromName = split.length >= 2
    ? { artist: split[0].trim(), title: split.slice(1).join(' - ').trim() }
    : { artist: '', title: base.trim() };

  return {
    title: tags.title || fromName.title,
    artist: tags.artist || fromName.artist,
  };
}

module.exports = { parseId3, identify };
