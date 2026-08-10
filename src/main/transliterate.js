'use strict';

const { convert, isLLMAvailable } = require('./llm');

/**
 * Devanagari transliteration for romanized Hindi lyrics.
 *
 * Most Indian hip-hop entries on LRCLIB are stored romanized — a verified
 * Seedhe Maut sample came back as "Itna roliye ab gaane sunke rona bhi ni aata".
 * When no Devanagari-native entry exists, we convert script here.
 *
 * This is TRANSLITERATION (script conversion), never translation: the words and
 * their order are preserved exactly; only the writing system changes.
 *
 * Runs on whichever LLM provider is configured (Gemini or Claude — see llm.js).
 */

/** Lines per request. Keeps each response comfortably inside output limits. */
const BATCH_SIZE = 60;

const SYSTEM_PROMPT = `You transliterate romanized Hindi/Urdu song lyrics into Devanagari script.

Rules:
- TRANSLITERATE, do not translate. Preserve every word and its order exactly.
- Convert Latin-script Hindi/Urdu words to their Devanagari spelling.
- Leave English words, brand names, and Latin-script proper nouns in Latin script.
- Preserve punctuation, casing of retained Latin text, and any bracketed markers.
- If a line is empty or purely instrumental notation, return it unchanged.
- Return exactly as many output lines as input lines, in the same order.`;

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Transliterated lines, same count and order as the input.',
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

/**
 * Whether transliteration can run (any LLM provider configured).
 * @returns {boolean}
 */
function isTransliterationAvailable() {
  return isLLMAvailable();
}

/**
 * Convert one batch of lyric lines to Devanagari.
 * @param {string[]} lines
 * @returns {Promise<string[]>}
 */
async function convertBatch(lines) {
  const parsed = await convert({
    system: SYSTEM_PROMPT,
    user:
      'Transliterate these lyric lines to Devanagari. Return one output line per input line.\n\n' +
      JSON.stringify({ lines }, null, 2),
    schema: SCHEMA,
  });

  const out = parsed.lines;
  if (!Array.isArray(out) || out.length !== lines.length) {
    throw new Error(
      `Line count mismatch: sent ${lines.length}, received ${Array.isArray(out) ? out.length : 0}.`
    );
  }
  return out.map((line) => String(line));
}

/**
 * Transliterate a full cue list into Devanagari, preserving timing.
 *
 * This list replaces the Latin one on screen when the user switches script, so
 * it carries the whole timing shape across — including `endMs`, the point where
 * a line stops being sung. Dropping it would silently disable gap handling
 * (word highlighting, the song-title hero) in Devanagari mode only.
 *
 * @param {Array<{timeMs: number, text: string, endMs?: number}>} cues
 * @returns {Promise<Array<{timeMs: number, text: string, endMs?: number}>>}
 */
async function toDevanagari(cues) {
  const texts = cues.map((cue) => cue.text);
  const converted = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    converted.push(...(await convertBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return cues.map((cue, i) => ({ ...cue, text: converted[i] ?? cue.text }));
}

module.exports = { toDevanagari, isTransliterationAvailable };
