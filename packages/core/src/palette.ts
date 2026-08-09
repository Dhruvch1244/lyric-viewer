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
export function hslHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n: number) => {
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
export function paletteForTrack(track: TrackIdentity): Palette {
  const seed = `${track.artist || ''}|${track.title || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const hue2 = (hue + 45 + (hash % 60)) % 360; // second, related hue

  const palette: [string, string, string, string] = [
    hslHex(hue, 55, 9), // baseTint — dark, colours the whole screen
    hslHex(hue, 80, 52), // glowA — vibrant
    hslHex(hue2, 78, 55), // glowB — vibrant, secondary hue
    hslHex(hue, 88, 62), // accent — bright, for word focus
  ];
  return { palette, hue, energy: 0.5, mood: null };
}

/** Build a palette + motion profile from an analyzed sentiment. */
export function paletteFromSentiment(s: Sentiment): Palette {
  const hue = s.hue;
  const hue2 = (hue + 40) % 360;
  const sat = s.saturation;
  const palette: [string, string, string, string] = [
    hslHex(hue, Math.round(sat * 0.7), 9),
    hslHex(hue, sat, 52),
    hslHex(hue2, sat, 55),
    hslHex(hue, Math.min(100, sat + 8), 62),
  ];
  return { palette, hue, energy: s.energy, mood: s.mood };
}

/** Stable cache/settings key for a track. */
export function trackKey(track: TrackIdentity): string {
  return `${(track.artist || '').trim()}|${(track.title || '').trim()}`.toLowerCase();
}
