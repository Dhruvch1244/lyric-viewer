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

  /**
   * Complete layer set; every preset is normalised against this.
   *
   * `heatmap`, `vinyl` and `stage` are ordinary layers, deliberately. Heatmap
   * was originally bolted onto Ghost's `bare` escape hatch and then had to undo
   * it mid-frame to draw anything, which made it the one preset whose flags did
   * not describe what it drew — and silently cost it the sprites, ripples,
   * drop flash and confetti that every other look gets, because the bare branch
   * returns before all of that. As layers they compose like everything else.
   */
  const LAYER_KEYS = ['aurora', 'bokeh', 'eq', 'rays', 'math', 'web', 'galaxy', 'heatmap', 'vinyl', 'stage', 'wormhole'];

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
      /*
        The field is the whole picture now, so let it breathe: wider bands and
        a softer glow read as drifting cloud rather than a tight vortex.

        `kick` is the important one. Every punchy element in this app — ripples,
        confetti, the strobe flicker, the dancers — draws on the 2D canvas, and
        Ghost removes it. The beat still fires, it just has nowhere to show. The
        shader's own beat response was tuned to sit BEHIND those layers, so on
        its own it reads as barely moving. Amplifying it here gives the drums
        somewhere to land: the field punches in and blooms on every kick.
      */
      swirl: { bandBias: 0.85, vortexBias: 0.95, glowBias: 1.05, kick: 3.2 },
    },
    {
      id: 'heatmap',
      name: 'Heatmap',
      cost: 1,
      /*
        The song drawn as a shape you can see all of at once — a timeline along
        the bottom edge, each cell a slice of the track, rising where the music
        peaks. It fills in as the song is heard and is remembered afterwards, so
        on a replay the whole arc is visible before it arrives: the drop is on
        screen while the build-up is still playing.

        The bar sits under the lyrics rather than around them, so the mode costs
        the reader nothing — it is a look you can leave on, not one you switch
        to and then switch away from.
      */
      layers: { heatmap: true, bokeh: true },
      swirl: { bandBias: 0.8, vortexBias: 0.75, glowBias: 0.95, kick: 2.4 },
    },
    {
      id: 'vinyl',
      name: 'Vinyl',
      cost: 1,
      /*
        The cover art as a record on a deck, turning the whole time the song is
        playing — a DJ's platter, not a progress dial. The heatmap timeline runs
        underneath it, so the record shows what is playing and the bar shows
        where in the song it sits.

        Rotation locks to the measured BPM when there is one, which is the point:
        the platter and the music are on the same clock, so the label sweeps past
        the needle on the beat.
      */
      layers: { vinyl: true, heatmap: true, bokeh: true },
      swirl: { bandBias: 0.85, vortexBias: 0.8, glowBias: 1.0, kick: 1.8 },
    },
    {
      id: 'stage',
      name: 'Stage',
      cost: 2,
      /*
        The dancers are the subject for once. A lit floor, spotlights that punch
        on the kick, and the troupe pushed forward and enlarged; a drop fills the
        stage with clones. Everything else is kept quiet so the stage reads.
      */
      layers: { stage: true, rays: true, bokeh: true },
      swirl: { bandBias: 1.05, vortexBias: 0.9, glowBias: 1.15, kick: 2.0 },
    },
    {
      id: 'wormhole',
      name: 'Wormhole',
      cost: 1,
      /*
        A smoky tunnel flying toward you, twisting as it comes. Bands of vapour
        travel from a vanishing point out past the corners with a z²
        perspective, so they bunch at the throat and accelerate away — that
        acceleration is what reads as travel rather than as circles getting
        bigger — and loose wisps drift between them so the tunnel has an inside
        rather than just walls.

        The one look where anticipation is the headline: the tunnel constricts
        and winds up in the seconds BEFORE a drop the stored heat map already
        knows about, so the acceleration leads the music.
      */
      /*
        `soloLayer` is a weaker relative of `bare`. Bare removes the 2D canvas
        from the page entirely, which is why it belongs to Ghost alone — a
        preset that needs to DRAW something cannot use it. Solo keeps the canvas
        but suppresses everything the layer flags do not name: no stars, glows,
        vignette, ripples, confetti, shooting stars or dancers.

        So this is Ghost's idea applied to a mode that has a picture: the tunnel
        and the words, nothing else.
      */
      soloLayer: true,
      /*
        NOT `transparentBg`, deliberately, and this was tried both ways.

        A transparent background was the original request, and it works — the
        `transparentBg` flag still exists and the MilkDrop looks depend on it.
        But watched against real music rather than in a screenshot, a tunnel
        floating on the bare desktop reads as a widget sitting on top of the
        screen; with the field behind it, the smoke has something to be smoke
        *in*, and it reads as depth. Reverted on that basis.

        `soloLayer` still suppresses the wash, the cover photo and every 2D
        extra, and the field is thinned hard for solo looks (see `fieldAlpha` in
        renderer.js) so it supports the tunnel instead of swallowing it.
      */
      layers: { wormhole: true },
      swirl: { bandBias: 0.7, vortexBias: 1.35, glowBias: 1.1, kick: 2.6 },
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
      layers: { aurora: true, bokeh: true, galaxy: true, eq: false, rays: true, math: true, web: true },
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

    /*
      MilkDrop looks. These run the OTHER engine — Butterchurn, not the swirl
      shader — and are the answer to the one gap that could not be closed by
      writing more layers by hand: projectM has thousands of presets and Plane9
      has 250 scenes, against our one aesthetic.

      They are `soloLayer` + `transparentBg` for a reason that is not cosmetic:
      the MilkDrop canvas IS the picture, it fills the screen, and both the
      swirl field and the 2D extras would be drawing underneath something
      opaque. Solo also keeps the lyrics, which is the entire point — no
      MilkDrop player anywhere shows the words.

      `milkdrop` names a starting preset from the pack. It is a *starting*
      point: cycleMilkdrop() moves through the catalogue from there, and a name
      that a pack upgrade removed resolves to the first available preset rather
      than to a black screen.
    */
    {
      id: 'milkdrop',
      name: 'MilkDrop',
      cost: 2,
      engine: 'milkdrop',
      soloLayer: true,
      transparentBg: true,
      milkdrop: 'martin - mandelbox explorer - high speed demo version',
      layers: {},
      swirl: {},
    },
    {
      id: 'milkdrop-ii',
      name: 'MilkDrop II',
      cost: 2,
      engine: 'milkdrop',
      soloLayer: true,
      transparentBg: true,
      /* A second entry point into the same 395-preset catalogue, so the cycle
         does not always start from the same look. Named by number rather than
         by character ("Soft", "Calm") on purpose: these are community presets
         and nobody has classified them, so any adjective here would be a
         promise the code cannot keep. */
      milkdrop: 'Flexi - alien fish pond',
      layers: {},
      swirl: {},
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
    return {
      ...preset,
      layers,
      bare: Boolean(preset.bare),
      soloLayer: Boolean(preset.soloLayer),
      transparentBg: Boolean(preset.transparentBg),
      /* Which engine draws this look. Defaulted rather than required so every
         preset written before there was a second engine keeps working. */
      engine: preset.engine === 'milkdrop' ? 'milkdrop' : 'swirl',
      milkdrop: preset.milkdrop || null,
    };
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
   *
   * `heatmap`, `vinyl` and `stage` ARE in the pool. They were held out while the
   * heatmap was a bare mode that blanked everything else; as ordinary looks they
   * are things worth being handed, and each degrades honestly when its input is
   * missing — an unlearned song draws a faint timeline, a track with no cover
   * art gets a plain record.
   */
  /**
   * Looks that need a second engine, and are therefore excluded from the random
   * pool even though they are perfectly good looks.
   *
   * A MilkDrop preset that cannot run — WebGL2 missing, the vendored bundle not
   * loaded, a preset pack that failed to parse — degrades to a blank screen
   * with lyrics on it, and being handed that at random for a song you did not
   * ask it for is far worse than never being handed it at all. They stay fully
   * available by choice, which is a decision the user can immediately undo.
   */
  const SECOND_ENGINE = NORMALIZED.filter((p) => p.engine !== 'swirl').map((p) => p.id);

  const RANDOM_POOL = NORMALIZED.filter(
    (p) => !['minimal', 'ghost'].includes(p.id) && !SECOND_ENGINE.includes(p.id)
  );

  /**
   * Which RANDOM_POOL presets suit each mood character, for `forTrack`'s
   * optional mood bias. Deliberately a SUBSET per mood, not one fixed preset
   * — a single answer per mood would make every "energetic" song look
   * identical, which defeats the reason RANDOM_POOL exists at all.
   *
   * `neutral`, and any mood key not listed here, intentionally fall through
   * to the full pool in `forTrack` below — that includes "no mood known yet",
   * which is the common case at the exact moment a preset first gets chosen
   * (mood resolves asynchronously, after lyrics). A user with no LLM key
   * configured — so mood never resolves at all — sees exactly today's
   * behaviour, unchanged. See mood.js for where these keys come from.
   */
  const MOOD_POOLS = {
    energetic: ['concert', 'starfield', 'stage', 'geometry'],
    dark: ['wormhole', 'geometry', 'concert'],
    calm: ['liquid', 'heatmap', 'vinyl'],
    bright: ['vinyl', 'liquid', 'starfield'],
  };

  /**
   * Genre text is free-form (MusicBrainz tags, an LLM's own wording — see
   * genre.rs) where mood is a small fixed vocabulary, so it needs a
   * classification step mood.js's `classify()` already proves the shape of:
   * keyword buckets, first match wins, order most-specific-first. Bucketed
   * rather than matched 1:1 against `GENRE_POOLS` so "Hip-Hop", "hip hop"
   * and "trap" all land the same place without enumerating every spelling.
   */
  const GENRE_KEYWORDS = [
    ['urban', /\b(hip.?hop|rap|trap|grime|drill)\b/i],
    ['electronic', /\b(edm|electronic|house|techno|trance|dubstep|dance|drum.?(and|&).?bass|dnb)\b/i],
    ['smooth', /\b(r&b|rnb|soul|jazz|lo.?fi|ambient|chill)\b/i],
    ['intense', /\b(rock|metal|punk|hardcore|grunge)\b/i],
    ['organic', /\b(folk|country|acoustic|indie|singer.?songwriter|americana)\b/i],
    ['global', /\b(latin|reggaeton|k.?pop|bollywood|afrobeat|desi|bhangra|devotional)\b/i],
    ['classical', /\b(classical|orchestral|instrumental|symphon)\b/i],
  ];

  /** @param {string} genre raw text from genre.rs @returns {string} a GENRE_POOLS key */
  function classifyGenre(genre) {
    const text = String(genre || '').toLowerCase();
    for (const [key, re] of GENRE_KEYWORDS) {
      if (re.test(text)) return key;
    }
    return 'pop'; // unrecognised or actually "pop" — same bucket, same reasoning as mood's neutral fallback
  }

  /** Which RANDOM_POOL presets suit each genre bucket — same shape as MOOD_POOLS. */
  const GENRE_POOLS = {
    urban: ['concert', 'stage', 'geometry'],
    electronic: ['concert', 'geometry', 'starfield'],
    smooth: ['liquid', 'vinyl', 'heatmap'],
    intense: ['wormhole', 'concert', 'geometry'],
    organic: ['vinyl', 'heatmap', 'liquid'],
    global: ['concert', 'starfield', 'stage'],
    classical: ['liquid', 'heatmap', 'vinyl'],
    pop: ['starfield', 'vinyl', 'liquid'],
  };

  /**
   * The look for a given track — random across songs, identical every time
   * you play the same one, optionally biased toward the song's mood and/or
   * genre character without losing that determinism: the same
   * (track, mood, genre) always resolves to the same look.
   *
   * When both mood and genre are known, the chosen pool is their
   * INTERSECTION — a look only survives when it fits both characters — with
   * a fallback to whichever single axis is non-empty, and then to the mood
   * pool alone if the intersection is empty (a mood match is the axis this
   * app has trusted longer, and rejects fewer candidates than genre's wider
   * bucket set does). Neither axis known falls through to the full pool —
   * unchanged behaviour for a song whose mood/genre have not resolved yet
   * (both are asynchronous, after lyrics) or when no LLM key is configured.
   *
   * Chosen by hashing the track identity rather than rolling dice and saving
   * the result. Same outcome, no storage to grow stale, and a song looks the
   * same on a fresh install as it did before. (An explicit user override IS
   * stored; see the renderer.)
   *
   * @param {string} trackKey stable "artist|title" identity
   * @param {string} [moodKey] a MoodProfile key — 'calm'/'energetic'/'dark'/'bright'/'neutral'
   * @param {string} [genreKey] raw genre text from genre.rs, e.g. "Hip-Hop"
   * @returns {Preset}
   */
  function forTrack(trackKey, moodKey, genreKey) {
    const key = String(trackKey || '');
    if (!key) return byId(DEFAULT_ID);
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;

    const moodIds = MOOD_POOLS[moodKey];
    const moodPool = moodIds ? RANDOM_POOL.filter((p) => moodIds.includes(p.id)) : null;

    const genreIds = genreKey ? GENRE_POOLS[classifyGenre(genreKey)] : null;
    const genrePool = genreIds ? RANDOM_POOL.filter((p) => genreIds.includes(p.id)) : null;

    let chosen;
    if (moodPool && genrePool) {
      const both = moodPool.filter((p) => genrePool.includes(p));
      chosen = both.length ? both : moodPool;
    } else {
      chosen = moodPool || genrePool;
    }
    if (!chosen || !chosen.length) chosen = RANDOM_POOL;

    return chosen[hash % chosen.length];
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
    classifyGenre,
    RANDOM_POOL,
    SECOND_ENGINE,
    affordable,
    DEFAULT_ID,
    LAYER_KEYS,
  };
})();
