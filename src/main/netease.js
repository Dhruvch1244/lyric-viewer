'use strict';

const { scoreCandidate, parseLrc, cleanTitle } = require('./lyrics');

/**
 * NetEase Cloud Music as a second SYNCED lyric source.
 *
 * Coverage was the weakest quality axis: one and a half sources (LRCLIB synced,
 * LRCLIB plain) against Sonar's three. Adding a second *synced* source is worth
 * more than a second plain one, because a plain source still has to be aligned
 * by Whisper before it can scroll — a synced one just works, offline, on the
 * first play.
 *
 * NetEase is strong exactly where LRCLIB is weak: Mandarin and Cantonese pop,
 * K-pop, and a long tail of Asian releases. It also frequently carries an
 * official TRANSLATION track alongside the lyric (`tlyric`), which is better
 * than anything the LLM translator will produce because a human wrote it for
 * that song.
 *
 * ON METHOD. This is a public JSON endpoint that returns structured data, not
 * an HTML page being scraped. That distinction is the one this project already
 * draws (see artwork.js): scraping is brittle, breaks silently and carries ToS
 * risk. It is fair to note the API is not formally *documented* by NetEase —
 * it is the one their own web player uses — so it is treated as best-effort
 * throughout: every failure path returns null and the caller falls through to
 * the next source.
 */

const SEARCH_URL = 'https://music.163.com/api/search/get';
const LYRIC_URL = 'https://music.163.com/api/song/lyric';
const TIMEOUT_MS = 12_000;

/*
  NetEase rejects requests without a plausible browser Referer, returning an
  empty result set rather than an error — which would look exactly like "this
  song has no lyrics" and be very hard to diagnose.
*/
const HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

/**
 * Map a NetEase search result onto the candidate shape `scoreCandidate` wants.
 *
 * Deliberately reuses LRCLIB's scorer rather than writing a second one. The two
 * sources must agree about what "a good match" means, or the chain would prefer
 * a mediocre NetEase hit over a strong LRCLIB one purely because their scores
 * were on different scales.
 *
 * NetEase reports duration in milliseconds where LRCLIB uses seconds, which is
 * the kind of mismatch that silently poisons the duration bonus.
 *
 * @param {object} song a `result.songs[]` entry
 * @param {string} lrc the fetched LRC text, needed because the scorer requires it
 * @returns {object}
 */
function toCandidate(song, lrc) {
  const artists = Array.isArray(song.artists) ? song.artists : (song.ar || []);
  return {
    trackName: song.name || '',
    artistName: artists.map((a) => a && a.name).filter(Boolean).join(', '),
    albumName: (song.album && song.album.name) || (song.al && song.al.name) || '',
    duration: Math.round((song.duration || song.dt || 0) / 1000),
    syncedLyrics: lrc,
  };
}

/**
 * Search NetEase for a track.
 * @param {{title: string, artist: string}} track
 * @returns {Promise<object[]>} raw song rows; empty on any failure
 */
async function search(track) {
  const q = [cleanTitle(track.title), track.artist].filter(Boolean).join(' ').trim();
  if (!q) return [];

  const url = `${SEARCH_URL}?s=${encodeURIComponent(q)}&type=1&limit=10&offset=0`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const json = await res.json();
    const songs = json && json.result && json.result.songs;
    return Array.isArray(songs) ? songs : [];
  } catch {
    return [];
  }
}

/**
 * Fetch the LRC (and any official translation) for one NetEase song id.
 * @param {number|string} id
 * @returns {Promise<{lrc: string, translated: string}|null>}
 */
