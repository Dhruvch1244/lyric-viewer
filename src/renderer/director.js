'use strict';

/*
  🎬 Director — picks the look for each part of the song, like a VJ who has
  heard it before.

  heatmap.js already splits a song into sections and names them (intro,
  verse, build, drop, break, outro). This maps each section to a scene that
  fits it: quiet Prism or an Overlay look for intros, breaks and outros;
  flowing shaders and Prism for verses; tunnels and pulses for builds; the
  hardest scenes (lasers, hyperspace, lightning) for drops.

  Deterministic per song: the choice hashes the track key with the section's
  start, so the same song is directed the same way every time it plays, and
  two songs in a row are not directed identically. The mood biases Prism's
  palette and the genre how hard the drops go; nothing here is random.

  Pure: no DOM, no renderer state. renderer.js asks `plan()` when the section
  changes and applies the answer without saving it, so turning the Director
  off puts the song's own look straight back.

  Exposed on window.Director: { plan, kinds, intensityFor }.
*/

(function () {
  /* Overlay looks that suit a quiet passage under lyrics. */
  const CALM_OVERLAY = ['liquid', 'starfield', 'vinyl', 'wormhole'];

  /* Shader scenes by how hard they hit. Names are catalogue names
     (shaders/index.json). */
  const SHADERS = {
    verse: ['Aurora', 'Ripples', 'Lava Lamp', 'Synthwave', 'Neon Rings', 'Plasma Pulse', 'Kaleidoscope'],
    build: ['Hex Pulse', 'Ring Tunnel', 'Vortex', 'Spectrum 3D', 'Skyline', 'Starburst'],
    drop: ['Laser Show', 'Laser Tunnel', 'Hyperspace', 'Club', 'Lightning', 'Fractal Bloom', 'Inferno', 'Shatter', 'Laser Grid'],
    hardDrop: ['Laser Show', 'Club', 'Lightning', 'Glitch', 'Shatter', 'Laser Grid'],
  };

  /* Prism forms by character (prism.js FORMS order). */
  const PRISM_FORMS = {
    calm: [0, 7, 8, 9],       // rings, waves, plasma, flower
    verse: [1, 3, 4, 11],     // spiral, hex, cells, weave
    build: [5, 6, 2, 10],     // tunnel, rays, grid, stars
  };
  /* Warps: calm sections stay plain or gently bent; builds go kaleidoscopic. */
  const PRISM_WARPS = { calm: [0, 2], verse: [0, 1, 5], build: [3, 4, 1] };
  /* Palettes per mood (prism.js PALETTES order): 0 song, 1 fire, 2 ice,
     3 neon, 4 sunset, 5 mono, 6 rainbow, 7 acid. */
  const MOOD_PALETTES = {
    calm: [2, 0, 4],
    dark: [5, 2, 3],
    bright: [4, 6, 0],
    energetic: [1, 3, 7],
    neutral: [0, 3, 4],
  };

  const HARD_GENRE = /\b(metal|rock|punk|edm|dubstep|trap|drum|bass|hardstyle|techno|house|electro|phonk)\b/i;
  const SOFT_GENRE = /\b(r&b|rnb|soul|jazz|lo.?fi|ambient|chill|acoustic|classical|folk|ghazal|sufi)\b/i;

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h;
  }

  const pick = (list, h, salt) => list[(h >>> salt) % list.length];

  /** How hard a genre wants its drops: 'hard' | 'soft' | 'normal'. */
  function intensityFor(genre) {
    if (!genre) return 'normal';
    if (HARD_GENRE.test(genre)) return 'hard';
    if (SOFT_GENRE.test(genre)) return 'soft';
    return 'normal';
  }

  function prismFor(character, mood, h) {
    const form = pick(PRISM_FORMS[character], h, 3);
    const warp = pick(PRISM_WARPS[character], h, 7);
    const palette = pick(MOOD_PALETTES[mood] || MOOD_PALETTES.neutral, h, 11);
    return `${form}-${warp}-${palette}`;
  }

  /**
   * The scene for one section.
   * @param {object} q
   * @param {string} q.trackKey  stable id for the song
   * @param {string} q.kind      heatmap.js section kind
   * @param {number} q.startMs   the section's start, so each section of a song differs
   * @param {string} [q.mood]    MoodProfile key: calm / energetic / dark / bright / neutral
   * @param {string} [q.genre]   free-text genre
   * @returns {{look: string, shader?: string, prism?: string, label: string}}
   */
  function plan(q) {
    const h = hash(`${q.trackKey}|${Math.round((q.startMs || 0) / 1000)}|${q.kind}`);
    const mood = q.mood || 'neutral';
    const force = intensityFor(q.genre);

    switch (q.kind) {
      case 'drop': {
        // Soft genres get a big but not violent scene: Prism at full tilt.
        if (force === 'soft') return { look: 'prism', prism: prismFor('build', mood, h), label: 'Drop' };
        const list = force === 'hard' ? SHADERS.hardDrop : SHADERS.drop;
        return { look: 'shaders', shader: pick(list, h, 2), label: 'Drop' };
      }
      case 'build':
        return (h & 1)
          ? { look: 'shaders', shader: pick(SHADERS.build, h, 2), label: 'Build' }
          : { look: 'prism', prism: prismFor('build', mood, h), label: 'Build' };
      case 'verse':
        return (h % 3 === 0)
          ? { look: 'prism', prism: prismFor('verse', mood, h), label: 'Verse' }
          : { look: 'shaders', shader: pick(SHADERS.verse, h, 2), label: 'Verse' };
      case 'intro':
      case 'outro':
      case 'break':
      default: {
        const label = q.kind ? q.kind[0].toUpperCase() + q.kind.slice(1) : 'Calm';
        return (h & 1)
          ? { look: pick(CALM_OVERLAY, h, 2), label }
          : { look: 'prism', prism: prismFor('calm', mood, h), label };
      }
    }
  }

  window.Director = {
    plan,
    intensityFor,
    kinds: ['intro', 'verse', 'build', 'drop', 'break', 'outro'],
    SHADERS,
    CALM_OVERLAY,
  };
})();
