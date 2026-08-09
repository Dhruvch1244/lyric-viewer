"use strict";
/**
 * Per-track colour palette derivation: an instant deterministic hash palette
 * (available before any analysis completes), upgraded to a sentiment-driven
 * one once mood analysis finishes. Ported as-is from src/main/main.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hslHex = hslHex;
exports.paletteForTrack = paletteForTrack;
exports.paletteFromSentiment = paletteFromSentiment;
exports.trackKey = trackKey;
exports.shiftHex = shiftHex;
exports.hexA = hexA;
/** HSL → #rrggbb. `s` and `l` are percentages (0-100), `h` is degrees. */
function hslHex(h, s, l) {
    const sf = s / 100;
    const lf = l / 100;
    const a = sf * Math.min(lf, 1 - lf);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const c = lf - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * Math.max(0, Math.min(1, c))).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
/**
 * Deterministic, vibrant palette per track so each song visibly recolours the
 * whole background, before any sentiment analysis is available.
 */
function paletteForTrack(track) {
    const seed = `${track.artist || ''}|${track.title || ''}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    const hue2 = (hue + 45 + (hash % 60)) % 360; // second, related hue
    const palette = [
        hslHex(hue, 55, 9), // baseTint — dark, colours the whole screen
        hslHex(hue, 80, 52), // glowA — vibrant
        hslHex(hue2, 78, 55), // glowB — vibrant, secondary hue
        hslHex(hue, 88, 62), // accent — bright, for word focus
    ];
    return { palette, hue, energy: 0.5, mood: null };
}
/** Build a palette + motion profile from an analyzed sentiment. */
function paletteFromSentiment(s) {
    const hue = s.hue;
    const hue2 = (hue + 40) % 360;
    const sat = s.saturation;
    const palette = [
        hslHex(hue, Math.round(sat * 0.7), 9),
        hslHex(hue, sat, 52),
        hslHex(hue2, sat, 55),
        hslHex(hue, Math.min(100, sat + 8), 62),
    ];
    return { palette, hue, energy: s.energy, mood: s.mood };
}
/** Stable cache/settings key for a track. */
function trackKey(track) {
    return `${(track.artist || '').trim()}|${(track.title || '').trim()}`.toLowerCase();
}
/**
 * Rotate a hex colour's hue by `deg`, preserving saturation/lightness. Used
 * to drift the backdrop's live colours over time. Ported from
 * src/renderer/renderer.js's `shiftHex`.
 */
function shiftHex(hex, deg) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h *= 60;
        if (h < 0)
            h += 360;
    }
    return hslHex((h + deg) % 360, s * 100, l * 100);
}
/** #rrggbb + alpha (0-1) → rgba() string. Ported from renderer.js's `hexA`. */
function hexA(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
}
