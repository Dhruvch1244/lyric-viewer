'use strict';

const { convert, isLLMAvailable } = require('./llm');

/**
 * Per-line artist attribution — which collaborator sings which line.
 *
 * WHY. 0.20.0 gave every artist a distinct silhouette, which fixed *identity*:
 * you can now tell the dancers apart. It did not fix *meaning*. The dancer on
 * the mic is still chosen by `line index % member count`, so on a three-artist
 * collaboration the figure singing is right one time in three by accident, and
 * the app confidently shows the wrong person for the rest of the song. A
 * feature that is wrong two thirds of the time is worse than one that makes no
 * claim at all.
 *
 * WHY AN LLM. No lyric source carries this. LRCLIB, NetEase and every other
 * free source return lines and timings; verse ownership is not in the data at
 * any price. But it is exactly the kind of thing a model knows about a released
 * song, and where it does not know, the structure of the lyrics usually gives
 * it away — a verse boundary, a name-check, a switch in voice.
 *
 * WHAT IT MUST NOT DO. This never touches the words or the timings. It returns
 * an array of indices into the artist list, one per line, and nothing else. The
 * failure mode is falling back to what 0.20.0 did.
 *
 * ONE PASS PER TRACK, CACHED. The answer is a property of the song, not of the
 * play, so it is computed once and stored beside the cues. Nothing here runs
 * for a solo artist: with one name in the list there is no question to ask.
 */

/**
 * Lines per request. Larger than correction's 40 because the model needs to see
 * whole verses to spot where one ends — and each line costs only a number back,
 * not a rewritten line.
 */
const BATCH_SIZE = 80;

/** Never ask about a lineup bigger than this; past it the answer is noise. */
const MAX_ARTISTS = 6;

