/**
 * Word-level timing and cadence derived from line-level LRC cues.
 *
 * LRCLIB only provides line-level timestamps — true word-level (A2) timing
 * exists essentially only in paid "richsync" data. `buildWordTimings`
 * approximates it by distributing each line's duration across its words,
 * weighted by word length. Ported as-is from `buildWordTimings()` in
 * src/renderer/renderer.js, but as pure functions that take the cue list as
 * an argument instead of closing over renderer-local module state, so both
 * the Electron renderer and a mobile UI layer can call it the same way.
 */
import type { LyricCue } from './lyrics';
export interface WordTiming {
    word: string;
    startMs: number;
    endMs: number;
}
/** Distribute a line's duration across its words, weighted by word length. */
export declare function buildWordTimings(text: string, startMs: number, endMs: number): WordTiming[];
/** On-screen duration of a line (ms) = gap to the next cue. */
export declare function lineDurationMs(cues: LyricCue[], index: number): number;
/** Line energy from cadence: words per second. Fast, wordy bars score high. */
export declare function lineEnergy(cues: LyricCue[], index: number): number;
/** Binary search for the active cue at a given playback position. */
export declare function findCueIndex(cues: LyricCue[], positionMs: number): number;
