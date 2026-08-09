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

const MAX_WORD_SPREAD_MS = 8000;

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

/** Distribute a line's duration across its words, weighted by word length. */
export function buildWordTimings(text: string, startMs: number, endMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const span = Math.max(0, Math.min(endMs - startMs, MAX_WORD_SPREAD_MS));
  const totalWeight = words.reduce((sum, w) => sum + w.length, 0) || words.length;

  let cursor = startMs;
  return words.map((word) => {
    const share = (word.length / totalWeight) * span;
    const timing: WordTiming = { word, startMs: cursor, endMs: cursor + share };
    cursor += share;
    return timing;
  });
}

/** On-screen duration of a line (ms) = gap to the next cue. */
export function lineDurationMs(cues: LyricCue[], index: number): number {
  const cue = cues[index];
  if (!cue) return 3000;
  const next = cues[index + 1];
  return Math.max(250, (next ? next.timeMs : cue.timeMs + 3000) - cue.timeMs);
}

/** Line energy from cadence: words per second. Fast, wordy bars score high. */
export function lineEnergy(cues: LyricCue[], index: number): number {
  const cue = cues[index];
  if (!cue) return 0;
  const words = cue.text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const wps = words / (lineDurationMs(cues, index) / 1000);
  return Math.max(0, Math.min(1, wps / 4.5));
}

/** Binary search for the active cue at a given playback position. */
export function findCueIndex(cues: LyricCue[], positionMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].timeMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
