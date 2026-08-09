/**
 * Song-sentiment analysis → visual parameters. Ported from src/main/sentiment.js,
 * but takes a `Convert` implementation as a parameter instead of importing a
 * hardcoded provider layer — see ./types.ts for why.
 */

import type { Convert } from './types';
import type { LyricCue } from '../lyrics';
import type { Sentiment } from '../palette';

const SYSTEM_PROMPT = `You are the visual director for a music visualizer. Given a
sample of a song's lyrics, judge the overall emotional sentiment and map it to
visual parameters.

Return:
- mood: one or two words for the dominant feeling (e.g. "melancholic",
  "euphoric", "aggressive", "romantic", "chill", "dark", "triumphant").
- hue: 0-359, the dominant colour that fits the mood. Rough guide — warm reds/
  oranges for anger/passion, gold/yellow for triumph/joy, green for calm/hope,
  blue for sadness/cool, purple for dreamy/mysterious, magenta for romance.
- saturation: 45-100. Higher for intense or vivid moods, lower for subdued ones.
- energy: 0.0-1.0. 0 for slow/somber, 1 for high-energy/hype.

Base the judgement on the lyrics' meaning and tone, not individual words.`;

const SCHEMA = {
  type: 'object',
  properties: {
    mood: { type: 'string' },
    hue: { type: 'integer' },
    saturation: { type: 'integer' },
    energy: { type: 'number' },
  },
  required: ['mood', 'hue', 'saturation', 'energy'],
  additionalProperties: false,
};

/** Analyze the sentiment of a cue list using the given LLM `convert` function. */
export async function analyzeSentiment(cues: LyricCue[], convert: Convert): Promise<Sentiment> {
  // A ~40-line sample is plenty to judge mood and keeps the request small.
  const sample = cues
    .map((c) => c.text)
    .filter((t) => t && t.trim())
    .slice(0, 40)
    .join('\n');

  const parsed = await convert({
    system: SYSTEM_PROMPT,
    user: `Analyze the sentiment of these lyrics and return the visual parameters.\n\n${sample}`,
    schema: SCHEMA,
  });

  return {
    mood: String(parsed.mood || 'neutral'),
    hue: Math.max(0, Math.min(359, Math.round(Number(parsed.hue) || 0))),
    saturation: Math.max(40, Math.min(100, Math.round(Number(parsed.saturation) || 70))),
    energy: Math.max(0, Math.min(1, Number(parsed.energy) || 0.5)),
  };
}
