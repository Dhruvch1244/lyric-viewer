'use strict';

const { cleanTitle, cleanArtist, tokenSimilarity, versionTags } = require('./lyrics');

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
/**
 * Minimum acceptable score.
 *
 * Scores run 0..3 (title similarity doubled, plus artist similarity). This
 * previously fell back to `results[0]` whenever nothing scored well, which is
 * how a search for an obscure track ended up showing a confidently wrong
 * cover: the API always returns *something*, and the first row was taken on
 * faith. Returning null instead lets the caller try the next source, and
 * showing no art is better than showing another band's album.
 */
const MIN_MATCH_SCORE = 0.55;

/**
 * Score one candidate against the track we are looking for.
 *
 * Split out of `bestMatch` so the candidate list can rank across sources using
 * exactly the same arithmetic the automatic pick uses. If these two ever
 * diverge, the panel would offer the user a "better" cover than the one the app
 * chose by itself, which is confusing in a way that is very hard to debug.
 *
 * @param {{title: string, artist: string}} candidate
 * @param {{artist?: string}} track
 * @param {string} cleaned pre-cleaned track title
 * @param {Set<string>} wantVersions version tags of the track title
 * @returns {number} 0..3-ish; higher is better
 */
function scoreCandidate(candidate, track, cleaned, wantVersions) {
  const artist = cleanArtist(track.artist || '');
  const t = tokenSimilarity(cleaned, candidate.title || '');
  const a = artist ? tokenSimilarity(artist, candidate.artist || '') : 0;
  let score = t * 2 + a;

  // Same version guard as the lyric matcher: a live or remix cut carries
  // different art from the studio release.
  const haveVersions = versionTags(candidate.title || '');
  let mismatch = 0;
  for (const tag of wantVersions) if (!haveVersions.has(tag)) mismatch += 1;
  for (const tag of haveVersions) if (!wantVersions.has(tag)) mismatch += 1;
  score -= mismatch * 0.5;

  return score;
}