const SYSTEM_PROMPT = `You identify which artist performs each line of a song.

You are given a song title, an ordered list of the artists credited on it, and
the song's lyrics as numbered lines. For every line, say which artist sings it.

Rules:
- Answer with an artist INDEX from the list you were given, zero-based.
- Return EXACTLY as many answers as there are lines, in the same order.
- Songs are usually sung in blocks, not alternating line by line. A verse
  belongs to one artist; a hook is often shared. Prefer contiguous runs.
- Use what you know about the recording first. Where you do not know it, use the
  structure: verse boundaries, a change of voice, an artist named in the line.
- If a line is sung together or you genuinely cannot tell, use -1. That is a
  real answer and is better than a guess; the app has a sensible default for it.
- Never invent an artist who is not in the list, and never return an index
  outside it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    singers: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'One zero-based artist index per lyric line, in order. -1 means shared or unknown.',
    },
  },
  required: ['singers'],
  additionalProperties: false,
};

/** Whether attribution can run at all (any LLM provider configured). */
function isAttributionAvailable() {
  return isLLMAvailable();
}

/**
 * Split a credit string into the individual artists.
 *
 * Deliberately the same shapes SMTC and the lyric sources actually produce —
 * `A, B & C`, `A feat. B`, `A x B`, `A vs C` — and deliberately NOT a general
 * name parser. Anything it does not recognise stays one artist, which is the
 * safe direction: a lineup that is too short asks a smaller question, where a
 * lineup that split a single name in half asks a nonsensical one.
 *
 * @param {string} credit
 * @returns {string[]}
 */
function splitArtists(credit) {
  if (typeof credit !== 'string' || !credit.trim()) return [];
  return credit
    /* The word boundary goes BEFORE the optional dot, not after it. `\bfeat\.?\b`
       cannot match the dot in "feat. 21 Savage" — there is no word character
       after it for the boundary to sit against — so it matched "feat" alone and
       left ". 21 Savage" as an artist name. */
    .split(/\s*(?:,|&|\b(?:feat|ft|featuring|with|vs|x)\b\.?|\/)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    /* Case-insensitive dedupe: "Drake" and "drake" are one person, and a
       repeated name would give the model two indices for one dancer. */
    .filter((name, i, all) => all.findIndex((o) => o.toLowerCase() === name.toLowerCase()) === i)
    .slice(0, MAX_ARTISTS);
}

/**
 * Validate and normalise a model's answer for one batch.
 *
 * Pure, and separate from the network call because this is where a bad response
 * would do its damage. Every index is clamped into the artist list, anything
 * unparseable becomes -1 (shared/unknown, which the renderer already handles),
 * and a wrong-length answer is rejected outright rather than silently aligning
 * the wrong lines to the wrong people.
 *
 * @param {number} lineCount
 * @param {number[]} singers
 * @param {number} artistCount
 * @returns {number[]}
 * @throws {Error} when the count does not match
 */
function normaliseSingers(lineCount, singers, artistCount) {
  if (!Array.isArray(singers) || singers.length !== lineCount) {
    throw new Error(
      `Answer count mismatch: sent ${lineCount}, received ${Array.isArray(singers) ? singers.length : 0}.`
    );
  }
  return singers.map((raw) => {
    /* Checked before Number(), because `Number(null)` is 0 and `Number(false)`
       is 0 — a missing answer would silently become "the first artist sings
       this line", which is precisely the confident-but-wrong outcome this
       whole module exists to remove. A numeric string is still accepted: that
       is a loose provider, not a missing answer. */
    if (raw === null || raw === undefined || typeof raw === 'boolean') return -1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n >= artistCount) return -1;
    return n;
  });
}

/**
 * Smooth an attribution into blocks.
 *
 * Songs are performed in verses, not in alternation, so a lone line credited to
 * a different artist between two long runs of one is far more likely to be a
 * model slip than a real one-line handoff — and on screen it is a dancer
 * flickering onto the mic for a second and back, which reads as a bug whether
 * or not it is one. Runs shorter than `minRun` are absorbed into the run before
 * them.
 *
 * Applied after validation, on purpose: it is a presentation decision, and
 * keeping it separate means the raw answer stays testable.
 *
 * @param {number[]} singers
 * @param {number} [minRun=2]
 * @returns {number[]}
 */
function smoothRuns(singers, minRun = 2) {
  if (!Array.isArray(singers) || singers.length === 0) return [];
  const out = singers.slice();
  let start = 0;
  while (start < out.length) {
    let end = start;
    while (end + 1 < out.length && out[end + 1] === out[start]) end += 1;
    const length = end - start + 1;
    // The first run has nothing before it to be absorbed into, so it stands.
    if (length < minRun && start > 0) {
      for (let i = start; i <= end; i += 1) out[i] = out[start - 1];
    }
    start = end + 1;
  }
  return out;
}

/**
 * Work out who sings each line.
 *
 * Resolves to `null` on anything less than a usable answer — no provider, a
 * solo artist, a network failure, a malformed response. Null means "carry on
 * doing what 0.20.0 did", which is a working app, so no caller needs to handle
 * an error.
 *
 * @param {Array<{text: string}>} cues
 * @param {{title?: string, artist?: string}} track
 * @param {string[]} [artists] override the parsed lineup
 * @returns {Promise<{artists: string[], singers: number[]}|null>}
 */
async function attributeLines(cues, track, artists) {
  if (!Array.isArray(cues) || cues.length === 0) return null;
  if (!isAttributionAvailable()) return null;

  const lineup = Array.isArray(artists) && artists.length
    ? artists.slice(0, MAX_ARTISTS)
    : splitArtists((track && track.artist) || '');

  // One name is not a question. Two dancers is where the 0.20.0 behaviour
  // starts being visibly wrong, so that is where this starts earning its cost.
  if (lineup.length < 2) return null;

  const batches = Math.ceil(cues.length / BATCH_SIZE);
  const singers = [];

  for (let b = 0; b < batches; b += 1) {
    const slice = cues.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    try {
      const parsed = await convert({
        system: SYSTEM_PROMPT,
        user:
          `Song: ${(track && track.title) || 'unknown'}\n`
          + `Artists (use these indices):\n`
          + lineup.map((name, i) => `  ${i}: ${name}`).join('\n')
          + '\n\nLines:\n'
          + slice.map((c, i) => `${i}: ${(c.text || '').trim()}`).join('\n')
          + `\n\nReturn exactly ${slice.length} indices.`,
        schema: SCHEMA,
      });
      singers.push(...normaliseSingers(slice.length, parsed.singers, lineup.length));
    } catch (err) {
      /* Per batch, like correction: one bad response should not throw away the
         verses that were attributed correctly. -1 is the honest filler — it
         means "shared or unknown", which is exactly the situation. */
      console.warn(`[attribute] batch ${b + 1}/${batches} skipped:`, err.message);
      singers.push(...new Array(slice.length).fill(-1));
    }
  }

  // Every line unknown is not an attribution; it is the default wearing a hat.
  if (singers.every((s) => s < 0)) return null;

  return { artists: lineup, singers: smoothRuns(singers) };
}

module.exports = {
  attributeLines,
  splitArtists,
  normaliseSingers,
  smoothRuns,
  isAttributionAvailable,
  BATCH_SIZE,
  MAX_ARTISTS,
};
