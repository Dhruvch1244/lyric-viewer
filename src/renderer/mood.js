'use strict';

/*
  Per-mood visual profiles.

  The sentiment pass already gives the app two things about a song: a numeric
  `energy` (0..1) and a free-text `mood` — "melancholic", "euphoric", "dark
  and driving". Until now only the palette used any of it. But a calm song and
  a furious one should not move the same way, and energy alone does not capture
  that: a slow, heavy dirge and a gentle lullaby can share an energy number and
  want completely different motion.

  So this turns (mood, energy) into a small profile that shapes HOW the visuals
  move — the motion floor, how much the field churns, how readily it flickers,
  and a warm/cool bias — on top of the palette the sentiment already sets.

  The mood is free text from a model, so it is classified by keyword into a few
  characters, with energy as the tie-breaker and the fallback when no keyword
  matches. Pure and exported on window.MoodProfile so it can be unit-tested
  without a renderer.
*/

(function () {
  /**
   * Keyword buckets. First match wins, so order matters: the more specific /
   * intense feelings are listed before the milder ones.
   */
  const KEYWORDS = [
    ['dark', /\b(dark|angry|aggress|furious|rage|menac|sinist|heavy|brood|violent|intense)\w*/i],
    ['energetic', /\b(energ|euphor|hype|upbeat|party|danc|joy|happy|excit|triumph|anthem|uplift|ecstat)\w*/i],
    ['calm', /\b(calm|mellow|melanchol|sad|somber|gentle|tender|dream|ambient|peace|serene|wistful|nostalg|lonely|soft)\w*/i],
    ['bright', /\b(bright|warm|hopeful|sweet|playful|light|sunny|romant)\w*/i],
  ];

  /**
   * The profiles. Each knob is a MULTIPLIER or additive bias the renderer folds
   * into the motion it already computes, centred so `neutral` changes nothing:
   *
   *   motion     — overall motion floor and speed (×)
   *   turbulence — how much the swirl field churns (×)
   *   flicker    — how readily the screen flickers/strobes (×)
   *   warmth     — hue nudge, degrees; + warmer (toward red), - cooler (toward blue)
   */
  const PROFILES = {
    calm: { key: 'calm', motion: 0.7, turbulence: 0.65, flicker: 0.5, warmth: -8 },
    energetic: { key: 'energetic', motion: 1.35, turbulence: 1.3, flicker: 1.25, warmth: 6 },
    dark: { key: 'dark', motion: 1.1, turbulence: 1.15, flicker: 1.15, warmth: -14 },
    bright: { key: 'bright', motion: 1.05, turbulence: 0.95, flicker: 0.9, warmth: 12 },
    neutral: { key: 'neutral', motion: 1, turbulence: 1, flicker: 1, warmth: 0 },
  };

  /**
   * Classify a free-text mood into a profile key.
   * @param {string} mood
   * @param {number} energy 0..1
   * @returns {string} a key of PROFILES
   */
  function classify(mood, energy) {
    const text = String(mood || '').toLowerCase();
    for (const [key, re] of KEYWORDS) {
      if (re.test(text)) return key;
    }
    // No keyword hit: fall back to energy alone. The thresholds are deliberately
    // wide so a mid-energy song stays neutral rather than being forced.
    const e = Number.isFinite(energy) ? energy : 0.4;
    if (e >= 0.66) return 'energetic';
    if (e <= 0.3) return 'calm';
    return 'neutral';
  }

  /**
   * The profile for a song, with energy blended in so two "calm" songs of
   * different energy still differ. Energy nudges `motion` around the profile's
   * base rather than replacing it.
   *
   * @param {string} mood free-text mood
   * @param {number} energy 0..1
   * @returns {{key: string, motion: number, turbulence: number, flicker: number, warmth: number}}
   */
  function profileFor(mood, energy) {
    const base = PROFILES[classify(mood, energy)];
    const e = Number.isFinite(energy) ? Math.max(0, Math.min(1, energy)) : 0.4;
    // ±20% around the profile's motion, tracking energy about its 0.4 midpoint.
    const motion = base.motion * (1 + (e - 0.4) * 0.5);
    return { ...base, motion: Math.max(0.4, Math.min(2, motion)) };
  }

  window.MoodProfile = { profileFor, classify, PROFILES };
})();
