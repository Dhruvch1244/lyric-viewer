/**
 * Platform-agnostic lyric lookup: title cleaning, LRCLIB candidate scoring,
 * LRC parsing, and Indic-script detection. No Electron/Node-only APIs —
 * usable from the Electron main process and the React Native app alike.
 */
export interface TrackQuery {
    title: string;
    artist: string;
    durationMs: number;
}
export interface LyricCue {
    timeMs: number;
    text: string;
}
export interface LrclibCandidate {
    id?: number | string;
    trackName?: string;
    artistName?: string;
    duration?: number;
    syncedLyrics?: string;
}
export interface SyncedLyricsResult {
    cues: LyricCue[];
    cuesDevanagari: LyricCue[] | null;
    source: {
        id?: number | string;
        trackName?: string;
        artistName?: string;
        duration?: number;
        score: number;
    };
}
/**
 * Strip platform noise from a raw media title.
 *
 * Handles the common browser/YouTube shapes: parenthetical tags, a trailing
 * "| Artist x Producer" credit block, and "feat./ft." suffixes.
 */
export declare function cleanTitle(raw: string | null | undefined): string;
/**
 * Normalize a string for comparison: lowercase, strip Latin diacritics and
 * punctuation, collapse whitespace. Non-Latin scripts (e.g. Devanagari) are
 * preserved rather than stripped, since they carry real title content.
 */
export declare function normalize(value: string | null | undefined): string;
/** Token-overlap similarity in [0, 1]. */
export declare function tokenSimilarity(a: string, b: string): number;
/**
 * Score one LRCLIB candidate against the track we're looking for.
 *
 * LRCLIB entries are themselves messy — verified examples include
 * "11K - Seedhe Maut" and "Hausla - Seedhe Maut", where the artist is baked
 * into trackName. So both sides get compared as a combined haystack too.
 *
 * Returns a score; higher is better. Negative means reject.
 */
export declare function scoreCandidate(candidate: LrclibCandidate, target: TrackQuery): number;
/** Parse an LRC document into ordered, timestamped cues. */
export declare function parseLrc(lrc: string): LyricCue[];
/**
 * Fraction of script letters that belong to the Devanagari script.
 *
 * Both numerator and denominator count only letters (`\p{L}`), so Devanagari
 * combining vowel marks (matras, category Mn) don't skew the result —
 * otherwise a fully-Devanagari string can exceed a ratio of 1.
 */
export declare function devanagariRatio(text: string): number;
/** Whether a parsed cue list is predominantly Devanagari script. */
export declare function isDevanagariCues(cues: LyricCue[]): boolean;
/** Fraction of script letters that belong to the Gurmukhi (Punjabi) script. */
export declare function gurmukhiRatio(text: string): number;
export interface IndicDetection {
    indic: boolean;
    script: 'devanagari' | 'gurmukhi' | 'latin';
}
/**
 * Heuristic: do these cues look like Hindi/Punjabi (native script or romanized)?
 * Used to decide whether to auto-offer an English translation line.
 */
export declare function detectIndic(cues: LyricCue[]): IndicDetection;
/**
 * Look up synced lyrics for a track.
 *
 * Uses LRCLIB's free-text `q=` endpoint. The structured `track_name`/
 * `artist_name` endpoint was verified to be too strict — it returned zero
 * results for tracks that free-text search matched successfully.
 *
 * Scans all candidates for a Devanagari-native synced entry as well as the
 * best overall match, so a native Hindi-script version is used when it exists
 * rather than falling back to machine transliteration.
 *
 * Relies on the global `fetch` (available in Electron's Node runtime and in
 * React Native), so no platform-specific HTTP client is required here.
 */
export declare function fetchSyncedLyrics(track: TrackQuery): Promise<SyncedLyricsResult | null>;
