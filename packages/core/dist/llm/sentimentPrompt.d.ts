/**
 * Song-sentiment analysis → visual parameters. Ported from src/main/sentiment.js,
 * but takes a `Convert` implementation as a parameter instead of importing a
 * hardcoded provider layer — see ./types.ts for why.
 */
import type { Convert } from './types';
import type { LyricCue } from '../lyrics';
import type { Sentiment } from '../palette';
/** Analyze the sentiment of a cue list using the given LLM `convert` function. */
export declare function analyzeSentiment(cues: LyricCue[], convert: Convert): Promise<Sentiment>;
