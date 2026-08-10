'use strict';

const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'lyric-overlay/0.1.0 (personal project)';

/**
 * Noise patterns found in media titles, especially browser/YouTube sessions.
 * Verified against a live SMTC sample:
 *   "'नalla' Freestyle (Visualizer) | Seedhe Maut x DJ SA"
 */
const TITLE_NOISE = [
  /\((?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?|lyric video|mv|hd|4k)\)/gi,
  /\[(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?|lyric video|mv|hd|4k)\]/gi,
  /\((?:prod\.?|prod by)[^)]*\)/gi,
  /\b(?:official\s+)?(?:music\s+)?video\b/gi,
  /\bfull\s+(?:song|video|album)\b/gi,
  /\bremaster(?:ed)?(?:\s+\d{4})?\b/gi,
  // More browser/YouTube shapes seen in the wild.
  /\b(?:official\s+)?(?:audio|lyrical|lyric)\b/gi,
  /\bout\s+now\b/gi,
  /\s*[-–—]\s*youtube\s*$/gi,
];

/**
 * Words that mark a *different recording* of the same song. A studio LRC file
 * lines up with the studio cut and nothing else, so matching "Song (Live)" to
 * the studio entry yields lyrics that drift immediately. Duration alone does
 * not catch this — plenty of remixes run within a few seconds of the original.
 */
const VERSION_TOKENS = [
  'live', 'remix', 'acoustic', 'unplugged', 'instrumental', 'slowed', 'reverb',
  'sped', 'speedup', 'remastered', 'cover', 'karaoke', 'demo', 'extended',
  'mashup', 'reprise', 'bonus', 'edit', 'rework', 'flip', 'bootleg',
];

/**
 * Version markers present in a title, taken from the RAW string — cleanTitle
 * strips several of these, so this must run before it.
 *
 * @param {string} raw
 * @returns {Set<string>}
 */
function versionTags(raw) {
  const found = new Set();
  if (!raw) return found;
  const words = new Set(normalize(raw).split(' ').filter(Boolean));
  for (const token of VERSION_TOKENS) if (words.has(token)) found.add(token);
  return found;
}

/**
 * Strip platform noise from an artist credit.
 *
 * YouTube Music auto-generated channels report the artist as "Seedhe Maut -
 * Topic", and VEVO uploads append "VEVO". Both poison artist matching against
 * LRCLIB and the artwork APIs, and the "- Topic" suffix also leaks into the
 * on-screen artist label and the dancer registry lookup.
 *
 * @param {string} raw Raw artist string from SMTC.
 * @returns {string} Cleaned artist, or the original if cleaning emptied it.
 */
