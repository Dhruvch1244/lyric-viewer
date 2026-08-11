'use strict';

const { scoreCandidate, parseLrc } = require('./lyrics');
const { stripCredits } = require('./netease');

/**
 * Kugou as a THIRD synced lyric source.
 *
 * WHY A THIRD. Coverage is the axis this app is weakest on against dedicated
 * lyric apps, and a synced source is worth several plain ones: a plain lyric
 * has to be aligned by Whisper before it can scroll, which costs minutes of CPU
 * and only pays off from the next play, where a synced one works immediately
 * and offline. LRCLIB then NetEase then this: three, which matches the best of
 * the competition.
 *
 * WHY KUGOU SPECIFICALLY. It is the same shape as NetEase — public JSON, no
 * key, real LRC — and its catalogue overlaps NetEase's less than you would
 * expect for two Chinese services, because Kugou carries a large amount of
 * Western dance and pop with community-contributed timings. Verified on a
 * track LRCLIB has: it returned correct synced lyrics.
 *
 * ON METHOD. Public JSON endpoints returning structured data, not an HTML page
 * being scraped — the distinction artwork.js draws and this project follows.
 * Like NetEase's, these are the endpoints Kugou's own clients use rather than a
 * documented API, so everything here is best-effort: every failure path returns
 * null and the caller falls through.
 *
 * THE ONE STRUCTURAL DIFFERENCE from NetEase is that lyrics are not addressed
 * by song id. Kugou keys them by the audio file's `hash`, and fetching one
 * takes three requests: find the song to get a hash, ask which lyric documents
 * match that hash, then download one with the `accesskey` that answer carries.
 * There is no way to shorten it — the accesskey is issued per lookup.
 */

const SEARCH_URL = 'https://mobiles.kugou.com/api/v3/search/song';
const LYRIC_SEARCH_URL = 'https://lyrics.kugou.com/search';
const LYRIC_DOWNLOAD_URL = 'https://lyrics.kugou.com/download';
const TIMEOUT_MS = 12_000;

/** How many search hits to try. Each costs two further requests. */
const MAX_CANDIDATES = 3;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

/**
 * @param {string} url
 * @returns {Promise<object|null>} parsed JSON, or null on any failure
 */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Offline, blocked, rate-limited, or something that was not JSON. All of
    // them mean the same thing to the caller: try the next source.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find songs matching a track.
 * @param {{title: string, artist: string}} track
 * @returns {Promise<object[]>}
 */
async function search(track) {
  const query = [track.title, track.artist].filter(Boolean).join(' ').trim();
  if (!query) return [];
  const url = `${SEARCH_URL}?format=json&keyword=${encodeURIComponent(query)}`
    + `&page=1&pagesize=${MAX_CANDIDATES * 2}`;
  const json = await getJson(url);
  const info = json && json.data && json.data.info;
  return Array.isArray(info) ? info : [];
}

/**
 * Fetch the best lyric document for a song hash.
 *
 * Kugou returns several candidates per hash — an official one and any number of
 * user submissions. `官方推荐歌词` ("officially recommended lyrics") is preferred
 * where present, because user submissions are where the badly-timed ones live.
 *
 * @param {string} hash
 * @returns {Promise<string|null>} LRC text
 */
async function lyricForHash(hash) {
  if (!hash) return null;
  const found = await getJson(
    `${LYRIC_SEARCH_URL}?ver=1&man=yes&client=pc&hash=${encodeURIComponent(hash)}`,
  );
  const candidates = found && Array.isArray(found.candidates) ? found.candidates : [];
  if (candidates.length === 0) return null;

  const official = candidates.find((c) => String(c.product_from || '').includes('官方'));
  const pick = official || candidates[0];
  if (!pick || !pick.id || !pick.accesskey) return null;

  const doc = await getJson(
    `${LYRIC_DOWNLOAD_URL}?ver=1&client=pc&fmt=lrc&charset=utf8`
    + `&id=${encodeURIComponent(pick.id)}&accesskey=${encodeURIComponent(pick.accesskey)}`,
  );
  if (!doc || !doc.content) return null;

  try {
    // The payload is base64 whatever `fmt` was asked for.
    return Buffer.from(doc.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Map a Kugou search hit onto the shape `scoreCandidate` wants.
 *
 * Reuses LRCLIB's scorer rather than writing a third one, for the reason
 * netease.js gives: three sources must agree what "a good match" means, or the
 * chain prefers a mediocre hit from one over a strong hit from another purely
 * because their scores are on different scales.
 *
 * Kugou reports `duration` in SECONDS in the song search (NetEase uses
 * milliseconds), which is the kind of mismatch that silently poisons the
 * duration bonus and makes every candidate look like a different edit.
 *
 * @param {object} song a `data.info[]` entry
 * @param {string} lrc
 * @returns {object}
 */
function toCandidate(song, lrc) {
  return {
    trackName: song.songname_original || song.songname || '',
    /* `singername` uses a Chinese enumeration comma between artists; the
       scorer tokenises on non-word characters, so it only needs to not be a
       word character — but normalising keeps logs and `source.artistName`
       readable. */
    artistName: String(song.singername || '').replace(/、/g, ', '),
    duration: Number(song.duration) || 0,
    syncedLyrics: lrc,
  };
}

/**
 * Look up synced lyrics on Kugou.
 *
 * @param {{title: string, artist: string, durationMs: number}} track
 * @returns {Promise<{cues: object[], source: object}|null>}
 */
async function fetchKugouSynced(track) {
  const songs = await search(track);
  if (songs.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const song of songs.slice(0, MAX_CANDIDATES)) {
    const hash = song.hash || song.Hash;
    if (!hash) continue;
    // Scored after fetching, like NetEase: the scorer refuses any candidate
    // without line-level sync, which is the entire point of this source.
    const lrc = await lyricForHash(hash);
    if (!lrc) continue;

    const candidate = toCandidate(song, lrc);
    const score = scoreCandidate(candidate, track);
    if (score > bestScore) {
      bestScore = score;
      best = { song, candidate, lrc };
    }
  }

  // The same acceptance bar LRCLIB and NetEase use. Showing the wrong song's
  // lyrics is worse than showing none, and this source runs only after both
  // of those have missed.
  if (!best || bestScore < 1.0) return null;

  /* Kugou puts the credit block in timed lines at the top of the LRC — title,
     composer, lyricist, arranger — exactly as NetEase does, so the same
     stripper handles it. Left in, a song opens with twenty seconds of
     production credits scrolling past as though they were the words. */
  const cues = stripCredits(parseLrc(best.lrc), best.candidate.trackName);
  if (cues.length === 0) return null;

  return {
    cues,
    cuesDevanagari: null,
    cuesEnglish: null,
    source: {
      name: 'kugou',
      id: best.song.hash,
      trackName: best.candidate.trackName,
      artistName: best.candidate.artistName,
      score: Number(bestScore.toFixed(2)),
    },
  };
}

module.exports = { fetchKugouSynced, toCandidate, lyricForHash };
