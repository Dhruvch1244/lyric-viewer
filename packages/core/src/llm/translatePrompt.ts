/**
 * English translation of Hindi / Punjabi (and other non-English) lyric lines.
 * Ported from src/main/translate.js — see ./types.ts for why this takes a
 * `Convert` implementation as a parameter instead of a hardcoded provider.
 *
 * This is TRANSLATION (meaning), distinct from transliteration (script).
 */

import type { Convert } from './types';
import type { LyricCue } from '../lyrics';

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

async function translateBatch(
  lines: string[],
  convert: Convert
): Promise<{ language: string; lines: string[] }> {
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

/** Translate a full cue list to English, preserving timing. */
export async function toEnglish(
  cues: LyricCue[],
  convert: Convert
): Promise<{ language: string; cues: LyricCue[] }> {
  const texts = cues.map((cue) => cue.text);
  const translated: string[] = [];
  let language = 'unknown';

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const result = await translateBatch(texts.slice(i, i + BATCH_SIZE), convert);
    if (i === 0) language = result.language;
    translated.push(...result.lines);
  }

  return {
    language,
    cues: cues.map((cue, i) => ({ timeMs: cue.timeMs, text: translated[i] ?? '' })),
  };
}
