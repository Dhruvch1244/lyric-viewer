'use strict';

const { convert, isLLMAvailable } = require('./llm');

/**
 * LLM correction of a Whisper transcript.
 *
 * Whisper is a *speech* model. On sung vocals over a dense mix it runs well
 * below its speech accuracy — worst on fast rap and heavy EDM, which is most of
 * this app's use. It mishears words, but it mishears them *phonetically*: the
 * output rhymes with the truth. A language model that is told the song's title
 * and artist can often reconstruct the real line from that, because it has the
 * one thing Whisper lacks — knowledge of what this song is.
 *
 * That ear/brain split is the architecture behind LyricWhiz and
 * python-lyrics-transcriber; it is a documented technique, not a trick. It is
 * also the biggest accuracy gain available here short of vocal isolation, and
 * the provider stack, key panel and cache it needs are all already built.
 *
 * WHAT IT MUST NOT DO. Timings are Whisper's and are load-bearing: the model
 * corrects words only, never the clock. And it never runs when the words came
 * from a real lyric source — if LRCLIB gave us the actual lyrics, "correcting"
 * them can only make them wrong.
 */

/**
 * Lines per request. Smaller than translation's 50: a correction prompt carries
 * more context per line and the whole point is that the model can see enough
 * of the song around a line to recognise it.
 */
const BATCH_SIZE = 40;

const SYSTEM_PROMPT = `You correct errors in an automatic transcription of song lyrics.

The input is what a speech-recognition model heard in a song. It is often wrong
in a specific way: the words are phonetically close to the truth but are not the
real words, because the model was trained on speech and this is singing over
music.

Rules:
- Fix mishearings. Use the song title and artist, the rhyme scheme, and the
  surrounding lines to work out what was actually sung.
- Return EXACTLY as many lines as you were given, in the same order. Never merge,
  split, add or drop a line. Each output line corresponds to the input line at
  the same index.
- If a line is already right, or you cannot tell what it should be, return it
  unchanged. A confident wrong guess is worse than leaving it alone.
- Do NOT translate, transliterate, or change the language of a line. Romanized
  Hindi/Punjabi stays romanized.
- Do NOT add punctuation, capitalisation or formatting the transcription did not
  have. You are fixing words, not tidying text.
- Never return an empty line for a line that had words.`;

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Corrected lyric lines, same count and order as the input.',
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

/** Whether correction can run at all (any LLM provider configured). */
function isCorrectionAvailable() {
  return isLLMAvailable();
}

/**
 * Merge a model's returned lines onto the original cues.
 *
 * Pure, and separated from the network call because this is where the damage
 * would be done. The rules it enforces:
 *
 *   - the line count must match exactly, or the whole batch is rejected. A
 *     model that merged two lines has shifted every timing after it, which is
 *     far worse than an uncorrected transcript;
 *   - timings are copied through untouched — only `text` may change;
 *   - a blank correction for a line that had words is ignored, since it would
 *     silently delete a lyric;
 *   - `words` (from word-level alignment) is dropped on any line whose text
 *     actually changed, because those timings were measured against the OLD
 *     words and would now point at the wrong ones.
 *
 * @param {Array<{timeMs: number, text: string}>} cues
 * @param {string[]} lines model output
 * @returns {{cues: Array<object>, changed: number}}
 * @throws {Error} when the count does not match
 */
function mergeCorrections(cues, lines) {
  if (!Array.isArray(lines) || lines.length !== cues.length) {
    throw new Error(
      `Line count mismatch: sent ${cues.length}, received ${Array.isArray(lines) ? lines.length : 0}.`
    );
  }

  let changed = 0;
  const out = cues.map((cue, i) => {
    const raw = typeof lines[i] === 'string' ? lines[i].trim() : '';
    const original = (cue.text || '').trim();

    // A blank for a line that had words would delete a lyric outright.
    if (!raw && original) return cue;
    if (raw === original) return cue;

    changed += 1;
    const next = { ...cue, text: raw };
    // Word timings were measured against the words that just changed.
    if (next.words) delete next.words;
    return next;
  });

  return { cues: out, changed };
}

/**
 * Run a correction pass over a transcript.
 *
 * Resolves to the ORIGINAL cues on any failure — a missing provider, a network
 * error, a malformed response, a count mismatch. A transcript that was good
 * enough to show before the pass is still good enough after it fails, and this
 * runs in the background where an exception would otherwise lose the whole
 * transcription.
 *
 * @param {Array<{timeMs: number, text: string}>} cues Whisper's output
 * @param {{title?: string, artist?: string}} track
 * @param {(stage: {batch: number, batches: number}) => void} [onProgress]
 * @returns {Promise<{cues: Array<object>, changed: number, corrected: boolean}>}
 */
async function correctTranscript(cues, track, onProgress) {
  if (!Array.isArray(cues) || cues.length === 0) {
    return { cues, changed: 0, corrected: false };
  }
  if (!isCorrectionAvailable()) {
    return { cues, changed: 0, corrected: false };
  }

  const batches = Math.ceil(cues.length / BATCH_SIZE);
  const result = [];
  let changed = 0;

  for (let b = 0; b < batches; b += 1) {
    const slice = cues.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (onProgress) onProgress({ batch: b + 1, batches });

    try {
      const parsed = await convert({
        system: SYSTEM_PROMPT,
        user:
          `Song: ${track && track.title ? track.title : 'unknown'}\n` +
          `Artist: ${track && track.artist ? track.artist : 'unknown'}\n\n` +
          'Correct this transcription. Return one output line per input line.\n\n' +
          JSON.stringify({ lines: slice.map((c) => c.text || '') }, null, 2),
        schema: SCHEMA,
      });

      const merged = mergeCorrections(slice, parsed.lines);
      result.push(...merged.cues);
      changed += merged.changed;
    } catch (err) {
      // Per BATCH, not per song: one bad response should not discard the
      // corrections that already succeeded for the rest of the track.
      console.warn(`[correct] batch ${b + 1}/${batches} skipped:`, err.message);
      result.push(...slice);
    }
  }

  return { cues: result, changed, corrected: changed > 0 };
}

module.exports = {
  correctTranscript,
  mergeCorrections,
  isCorrectionAvailable,
  BATCH_SIZE,
};
