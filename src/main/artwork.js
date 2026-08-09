'use strict';

const { cleanTitle, tokenSimilarity } = require('./lyrics');

/* Free, keyless artwork + credits lookup, tried across three sources so a miss on
   one still yields cover art:

     1. iTunes Search  — rich credits, cover upgradable to ~1000px.
     2. Deezer         — good catalogue coverage, `cover_xl` is 1000px.
     3. MusicBrainz + Cover Art Archive — long-tail / indie fallback.

   We download the image in the main process and hand the renderer a data: URI, so
   the strict page CSP (img-src 'self' data:) never has to allow a remote host.
   HTML scraping is deliberately avoided: it is brittle, breaks silently, and
   carries ToS risk — these are all documented JSON APIs. */
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const DEEZER_SEARCH = 'https://api.deezer.com/search';
const MB_SEARCH = 'https://musicbrainz.org/ws/2/recording';
const CAA_FRONT = 'https://coverartarchive.org/release';
/* MusicBrainz asks every client to identify itself (app/version + contact). */
const MB_UA = 'LyricOverlay/0.5 (https://github.com/dhruv-choudhary/lyric-overlay)';
const FETCH_TIMEOUT = 12_000;

/**
 * Download a remote image and encode it as a base64 data: URI.
 * @param {string} url absolute image URL
 * @returns {Promise<string|null>} data URI, or null on any failure
 */
async function downloadImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const mime = ct.startsWith('image/')
      ? ct
      : (/\.png$/i.test(url) ? 'image/png' : 'image/jpeg');
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Pick the highest-scoring candidate from a list against the SMTC track.
 * @template T
 * @param {T[]} results
 * @param {(r:T)=>{title:string, artist:string}} shape maps a result to its fields
 * @param {{artist:string}} track
 * @param {string} cleaned pre-cleaned title
 * @returns {T|null}
 */
function bestMatch(results, shape, track, cleaned) {
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const { title, artist } = shape(r);
    const t = tokenSimilarity(cleaned, title || '');
    const a = track.artist ? tokenSimilarity(track.artist, artist || '') : 0;
    const score = t * 2 + a;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best || results[0] || null;
}

/**
 * iTunes Search lookup.
 * @param {{title:string, artist:string}} track @param {string} cleaned @param {string} term
 * @returns {Promise<{artwork:string|null, artistName:string|null, trackName:string|null}|null>}
 */
async function itunesLookup(track, cleaned, term) {
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&limit=8`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];
  if (results.length === 0) return null;

  const best = bestMatch(
    results,
    (r) => ({ title: r.trackName, artist: r.artistName }),
    track,
    cleaned,
  );
  if (!best) return null;

  // Upgrade the thumbnail URL to a large square (iTunes serves "NNNxNNNbb.jpg").
  const rawUrl = best.artworkUrl100 || best.artworkUrl60 || '';
  const artUrl = rawUrl.replace(/\/\d+x\d+bb\.(jpg|png)/i, '/1000x1000bb.$1');
  return {
    artwork: await downloadImage(artUrl),
    artistName: best.artistName || null,
    trackName: best.trackName || null,
  };
}

/**
 * Deezer search lookup (keyless). `cover_xl` is a direct 1000px URL.
 * @param {{title:string, artist:string}} track @param {string} cleaned @param {string} term
 * @returns {Promise<{artwork:string|null, artistName:string|null, trackName:string|null}|null>}
 */
async function deezerLookup(track, cleaned, term) {
  const url = `${DEEZER_SEARCH}?q=${encodeURIComponent(term)}&limit=8`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  const json = await res.json();
  const results = Array.isArray(json.data) ? json.data : [];
  if (results.length === 0) return null;

  const best = bestMatch(
    results,
    (r) => ({ title: r.title, artist: r.artist && r.artist.name }),
    track,
    cleaned,
  );
  if (!best) return null;

  const album = best.album || {};
  const artUrl = album.cover_xl || album.cover_big || album.cover_medium || '';
  return {
    artwork: await downloadImage(artUrl),
    artistName: (best.artist && best.artist.name) || null,
    trackName: best.title || null,
  };
}

/**
 * MusicBrainz recording search → Cover Art Archive front image. Last-resort source
 * for long-tail / indie releases the commercial stores miss.
 * @param {{title:string, artist:string}} track @param {string} cleaned
 * @returns {Promise<{artwork:string|null, artistName:string|null, trackName:string|null}|null>}
 */
async function musicbrainzLookup(track, cleaned) {
  const parts = [`recording:"${cleaned}"`];
  if (track.artist) parts.push(`artist:"${track.artist}"`);
  const query = parts.join(' AND ');
  const url = `${MB_SEARCH}?query=${encodeURIComponent(query)}&fmt=json&limit=5`;

  const res = await fetch(url, {
    headers: { 'User-Agent': MB_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const recs = Array.isArray(json.recordings) ? json.recordings : [];
  if (recs.length === 0) return null;

  const best = recs[0];
  const credit = Array.isArray(best['artist-credit'])
    ? best['artist-credit'].map((a) => `${a.name || ''}${a.joinphrase || ''}`).join('').trim()
    : null;

  // Try the first few releases until one has a front image in the archive.
  let artwork = null;
  const releases = Array.isArray(best.releases) ? best.releases.slice(0, 3) : [];
  for (const rel of releases) {
    if (!rel.id) continue;
    artwork = await downloadImage(`${CAA_FRONT}/${rel.id}/front-500`);
    if (artwork) break;
  }

  return { artwork, artistName: credit || null, trackName: best.title || null };
}

/**
 * Look up cover art + full artist credit for a track, trying each source in turn.
 * Returns the first result that carries cover art; failing that, the first result
 * that at least carries a richer artist credit; otherwise null.
 *
 * @param {{title:string, artist:string, durationMs:number}} track
 * @returns {Promise<{artwork:string|null, artistName:string|null, trackName:string|null}|null>}
 */
async function fetchArtwork(track) {
  const cleaned = cleanTitle(track.title);
  const term = [cleaned, track.artist].filter(Boolean).join(' ').trim();
  if (!term) return null;

  const sources = [
    () => itunesLookup(track, cleaned, term),
    () => deezerLookup(track, cleaned, term),
    () => musicbrainzLookup(track, cleaned),
  ];

  let creditOnly = null;
  for (const run of sources) {
    let result;
    try {
      result = await run();
    } catch {
      result = null; // network/parse failure — fall through to the next source
    }
    if (!result) continue;
    if (result.artwork) return result;                 // best: art + credit
    if (!creditOnly && result.artistName) creditOnly = result; // keep the credit
  }

  return creditOnly;
}

module.exports = { fetchArtwork };
