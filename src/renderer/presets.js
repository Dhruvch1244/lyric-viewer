'use strict';

/*
  Named visual presets.

  Before this, the backdrop picked its layers from a random coin-flip every few
  seconds. That produced variety but no *identity*: nothing to choose, nothing
  to come back to, nothing to recommend to somebody. It also had no cost
  ceiling — an unlucky roll could switch every expensive layer on at once.

  A preset fixes both. Each one is a deliberate look with a stated cost, so the
  user picks the feel they want and the renderer knows what it is paying for.
  Presets also carry swirl-shader biases, so the GPU field changes character
  with the look rather than staying constant underneath it.

  Design rules:
    - `liquid` is the signature and the default. It is the look this app is
      known for: the GPU field doing the work with the 2D layers staying out of
      its way. Do not demote it.
    - Every preset states a `cost` from 1 (cheap) to 3 (heavy). Lite mode and
      the FPS governor use it to pick something affordable rather than
      butchering whatever is on screen.
    - Layer flags are a complete set. A preset that omits a key means "off",
      so adding a new layer later cannot silently switch itself on everywhere.

  Exposed on window.VisualPresets.
*/

(function () {
  /**
   * @typedef {object} Preset
   * @property {string} id            stable key, persisted
   * @property {string} name          shown on the HUD chip
   * @property {1|2|3} cost           rough GPU/CPU weight
   * @property {object} layers        which 2D layers are enabled
   * @property {object} swirl         shader biases, see swirl.js render()
   */

  /** Complete layer set; every preset is normalised against this. */
  const LAYER_KEYS = ['aurora', 'bokeh', 'eq', 'rays', 'math', 'web', 'galaxy'];

  /** @type {Preset[]} */
  const PRESETS = [
    {
      id: 'ghost',
      name: 'Ghost',
      cost: 0,
      /*
        Lyrics and the cloud, nothing else.

        `bare` is stronger than "every layer flag is false". The 2D canvas has
        always-on work that no layer flag covers — stars, colour glows, the
        vignette, ripples, confetti, the shooting star, the dancers — and even
        with all of it skipped the canvas is still a full-screen compositor
        layer being cleared and blended every frame. `bare` lets the renderer
        take the element out of the page entirely, so the only things left are
        the GPU cloud and the DOM lyrics.

        This is the cheapest thing the app can draw and still be itself.
      */
      bare: true,
      layers: { aurora: false, bokeh: false, galaxy: false, eq: false, rays: false, math: false, web: false },
      // The field is the whole picture now, so let it breathe: wider bands and
      // a softer glow read as drifting cloud rather than a tight vortex.
      swirl: { bandBias: 0.85, vortexBias: 0.95, glowBias: 1.05 },
    },
    {
      id: 'liquid',
      name: 'Liquid',
      cost: 1,
      // The signature look: let the shader carry it. Only the softest 2D
      // layers stay on, so nothing competes with the field.
      layers: { aurora: true, bokeh: true, galaxy: false, eq: false, rays: false, math: false, web: false },
      swirl: { bandBias: 1.15, vortexBias: 1.2, glowBias: 1.1 },
    },
    {
      id: 'starfield',
      name: 'Starfield',
      cost: 2,
      // Depth and drift: the galaxy and constellation read as space.
      layers: { aurora: false, bokeh: true, galaxy: true, eq: false, rays: true, math: false, web: true },
      swirl: { bandBias: 0.95, vortexBias: 0.9, glowBias: 1.25 },
    },
    {
      id: 'geometry',
      name: 'Geometry',
      cost: 2,
      // The parametric curves are the subject; the field calms to a backdrop.
      layers: { aurora: false, bokeh: false, galaxy: false, eq: false, rays: false, math: true, web: true },
      swirl: { bandBias: 0.9, vortexBias: 0.85, glowBias: 0.9 },
    },
    {
      id: 'concert',
      name: 'Concert',
      cost: 3,
      // Everything on: the loud one, for drops and parties.
      layers: { aurora: true, bokeh: true, galaxy: true, eq: true, rays: true, math: true, web: true },
      swirl: { bandBias: 1.35, vortexBias: 1.4, glowBias: 1.3 },
    },
    {
      id: 'minimal',
      name: 'Minimal',
      cost: 1,
      // Lyrics-first, and the cheapest thing we can draw. This is what the FPS
      // governor falls back to, and what to use over a game or a video call.
      layers: { aurora: false, bokeh: false, galaxy: false, eq: false, rays: false, math: false, web: false },
      swirl: { bandBias: 0.9, vortexBias: 0.8, glowBias: 0.75 },
    },
  ];

  const DEFAULT_ID = 'liquid';

  /**
   * Fill in any missing layer keys as `false`, so a preset can never inherit a
   * layer added after it was written.
   * @param {Preset} preset
   * @returns {Preset}
   */
  function normalize(preset) {
    const layers = {};
    for (const key of LAYER_KEYS) layers[key] = Boolean(preset.layers && preset.layers[key]);
    return { ...preset, layers, bare: Boolean(preset.bare) };
  }

  const NORMALIZED = PRESETS.map(normalize);

  /**
   * Look up a preset by id, falling back to the default.
   * @param {string} id
   * @returns {Preset}
   */
  function byId(id) {
    return NORMALIZED.find((p) => p.id === id) || NORMALIZED.find((p) => p.id === DEFAULT_ID);
  }

  /**
   * The next preset in the cycle.
   * @param {string} id current preset id
   * @returns {Preset}
   */
  function next(id) {
    const i = NORMALIZED.findIndex((p) => p.id === id);
    return NORMALIZED[(i + 1 + NORMALIZED.length) % NORMALIZED.length];
  }

  /**
   * Looks a song may be randomly assigned.
   *
   * `minimal` is excluded on purpose: it exists as the performance fallback,
   * not as an aesthetic. Landing on it at random would make the app feel
   * stripped-back most of the time, with the good visuals showing only in
   * brief bursts — which is precisely the complaint that prompted this design.
   *
   * `ghost` is excluded for the opposite reason: it is a deliberate mode you
   * choose when you want only the lyrics, not a look to be handed at random.
   */
  const RANDOM_POOL = NORMALIZED.filter((p) => p.id !== 'minimal' && p.id !== 'ghost');

  /**
   * The look for a given track — random across songs, identical every time you
   * play the same one.
   *
   * Chosen by hashing the track identity rather than rolling dice and saving
   * the result. Same outcome, no storage to grow stale, and a song looks the
   * same on a fresh install as it did before. (An explicit user override IS
   * stored; see the renderer.)
   *
   * @param {string} trackKey stable "artist|title" identity
   * @returns {Preset}
   */
  function forTrack(trackKey) {
    const key = String(trackKey || '');
    if (!key) return byId(DEFAULT_ID);
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return RANDOM_POOL[hash % RANDOM_POOL.length];
  }

  /**
   * Downgrade a preset when the machine cannot keep up.
   *
   * Returning a *different, coherent* preset beats switching individual layers
   * off, which is how the old shuffle degraded — that produced looks nobody
   * designed and it was never obvious why the screen suddenly changed.
   *
   * @param {Preset} preset the user's choice
   * @param {number} fps smoothed frame rate
   * @param {boolean} lite whether Lite mode is on
   * @returns {Preset} the preset to actually render
   */
  function affordable(preset, fps, lite) {
    // Lite mode is an explicit user choice, so honour it immediately.
    if (lite && preset.cost > 1) return byId('minimal');

    /*
      Otherwise only step in when the app is genuinely struggling. An earlier
      version downgraded below 45fps and substituted a different look silently;
      41fps is perfectly smooth, so users lost the preset they picked for no
      visible reason. Frame rate is also noisy right after a track change,
      which made it flap.

      So: one threshold, set low enough that crossing it means real trouble,
      and a single destination (`minimal`) rather than a slide through
      intermediate looks. The caller surfaces the substitution on the chip so
      it is never silent.
    */
    if (fps < 24 && preset.cost > 1) return byId('minimal');
    return preset;
  }

  window.VisualPresets = {
    all: NORMALIZED,
    byId,
    next,
    forTrack,
    RANDOM_POOL,
    affordable,
    DEFAULT_ID,
    LAYER_KEYS,
  };
})();
