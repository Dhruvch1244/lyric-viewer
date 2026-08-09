/**
 * Devanagari transliteration for romanized Hindi lyrics. Ported from
 * src/main/transliterate.js — see ./types.ts for why this takes a `Convert`
 * implementation as a parameter instead of a hardcoded provider.
 *
 * This is TRANSLITERATION (script conversion), never translation: the words
 * and their order are preserved exactly; only the writing system changes.
 */

import type { Convert } from './types';
import type { LyricCue } from '../lyrics';

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

async function convertBatch(lines: string[], convert: Convert): Promise<string[]> {
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

/** Transliterate a full cue list into Devanagari, preserving timing. */
export async function toDevanagari(cues: LyricCue[], convert: Convert): Promise<LyricCue[]> {
  const texts = cues.map((cue) => cue.text);
  const converted: string[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    converted.push(...(await convertBatch(texts.slice(i, i + BATCH_SIZE), convert)));
  }
  return cues.map((cue, i) => ({ timeMs: cue.timeMs, text: converted[i] ?? cue.text }));
}