function cleanArtist(raw) {
  if (!raw) return '';
  const out = raw
    .replace(/\s*[-–—]\s*topic\s*$/i, '')
    // VEVO channel names are concatenated ("TheWeekndVEVO"), so there is no
    // word boundary to anchor on — strip it as a suffix instead.
    .replace(/vevo\s*$/i, '')
    .replace(/\s*[-–—]\s*official(?:\s+(?:channel|artist))?\s*$/i, '')
    .replace(/\s*\((?:official)?\s*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out || raw.trim();
}

/**
 * Strip platform noise from a raw media title.
 *
 * Handles the common browser/YouTube shapes: parenthetical tags, a trailing
 * "| Artist x Producer" credit block, and "feat./ft." suffixes.
 *
 * @param {string} raw Raw title from SMTC.
 * @returns {string} Cleaned title, or the original if cleaning emptied it.
 */
function cleanTitle(raw) {
  if (!raw) return '';
  let out = raw;

  // Everything after a pipe on a YouTube-style title is credits, not the song.
  const pipeIndex = out.indexOf('|');
  if (pipeIndex > 0) out = out.slice(0, pipeIndex);

  for (const pattern of TITLE_NOISE) out = out.replace(pattern, ' ');

  out = out
    .replace(/\((?:feat\.?|ft\.?|with)[^)]*\)/gi, ' ')
    .replace(/\b(?:feat\.?|ft\.?)\s+.*$/gi, ' ')
    .replace(/["'`‘’“”]/g, ' ')
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out || raw.trim();
}

/**
 * Normalize a string for comparison: lowercase, strip Latin diacritics and
 * punctuation, collapse whitespace. Non-Latin scripts (e.g. Devanagari) are
 * preserved rather than stripped, since they carry real title content.
 *
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token-overlap similarity in [0, 1].
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function tokenSimilarity(a, b) {
  const setA = new Set(normalize(a).split(' ').filter(Boolean));
  const setB = new Set(normalize(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / Math.max(setA.size, setB.size);
}

/**
 * Score one LRCLIB candidate against the track we're looking for.
 *
 * LRCLIB entries are themselves messy — verified examples include
 * "11K - Seedhe Maut" and "Hausla - Seedhe Maut", where the artist is baked
 * into trackName. So both sides get compared as a combined haystack too.
 *
 * @param {object} candidate LRCLIB search result.
 * @param {{title: string, artist: string, durationMs: number}} target
 * @returns {number} Score; higher is better. Negative means reject.
 */
function scoreCandidate(candidate, target) {
  if (!candidate.syncedLyrics) return -1; // Line-level sync is the whole point.

  const cleanedTarget = cleanTitle(target.title);

  const titleScore = Math.max(
    tokenSimilarity(cleanedTarget, candidate.trackName || ''),
    // Fallback: compare against the candidate's combined track+artist string,
    // which catches entries with the artist embedded in the title.
    tokenSimilarity(cleanedTarget, `${candidate.trackName} ${candidate.artistName}`)
  );

  const cleanedArtist = cleanArtist(target.artist);
  const artistScore = cleanedArtist
    ? tokenSimilarity(cleanedArtist, candidate.artistName || '')
    : 0;

  let score = titleScore * 2 + artistScore;

  // Duration proximity is the strongest disambiguator between remixes,
  // live cuts and the studio version. LRCLIB reports seconds.
  if (target.durationMs > 0 && candidate.duration > 0) {
    const deltaSec = Math.abs(candidate.duration - target.durationMs / 1000);
    if (deltaSec <= 2) score += 1.5;
    else if (deltaSec <= 5) score += 0.75;
    else if (deltaSec > 20) score -= 1.0;
  }

  /*
    Version guard. Duration catches gross mismatches, but a remix or a slowed
    edit often lands within a few seconds of the original, scores well on
    title/artist, and then plays with lyrics that drift from the first line.
    Penalise each version marker present on one side and missing on the other.
  */
  const wantVersions = versionTags(target.title);
  const haveVersions = versionTags(`${candidate.trackName || ''} ${candidate.albumName || ''}`);
  let versionMismatch = 0;
  for (const tag of wantVersions) if (!haveVersions.has(tag)) versionMismatch += 1;
  for (const tag of haveVersions) if (!wantVersions.has(tag)) versionMismatch += 1;
  score -= versionMismatch * 1.25;

  return score;
}

/**
 * Parse an LRC document into ordered, timestamped cues.
 *
 * @param {string} lrc Raw LRC text.
 * @returns {Array<{timeMs: number, text: string}>} Sorted cues.
 */
function parseLrc(lrc) {
  const cues = [];
  const lineTag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const rawLine of lrc.split(/\r?\n/)) {
    lineTag.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = lineTag.exec(rawLine)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fracRaw = match[3] ?? '0';
      // Normalize 1-3 digit fractions to milliseconds.
      const fraction = Number(fracRaw.padEnd(3, '0').slice(0, 3));
      stamps.push(minutes * 60_000 + seconds * 1000 + fraction);
    }
    if (stamps.length === 0) continue;

    const text = rawLine.replace(lineTag, '').trim();
    for (const timeMs of stamps) cues.push({ timeMs, text });
  }

  cues.sort((a, b) => a.timeMs - b.timeMs);
  return cues;
}

/**
 * Fraction of script letters that belong to the Devanagari script.
 *
 * Both numerator and denominator count only letters (`\p{L}`), so Devanagari
 * combining vowel marks (matras, category Mn) don't skew the result — otherwise
 * a fully-Devanagari string can exceed a ratio of 1.
 *
 * @param {string} text
 * @returns {number} 0..1
 */
function devanagariRatio(text) {
  if (!text) return 0;
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return 0;
  const deva = letters.filter((ch) => /\p{Script=Devanagari}/u.test(ch));
  return deva.length / letters.length;
}

/**
 * Whether a parsed cue list is predominantly Devanagari script.
 * @param {Array<{text: string}>} cues
 * @returns {boolean}
 */
function isDevanagariCues(cues) {
  const sample = cues
    .slice(0, 12)
    .map((c) => c.text)
    .join(' ');
  return devanagariRatio(sample) >= 0.4;
}

/**
 * Fraction of script letters that belong to the Gurmukhi (Punjabi) script.
 * @param {string} text
 * @returns {number} 0..1
 */
function gurmukhiRatio(text) {
  if (!text) return 0;
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return 0;
  const guru = letters.filter((ch) => /\p{Script=Gurmukhi}/u.test(ch));
  return guru.length / letters.length;
}

/**
 * Common romanized Hindi/Punjabi function words. Their presence in Latin-script
 * lyrics is a strong signal the language is Indic rather than English, which
 * lets us auto-offer English translation without an API round-trip just to
 * detect language.
 */
const INDIC_ROMAN_TOKENS = new Set([
  'hai', 'nahi', 'nai', 'ni', 'mera', 'meri', 'tera', 'teri', 'tu', 'tum', 'main',
  'mai', 'kya', 'kyu', 'kyun', 'ke', 'ki', 'ka', 'ko', 'se', 'me', 'mein', 'pe',
  'par', 'aur', 'ab', 'jo', 'wo', 'woh', 'yeh', 'ye', 'hoke', 'hona', 'karke',
  'gaya', 'raha', 'rahe', 'kar', 'karo', 'chal', 'dil', 'pyaar', 'yaar', 'bhai',
  'apna', 'apne', 'saara', 'sab', 'kuch', 'bina', 'zindagi', 'sunke', 'rona',
  'gaane', 'itna', 'aata', 'jaata', 'wala', 'wale', 'haan', 'bol', 'bole',
]);

/**
 * Heuristic: do these cues look like Hindi/Punjabi (native script or romanized)?
 *
 * Used to decide whether to auto-offer an English translation line.
 *
 * @param {Array<{text: string}>} cues
 * @returns {{indic: boolean, script: 'devanagari'|'gurmukhi'|'latin'}}
 */
function detectIndic(cues) {
  const sample = cues.slice(0, 20).map((c) => c.text).join(' ');

  if (devanagariRatio(sample) >= 0.4) return { indic: true, script: 'devanagari' };
  if (gurmukhiRatio(sample) >= 0.4) return { indic: true, script: 'gurmukhi' };

  const words = normalize(sample).split(' ').filter(Boolean);
  if (words.length === 0) return { indic: false, script: 'latin' };

  let hits = 0;
  for (const word of words) if (INDIC_ROMAN_TOKENS.has(word)) hits += 1;

  // A few function-word hits per line's worth of text is a reliable signal.
  const ratio = hits / words.length;
  return { indic: ratio >= 0.06 || hits >= 4, script: 'latin' };
}

/**
 * Look up synced lyrics for a track.
 *
 * Uses LRCLIB's free-text `q=` endpoint. The structured `track_name`/
 * `artist_name` endpoint was verified to be too strict — it returned zero
 * results for tracks that free-text search matched successfully.
 *
 * Scans all candidates for a Devanagari-native synced entry as well as the
 * best overall match, so a native Hindi-script version is used when it exists
 * rather than falling back to machine transliteration.
 *
 * @param {{title: string, artist: string, durationMs: number}} track
 * @returns {Promise<{cues: Array, cuesDevanagari: Array|null, source: object}|null>}
 */
async function fetchSyncedLyrics(track) {
  const query = [cleanTitle(track.title), track.artist].filter(Boolean).join(' ');
  if (!query.trim()) return null;

  const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`;

  let results;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`LRCLIB responded ${response.status}`);
    }
    results = await response.json();
  } catch (err) {
    throw new Error(`Lyric lookup failed: ${err.message}`);
  }

  if (!Array.isArray(results) || results.length === 0) return null;

  let best = null;
  let bestScore = 0;
  let devaBest = null;
  let devaBestScore = 0;

  for (const candidate of results) {
    const score = scoreCandidate(candidate, track);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
    // Track the best Devanagari-script candidate separately. Use a lower
    // acceptance bar for it (0.5) — a native-script version that matches the
    // song reasonably well is worth surfacing even if its metadata is noisier.
    if (score > devaBestScore && candidate.syncedLyrics && devanagariRatio(candidate.syncedLyrics) >= 0.4) {
      devaBestScore = score;
      devaBest = candidate;
    }
  }

  // Require a meaningful match rather than returning the least-bad result.
  if (!best || bestScore < 1.0) return null;

  const cues = parseLrc(best.syncedLyrics);
  if (cues.length === 0) return null;

  // If the primary match is itself Devanagari, it doubles as the native track.
  let cuesDevanagari = null;
  if (isDevanagariCues(cues)) {
    cuesDevanagari = cues;
  } else if (devaBest && devaBestScore >= 0.5) {
    const parsed = parseLrc(devaBest.syncedLyrics);
    if (parsed.length > 0) cuesDevanagari = parsed;
  }

  return {
    cues,
    cuesDevanagari,
    source: {
      id: best.id,
      trackName: best.trackName,
      artistName: best.artistName,
      duration: best.duration,
      score: Number(bestScore.toFixed(2)),
    },
  };
}

module.exports = {
  cleanTitle,
  cleanArtist,
  versionTags,
  normalize,
  tokenSimilarity,
  scoreCandidate,
  parseLrc,
  devanagariRatio,
  gurmukhiRatio,
  isDevanagariCues,
  detectIndic,
  fetchSyncedLyrics,
};
