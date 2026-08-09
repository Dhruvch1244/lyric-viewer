/**
 * Per-track colour palette derivation: an instant deterministic hash palette
 * (available before any analysis completes), upgraded to a sentiment-driven
 * one once mood analysis finishes. Ported as-is from src/main/main.js.
 */
export interface TrackIdentity {
    artist: string;
    title: string;
}
export interface Sentiment {
    hue: number;
    saturation: number;
    energy: number;
    mood: string;
}
export interface Palette {
    /** [baseTint, glowA, glowB, accent] */
    palette: [string, string, string, string];
    hue: number;
    energy: number;
    mood: string | null;
}
/** HSL → #rrggbb. `s` and `l` are percentages (0-100), `h` is degrees. */
export declare function hslHex(h: number, s: number, l: number): string;
/**
 * Deterministic, vibrant palette per track so each song visibly recolours the
 * whole background, before any sentiment analysis is available.
 */
export declare function paletteForTrack(track: TrackIdentity): Palette;
/** Build a palette + motion profile from an analyzed sentiment. */
export declare function paletteFromSentiment(s: Sentiment): Palette;
/** Stable cache/settings key for a track. */
export declare function trackKey(track: TrackIdentity): string;
/**
 * Rotate a hex colour's hue by `deg`, preserving saturation/lightness. Used
 * to drift the backdrop's live colours over time. Ported from
 * src/renderer/renderer.js's `shiftHex`.
 */
export declare function shiftHex(hex: string, deg: number): string;
/** #rrggbb + alpha (0-1) → rgba() string. Ported from renderer.js's `hexA`. */
export declare function hexA(hex: string, alpha: number): string;
