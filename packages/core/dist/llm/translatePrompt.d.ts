/**
 * English translation of Hindi / Punjabi (and other non-English) lyric lines.
 * Ported from src/main/translate.js — see ./types.ts for why this takes a
 * `Convert` implementation as a parameter instead of a hardcoded provider.
 *
 * This is TRANSLATION (meaning), distinct from transliteration (script).
 */
import type { Convert } from './types';
import type { LyricCue } from '../lyrics';
/** Translate a full cue list to English, preserving timing. */
export declare function toEnglish(cues: LyricCue[], convert: Convert): Promise<{
    language: string;
    cues: LyricCue[];
}>;