function bestMatch(results, shape, track, cleaned) {
  const wantVersions = versionTags(track.title || '');

  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const score = scoreCandidate(shape(r), track, cleaned, wantVersions);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= MIN_MATCH_SCORE ? best : null;
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

/* ------------------------------------------------------------- candidates */
/*
  The automatic pick above returns a single winner, and it is right most of the
  time. When it is wrong there is nothing the user can do about it — which is
  one of the three long-standing complaints about artwork, alongside missing art
  and bad artist parsing.

  So the same three sources also feed a candidate list. Two deliberate
  differences from the automatic path:

    - MIN_MATCH_SCORE is NOT applied. The threshold exists to stop the app
      *asserting* a wrong cover; a person choosing from a grid can see at a
      glance which one is their album, and the near-misses the threshold rejects
      are exactly what they need when the automatic pick failed.

    - candidates carry a small thumbnail, not the full image. Downloading eight
      1000px covers to draw a grid of 120px tiles is minutes of bandwidth for
      nothing. The full-size image is fetched only for the one that is chosen.

  Thumbnails still have to be data URIs, because the page CSP is
  `img-src 'self' data: blob:` and deliberately allows no remote host.
*/

/** How many candidates to offer. Enough to find the right one, few enough to scan. */
const MAX_CANDIDATES = 9;

/** Small enough that nine of them are cheap; large enough to recognise. */
const THUMB_SIZE = 250;

/**
 * @typedef {object} ArtCandidate
 * @property {string} source   'iTunes' | 'Deezer' | 'Cover Art Archive'
 * @property {string} title    the release's own title, for disambiguating
 * @property {string} artist   the release's own artist
 * @property {number} score    ranking score, same scale as the automatic pick
 * @property {string} fullUrl  full-size image URL, downloaded only if chosen
 * @property {string} thumb    data URI of the small preview
 */

/** iTunes candidates. Its thumbnail URLs are resizable by pattern. */
async function itunesCandidates(track, cleaned, term, wantVersions) {
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&limit=8`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return [];
  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];

  return results
    .filter((r) => r.artworkUrl100 || r.artworkUrl60)
    .map((r) => {
      const raw = r.artworkUrl100 || r.artworkUrl60;
      return {
        source: 'iTunes',
        title: r.trackName || '',
        artist: r.artistName || '',
        score: scoreCandidate(
          { title: r.trackName, artist: r.artistName }, track, cleaned, wantVersions
        ),
        fullUrl: raw.replace(/\/\d+x\d+bb\.(jpg|png)/i, '/1000x1000bb.$1'),
        thumbUrl: raw.replace(/\/\d+x\d+bb\.(jpg|png)/i, `/${THUMB_SIZE}x${THUMB_SIZE}bb.$1`),
      };
    });
}

/** Deezer candidates. It serves named sizes rather than a resizable pattern. */
async function deezerCandidates(track, cleaned, term, wantVersions) {
  const url = `${DEEZER_SEARCH}?q=${encodeURIComponent(term)}&limit=8`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return [];
  const json = await res.json();
  const results = Array.isArray(json.data) ? json.data : [];

  return results
    .filter((r) => r.album && (r.album.cover_xl || r.album.cover_big || r.album.cover_medium))
    .map((r) => {
      const album = r.album;
      return {
        source: 'Deezer',
        title: r.title || '',
        artist: (r.artist && r.artist.name) || '',
        score: scoreCandidate(
          { title: r.title, artist: r.artist && r.artist.name }, track, cleaned, wantVersions
        ),
        fullUrl: album.cover_xl || album.cover_big || album.cover_medium,
        thumbUrl: album.cover_medium || album.cover_big || album.cover_xl,
      };
    });
}

/** Cover Art Archive candidates, via a MusicBrainz recording search. */
async function musicbrainzCandidates(track, cleaned, wantVersions) {
  const parts = [`recording:"${cleaned}"`];
  if (track.artist) parts.push(`artist:"${track.artist}"`);
  const url = `${MB_SEARCH}?query=${encodeURIComponent(parts.join(' AND '))}&fmt=json&limit=5`;

  const res = await fetch(url, {
    headers: { 'User-Agent': MB_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const recs = Array.isArray(json.recordings) ? json.recordings : [];

  const out = [];
  for (const rec of recs) {
    const credit = Array.isArray(rec['artist-credit'])
      ? rec['artist-credit'].map((a) => `${a.name || ''}${a.joinphrase || ''}`).join('').trim()
      : '';
    const score = scoreCandidate(
      { title: rec.title, artist: credit }, track, cleaned, wantVersions
    );
    // One release per recording: several pressings of the same record usually
    // share their cover, so listing them all just crowds out the other sources.
    const release = (Array.isArray(rec.releases) ? rec.releases : []).find((r) => r.id);
    if (!release) continue;
    out.push({
      source: 'Cover Art Archive',
      title: rec.title || '',
      artist: credit,
      score,
      fullUrl: `${CAA_FRONT}/${release.id}/front-500`,
      thumbUrl: `${CAA_FRONT}/${release.id}/front-250`,
    });
  }
  return out;
}

/**
 * Drop candidates that point at the same image, keeping the best-scoring one.
 *
 * The sources overlap heavily — a popular song is on iTunes and Deezer with the
 * same cover — and a grid showing the same album four times is a grid that
 * hides the alternative the user actually needed.
 *
 * Pure, so it is unit-tested; see test/artwork.test.js.
 *
 * @param {ArtCandidate[]} list
 * @returns {ArtCandidate[]}
 */
function dedupeCandidates(list) {
  const seen = new Map();
  for (const c of list) {
    // Keyed on the artwork identity, not the URL: iTunes serves the same image
    // under a dozen size-suffixed paths, so raw URLs would never collide.
    const key = `${(c.source || '').toLowerCase()}|${(c.title || '').trim().toLowerCase()}|${(c.artist || '').trim().toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || c.score > prev.score) seen.set(key, c);
  }
  return [...seen.values()];
}

/**
 * Gather cover-art options for a track, ranked best first.
 *
 * Sources are queried in parallel: they are independent, and doing them in
 * series made the panel take as long as the slowest one plus the other two.
 *
 * @param {{title: string, artist: string}} track
 * @returns {Promise<ArtCandidate[]>} may be empty; never throws
 */
async function fetchArtworkCandidates(track) {
  const cleaned = cleanTitle(track.title);
  const term = [cleaned, track.artist].filter(Boolean).join(' ').trim();
  if (!term) return [];
  const wantVersions = versionTags(track.title || '');

  const settled = await Promise.allSettled([
    itunesCandidates(track, cleaned, term, wantVersions),
    deezerCandidates(track, cleaned, term, wantVersions),
    musicbrainzCandidates(track, cleaned, wantVersions),
  ]);

  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  const ranked = dedupeCandidates(all)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  // Thumbnails last, and only for the ones that survived the cut.
  const withThumbs = await Promise.all(ranked.map(async (c) => ({
    ...c,
    thumb: await downloadImage(c.thumbUrl),
  })));

  // A candidate whose thumbnail would not load is a candidate the user cannot
  // judge, and clicking a blank tile to find out is not a choice.
  return withThumbs.filter((c) => c.thumb);
}

module.exports = {
  fetchArtwork,
  fetchArtworkCandidates,
  downloadImage,
  dedupeCandidates,
  scoreCandidate,
  MIN_MATCH_SCORE,
};