async function lyricFor(id) {
  const url = `${LYRIC_URL}?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json();
    const lrc = json && json.lrc && typeof json.lrc.lyric === 'string' ? json.lrc.lyric : '';
    const translated = json && json.tlyric && typeof json.tlyric.lyric === 'string'
      ? json.tlyric.lyric : '';
    if (!lrc.trim()) return null;
    return { lrc, translated };
  } catch {
    return null;
  }
}

/*
  Credit lines.

  NetEase LRCs almost always open with production credits stamped at 00:00 —
  `作词 : …` (lyricist), `作曲 : …` (composer), `编曲 : …` (arranger) and friends.
  They are not lyrics, and unstripped they became the FIRST LINE of every song
  this source returned: measured on three live lookups, all three began with a
  credit rather than a word anyone sings.

  Matched by prefix rather than by position, because the count varies from one
  to six and a fixed skip would either leave some in or eat a real opening line.
*/
const CREDIT_PREFIX = /^\s*(作词|作曲|编曲|制作人|监制|混音|母带|和声|录音|吉他|贝斯|鼓|键盘|策划|出品|录音室|词|曲)\s*[:：]/;
const CREDIT_LATIN = /^\s*(lyricist|composer|arranger|produced by|written by|mixing|mastering|recorded by|lyrics by|composed by|arranged by|producer|mixed by|mastered by)\s*[:：]/i;

/**
 * Drop leading production-credit lines from a parsed LRC.
 *
 * Only from the FRONT: a line later in the song that happens to start with one
 * of these words is far more likely to be a lyric than a credit, and removing
 * it would punch a hole in the middle of the track.
 *
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Array<{timeMs: number, text: string}>}
 */
function stripCredits(cues, titleHint) {
  if (!Array.isArray(cues)) return [];

  /*
    Kugou (and some NetEase entries) open with a header line rather than a
    credit: "ALL THE TIME - John Summit/The Chainsmokers/Ilsey". It matches no
    credit prefix, so it used to survive and become the song's first lyric —
    the words on screen at the moment the track starts.

    Matched against the title we were looking for rather than by shape, because
    "<something> - <something>" is a perfectly ordinary lyric line.
  */
  const hint = String(titleHint || '').trim().toLowerCase();
  let i = 0;
  if (hint && cues.length > 0) {
    const first = String((cues[0] && cues[0].text) || '').trim().toLowerCase();
    if (first.startsWith(hint) && first.slice(hint.length).trim().startsWith('-')) i = 1;
  }

  while (i < cues.length) {
    const text = (cues[i] && cues[i].text) || '';
    if (!CREDIT_PREFIX.test(text) && !CREDIT_LATIN.test(text)) break;
    i += 1;
  }
  // Never strip everything: a file that is nothing but credits has no lyrics,
  // and returning an empty list lets the caller fall through to the next source
  // rather than showing a blank song.
  return i >= cues.length ? [] : cues.slice(i);
}

/**
 * Align an official translation onto the lyric cues BY TIMESTAMP.
 *
 * NetEase ships the translation as its own LRC with its own stamps, and it is
 * routinely shorter than the original — untranslated interjections and repeated
 * hooks are simply absent. Zipping the two lists by index would therefore
 * caption most of the song with the wrong line, which is precisely the failure
 * `updateTranslation` already guards against by requiring equal lengths.
 *
 * Matching on time instead produces a list of exactly the right length, with
 * blanks where the translation had nothing to say.
 *
 * Pure, and the reason this file has tests.
 *
 * @param {Array<{timeMs: number}>} cues
 * @param {Array<{timeMs: number, text: string}>} translated
 * @param {number} [toleranceMs] how far apart two stamps may be and still pair
 * @returns {Array<{timeMs: number, text: string}>|null} null if nothing matched
 */
function alignTranslation(cues, translated, toleranceMs = 400) {
  if (!Array.isArray(cues) || !Array.isArray(translated) || translated.length === 0) return null;

  let matched = 0;
  const out = cues.map((cue) => {
    let best = null;
    let bestDelta = Infinity;
    for (const t of translated) {
      const delta = Math.abs(t.timeMs - cue.timeMs);
      if (delta < bestDelta) { bestDelta = delta; best = t; }
    }
    if (best && bestDelta <= toleranceMs && (best.text || '').trim()) {
      matched += 1;
      return { timeMs: cue.timeMs, text: best.text };
    }
    return { timeMs: cue.timeMs, text: '' };
  });

  // A handful of coincidental pairings is not a translation. Requiring a third
  // of the song keeps an unrelated stamp set from being presented as one.
  if (matched < Math.max(3, Math.ceil(cues.length * 0.33))) return null;
  return out;
}

/**
 * Look up synced lyrics on NetEase.
 *
 * Same return shape as `fetchSyncedLyrics` in lyrics.js so the caller can treat
 * the sources interchangeably, plus `cuesEnglish` when an official translation
 * came back with it.
 *
 * @param {{title: string, artist: string, durationMs: number}} track
 * @returns {Promise<{cues: Array, cuesEnglish: Array|null, source: object}|null>}
 */
async function fetchNeteaseSynced(track) {
  const songs = await search(track);
  if (songs.length === 0) return null;

  /*
    Scored AFTER fetching the lyric, not before, because the scorer requires the
    lyric text — it refuses any candidate without line-level sync, which is the
    whole point of this source. Capped at the top few by search rank so a miss
    costs three small requests rather than ten.
  */
  let best = null;
  let bestScore = 0;

  for (const song of songs.slice(0, 4)) {
    const id = song.id || song.songId;
    if (!id) continue;
    const got = await lyricFor(id);
    if (!got) continue;

    const candidate = toCandidate(song, got.lrc);
    const score = scoreCandidate(candidate, track);
    if (score > bestScore) {
      bestScore = score;
      best = { song, candidate, ...got };
    }
  }

  // The same acceptance bar LRCLIB uses. Showing the wrong song's lyrics is
  // worse than showing none, and this source runs only after LRCLIB missed.
  if (!best || bestScore < 1.0) return null;

  const cues = stripCredits(parseLrc(best.lrc));
  if (cues.length === 0) return null;

  /*
    THE TRANSLATION TRACK IS NOT USED, and that is a deliberate reversal.

    NetEase ships `tlyric` alongside a lot of its catalogue and it was wired
    into `cuesEnglish` here, on the reasoning that a human translation beats an
    LLM one. Checking it against three live lookups killed that: NetEase is a
    Chinese service, so `tlyric` is the translation *into Chinese*. Two of the
    three test tracks were English songs whose "translation" was Mandarin —
    which would have captioned every English line with Chinese under a chip
    labelled EN.

    `alignTranslation` is kept and tested because the timestamp-matching it does
    is the right shape for any source-supplied translation, and NetEase is
    unlikely to be the last one. It simply has no correct caller yet.
  */

  return {
    cues,
    cuesDevanagari: null,
    cuesEnglish: null,
    source: {
      name: 'netease',
      id: best.song.id,
      trackName: best.candidate.trackName,
      artistName: best.candidate.artistName,
      score: Number(bestScore.toFixed(2)),
    },
  };
}

module.exports = { fetchNeteaseSynced, alignTranslation, toCandidate, stripCredits };
