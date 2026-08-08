'use strict';

const { convert, isLLMAvailable } = require('./llm');

/**
 * English translation of Hindi / Punjabi (and other non-English) lyric lines.
 *
 * This is TRANSLATION (meaning), distinct from transliteration (script). It is
 * shown as a secondary line beneath the running lyric so you can follow along.
 *
 * Runs on whichever LLM provider is configured (Gemini or Claude — see llm.js).
 */

/** Lines per request. */
const BATCH_SIZE = 50;

const SYSTEM_PROMPT = `You translate song lyrics into natural, fluent English.

Rules:
- Translate meaning, not word-for-word. Prefer how a native English speaker would say it.
- Input lines may be Hindi, Punjabi, or other languages, written in either their
  native script (Devanagari, Gurmukhi) or romanized in the Latin alphabet.
- Keep slang and tone; render it as idiomatic English slang where appropriate.
- Leave lines that are already English essentially unchanged.
- Leave purely instrumental markers or empty lines unchanged.
- Return exactly as many output lines as input lines, in the same order.
- Also report the dominant source language of the lyrics as a lowercase English
  word (e.g. "hindi", "punjabi", "english").`;

const SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', description: 'Dominant source language, lowercase.' },
    lines: {
      type: 'array',
      items: { type: 'string' },
      description: 'English translations, same count and order as input.',
    },
  },
  required: ['language', 'lines'],
  additionalProperties: false,
};

/**
 * Whether English translation can run (any LLM provider configured).
 * @returns {boolean}
 */
function isTranslationAvailable() {
  return isLLMAvailable();
}

/**
 * Translate one batch of lines to English.
 * @param {string[]} lines
 * @returns {Promise<{language: string, lines: string[]}>}
 */
async function translateBatch(lines) {
  const parsed = await convert({
    system: SYSTEM_PROMPT,
    user:
      'Translate these lyric lines to English. Return one output line per input line.\n\n' +
      JSON.stringify({ lines }, null, 2),
    schema: SCHEMA,
  });

  const out = parsed.lines;
  if (!Array.isArray(out) || out.length !== lines.length) {
    throw new Error(
      `Line count mismatch: sent ${lines.length}, received ${Array.isArray(out) ? out.length : 0}.`
    );
  }
  return {
    language: String(parsed.language || '').toLowerCase(),
    lines: out.map((line) => String(line)),
  };
}

/**
 * Translate a full cue list to English, preserving timing.
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Promise<{language: string, cues: Array<{timeMs: number, text: string}>}>}
 */
async function toEnglish(cues) {
  const texts = cues.map((cue) => cue.text);
  const translated = [];
  let language = 'unknown';

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const result = await translateBatch(texts.slice(i, i + BATCH_SIZE));
    if (i === 0) language = result.language;
    translated.push(...result.lines);
  }

  return {
    language,
    cues: cues.map((cue, i) => ({ timeMs: cue.timeMs, text: translated[i] ?? '' })),
  };
}

module.exports = { toEnglish, isTranslationAvailable };
