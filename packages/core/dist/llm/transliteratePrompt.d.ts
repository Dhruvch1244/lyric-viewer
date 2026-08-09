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
/** Transliterate a full cue list into Devanagari, preserving timing. */
export declare function toDevanagari(cues: LyricCue[], convert: Convert): Promise<LyricCue[]>;
