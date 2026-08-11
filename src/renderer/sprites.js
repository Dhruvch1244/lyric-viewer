'use strict';

/*
  Pixel-art artist sprites — "Pokémon-style" chibi characters that roam across
  the bottom of the overlay and dance to the music.

  v2:
  - EVERY collaborator on a track gets their own dancer, parsed from the artist
    string ("Seedhe Maut x DJ SA", "A & B", "X feat. Y", …). Known groups expand
    to their members (Seedhe Maut => a duo). Each dancer is NAMED on screen.
  - Dancers ROAM: each has its own X position that drifts across the stage and
    bounces off the edges, faster when the music is intense.
  - A dozen named dance moves (bob / sway / pump / spin / wave / headbang / dab /
    shuffle / moonwalk / hop / kick / point), picked at random and biased toward
    the energetic ones when the track is hyped. A drop forces a jump.

  Exposed on `window.ArtistSprites`:
    - actorsFor(artistString, seedHash) -> { label, actors: SpriteActor[] }
    - SpriteActor (update(now, env, w) / draw(ctx, w, h, unit, now, env))
*/

(function () {
  /* ------------------------------------------------------------- sprite body */

  // Legend: '.' transparent · o outline · k cap · b brim · s skin · e eye
  //         h hoodie · H hoodie-shadow · c chain/accent · p pants · w shoe
  const BODY = [
    '................',
    '.....oooooo.....',
    '....okkkkkko....',
    '...okkkkkkkko...',
    '...okkkkkkkko...',
    '...obbbbbbbbo...',
    '...osssssssso...',
    '...oseesseeso...',
    '...osssssssso...',
    '....ossssso....',
    '...ohhhhhhhho...',
    '..ohhhhhhhhhho..',
    '..ohhcHHHHchho..',
    '..ohhhhhhhhhho..',
    '..ohHhhhhhhHho..',
    '..oohhhhhhhhoo..',
    '...opppppppo....',
    '...oppo.oppo....',
    '...owwo.owwo....',
  ];

  function padGrid(rows) {
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return rows.map((r) => r.padEnd(w, '.'));
  }

  const GRID = padGrid(BODY);
  const GRID_W = GRID[0].length;
  const GRID_H = GRID.length;

  /* ------------------------------------------------------------ colour roles */

  function colorFor(ch, look) {
    switch (ch) {
      case 'o': return '#0b0b12';
      case 'k': return look.cap;
      case 'b': return look.brim;
      case 's': return look.skin;
      case 'e': return '#0b0b12';
      case 'h': return look.hoodie;
      case 'H': return look.hoodieDark;
      case 'c': return look.accent;
      case 'p': return look.pants;
      case 'w': return look.shoe;
      default: return null;
    }
  }

  function hsl(h, s, l) {
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

  /** #rrggbb + alpha → rgba() string (for the teleport flash gradient). */
  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
  }

  /** Deterministic 0..1 value per sprite cell, for the pixel-materialize reveal. */
  function cellNoise(r, c) {
    const h = ((r * 73856093) ^ (c * 19349663)) >>> 0;
    return (h % 1000) / 1000;
  }

  /** Multiply a #rrggbb colour toward black by `f` (0..1) → a darker shade. */
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }

  /* ---------------------------------------------------- pre-rendered body cache

     The body is a 16×19 pixel grid. Filling it cell-by-cell every frame cost up
     to ~150 fillRect calls per dancer (× up to 8 dancers × 60fps ≈ 70k/sec). We
     instead render each distinct colour-look ONCE to a small offscreen canvas and
     blit it with a single drawImage per dancer per frame — ~150× fewer draw calls.
     The per-cell path is kept only for the brief materialize reveal on spawn. */
  const BASE_CELL = 6;                 // px per grid cell in the cache bitmap
  const BODY_CACHE_MAX = 48;           // bound memory across a long, many-artist session
  const bodyCache = new Map();

  /** Stable cache key from a look's colour roles. */
  function lookSig(look) {
    return `${look.skin}|${look.cap}|${look.brim}|${look.hoodie}|${look.hoodieDark}|${look.accent}|${look.pants}|${look.shoe}`;
  }

  /**
   * Get (or build) the pre-rendered body bitmap for a look.
   * @param {object} look role→colour look
   * @returns {HTMLCanvasElement}
   */
  function bodyCanvas(look) {
    const key = lookSig(look);
    const cached = bodyCache.get(key);
    if (cached) return cached;

    const cv = document.createElement('canvas');
    cv.width = GRID_W * BASE_CELL;
    cv.height = GRID_H * BASE_CELL;
    const g = cv.getContext('2d');
    for (let r = 0; r < GRID_H; r += 1) {
      const row = GRID[r];
      for (let c = 0; c < GRID_W; c += 1) {
        const col = colorFor(row[c], look);
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(c * BASE_CELL, r * BASE_CELL, BASE_CELL, BASE_CELL);
      }
    }

    if (bodyCache.size >= BODY_CACHE_MAX) {
      bodyCache.delete(bodyCache.keys().next().value); // evict oldest (FIFO)
    }
    bodyCache.set(key, cv);
    return cv;
  }

  /* ------------------------------------------------- pre-rendered furniture

     Everything below exists because `SpriteActor.draw` was measured as the
     single largest JavaScript cost in the app — ~49ms of CPU per second, more
     than every backdrop layer put together. Profiling Ghost confirmed it: with
     the dancers gone the cost vanishes and idle time rises by 60ms/s.

     Three things in that function were doing per-dancer, per-frame work to
     produce a picture that barely changes: the name plate (a font assignment, a
     `measureText` text-shaping pass, then a rect and a fill), the ground shadow
     (a path build and fill), and the drop glow (`shadowBlur`, which is the most
     expensive operation the 2D context has). All three are now bitmaps. */

  /** Soft round shadow, drawn once and scaled per dancer. */
  let shadowSprite = null;

  function groundShadow() {
    if (shadowSprite) return shadowSprite;
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    shadowSprite = cv;
    return cv;
  }

  /** Accent glow behind the body on drops — replaces ctx.shadowBlur. */
  const glowCache = new Map();

  function glowSprite(colour) {
    const hit = glowCache.get(colour);
    if (hit) return hit;
    const size = 96;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, hexAlpha(colour, 0.75));
    grad.addColorStop(0.45, hexAlpha(colour, 0.28));
    grad.addColorStop(1, hexAlpha(colour, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    if (glowCache.size >= 24) glowCache.delete(glowCache.keys().next().value);
    glowCache.set(colour, cv);
    return cv;
  }

  /*
     Name plates.

     The font size follows the dancer's depth, but it is rounded to whole pixels
     and the band is narrow, so in practice a troupe uses two or three distinct
     sizes all session — the cache hits essentially always. Geometry is derived
     from the font size rather than the live sprite unit so the bitmap is
     self-consistent and can be blitted at its natural size. */
  const plateCache = new Map();

  function namePlate(label, fontPx, colour) {
    const key = `${label}|${fontPx}|${colour}`;
    const hit = plateCache.get(key);
    if (hit) return hit;

    const measure = document.createElement('canvas').getContext('2d');
    const font = `700 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
    measure.font = font;
    const textW = Math.ceil(measure.measureText(label).width);
    const padX = Math.round(fontPx * 0.45);
    const padY = Math.round(fontPx * 0.3);
    const cv = document.createElement('canvas');
    cv.width = textW + padX * 2;
    cv.height = fontPx + padY * 2;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.fillRect(0, 0, cv.width, cv.height);
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = colour;
    g.fillText(label, cv.width / 2, cv.height / 2);

    if (plateCache.size >= 64) plateCache.delete(plateCache.keys().next().value);
    plateCache.set(key, cv);
    return cv;
  }

  const SKINS = ['#c9895e', '#a56a42', '#e0aa7a', '#8a5a38', '#d79b6b'];

  /** Deterministic distinct look from a name hash. */
  function proceduralLook(name, hash) {
    const h = hash % 360;
    const accentH = (h + 150) % 360;
    return {
      name,
      procedural: true, // eligible for album-art recolouring (branded looks are not)
      skin: SKINS[hash % SKINS.length],
      cap: hsl(h, 70, 42),
      brim: hsl(h, 70, 30),
      hoodie: hsl(h, 55, 40),
      hoodieDark: hsl(h, 55, 28),
      accent: hsl(accentH, 90, 60),
      pants: hsl((h + 20) % 360, 25, 22),
      shoe: '#f2f2f2',
    };
  }

  /* --------------------------------------------------------- artist registry */

  const REGISTRY = [
    {
      match: 'seedhe maut',
      label: 'Seedhe Maut',
      members: [
        { name: 'Encore ABJ', skin: '#b9784c', cap: '#1b1b22', brim: '#111117', hoodie: '#2a2a34', hoodieDark: '#1c1c24', accent: '#ffcf3f', pants: '#15151b', shoe: '#f2f2f2' },
        { name: 'Calm', skin: '#a06238', cap: '#0f2a2e', brim: '#0a1e21', hoodie: '#123b3f', hoodieDark: '#0c2a2d', accent: '#39e6c8', pants: '#101418', shoe: '#e8e8e8' },
      ],
    },
    { match: 'divine', label: 'DIVINE', members: [{ name: 'DIVINE', skin: '#a5673d', cap: '#111117', brim: '#0b0b10', hoodie: '#20242c', hoodieDark: '#15181e', accent: '#ff4d4d', pants: '#14161c', shoe: '#f2f2f2' }] },
    { match: 'krsna', label: 'KR$NA', members: [{ name: 'KR$NA', skin: '#c08552', cap: '#101018', brim: '#0a0a12', hoodie: '#23252d', hoodieDark: '#16181f', accent: '#c0c0c0', pants: '#131319', shoe: '#eaeaea' }] },
    { match: 'prabh deep', label: 'Prabh Deep', members: [{ name: 'Prabh Deep', skin: '#b57843', cap: '#241a2e', brim: '#180f20', hoodie: '#2e2140', hoodieDark: '#1f1630', accent: '#b487ff', pants: '#171320', shoe: '#efefef' }] },
    { match: 'raftaar', label: 'Raftaar', members: [{ name: 'Raftaar', skin: '#c58a55', cap: '#0e1a12', brim: '#081109', hoodie: '#12301f', hoodieDark: '#0c2016', accent: '#43e06a', pants: '#111813', shoe: '#f0f0f0' }] },
    { match: 'mc stan', label: 'MC STΔN', members: [{ name: 'MC STΔN', skin: '#b07440', cap: '#1a1220', brim: '#100a15', hoodie: '#241830', hoodieDark: '#180f22', accent: '#ff6fd8', pants: '#141019', shoe: '#ededed' }] },
  ];

  /** Substring match against the (already-isolated) artist token. */
  function lookupRegistry(token) {
    const hay = token.toLowerCase();
    for (const entry of REGISTRY) {
      if (hay.includes(entry.match)) return entry;
    }
    return null;
  }

  /**
   * Split a raw artist string into individual collaborators. Handles the usual
   * separators seen on Spotify/YouTube ("x", "&", ",", "feat.", "ft.", "with",
   * "prod.", "vs", "×", "/", "+"). @param {string} raw @returns {string[]}
   */
  function splitArtists(raw) {
    if (!raw) return [];
    const marked = raw
      // Word-boundary before the keyword, then an OPTIONAL trailing dot the old
      // pattern failed to swallow (left a stray "." token from "feat.").
      .replace(/\s*\b(feat|ft|featuring|with|prod|vs|x|and)\b\.?\s*/gi, '|')
      .replace(/[×,&+/]/g, '|');
    const seen = new Set();
    const out = [];
    for (const part of marked.split('|')) {
      const name = part.trim().replace(/\s+/g, ' ');
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  /** Stable small hash of a string, for procedural looks. */
  function hashOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  const MAX_ACTORS = 8; // keep the stage readable even on posse cuts

  /* Sprites roam this stage band (normalised viewport Y). It spans a tall lower
     region — from just under the centred lyric down to the HUD — so dancers
     genuinely travel in BOTH axes and across the full width, instead of hugging a
     thin strip along the very bottom. The sprite unit is kept small (see renderer)
     so even a dancer near the top of the band stays clear of the big lyric line.

     Mutable, because Stage mode compresses the band onto its lit floor and
     enlarges the dancers. Held as module state rather than passed per call: an
     actor clamps itself to the band on every update, and threading the bounds
     through update() and the wander targets would put the same two numbers in
     five signatures. */
  let BAND_TOP = 0.60;
  let BAND_BOTTOM = 0.96;

  /**
   * Set the band the dancers roam within.
   * @param {number} top @param {number} bottom normalised viewport Y
   */
  function setBand(top, bottom) {
    const t = Number(top);
    const b = Number(bottom);
    if (!Number.isFinite(t) || !Number.isFinite(b) || b <= t) return;
    BAND_TOP = Math.max(0, Math.min(0.95, t));
    BAND_BOTTOM = Math.max(BAND_TOP + 0.02, Math.min(0.99, b));
  }

  /* -------------------------------------------------------------- move engine */

  /* A big roster of named moves. The pose() switch below animates each one; new
     entries fall back to the base bob until given a case, so the list is safe to
     extend. Energetic tracks bias toward the HYPE pool. */
  const MOVES = [
    'bob', 'sway', 'pump', 'spin', 'point', 'wave', 'headbang', 'dab', 'shuffle',
    'moonwalk', 'hop', 'kick', 'robot', 'floss', 'twist', 'jumpingjack', 'breakdance',
    'wobble', 'charleston', 'vogue', 'skank', 'crumporch',
  ];
  const HYPE_MOVES = [
    'pump', 'spin', 'shuffle', 'hop', 'wave', 'headbang', 'kick', 'jumpingjack',
    'breakdance', 'floss', 'crumporch', 'skank',
  ];

  /* Entrance / teleport-switch animations played when a dancer spawns, when it
     takes the mic (teleport), and on every drop (a mixed re-appear). Seven
     styles so a re-spawn of the whole troupe looks varied — corners fly-in,
     warp-slide from the sides, drop-in from above, pixel-materialize, spiral-in,
     elastic pop, and on-the-spot teleport with a flash. */
  const SPAWN_ANIMS = ['teleport', 'corners', 'materialize', 'dropin', 'warpslide', 'popscale', 'spiral'];
  /** Shared no-op modifier once an entrance has finished (avoids per-frame allocs). */
  const SPAWN_IDLE = { ox: 0, oy: 0, scale: 1, alpha: 1, reveal: 1, flash: 0 };
  /** Fully hidden — used while an actor waits out its staggered spawn delay. */
  const SPAWN_HIDDEN = { ox: 0, oy: 0, scale: 1, alpha: 0, reveal: 0, flash: 0 };

  /** One roaming, dancing pixel character. */
  class SpriteActor {
    /**
     * @param {object} look role→colour look with a `name`
     * @param {number} index position in the lineup
     * @param {number} total lineup size
     */
    constructor(look, index, total) {
      this.look = look;
      this.name = look.name || '';
      this.x = (index + 0.5) / total;               // normalised stage X
      this.y = BAND_TOP + Math.random() * (BAND_BOTTOM - BAND_TOP); // start in the bottom band
      this.active = index === 0;                    // "on the mic" flag; renderer rotates it per line
      this.dir = index % 2 ? 1 : -1;                // horizontal roam direction
      this.speed = 0.00004 + Math.random() * 0.00006;
      this.speedY = 0.00002 + Math.random() * 0.00004;
      this.phase = index * 1.7;
      this.tempo = 5.4 + Math.random() * 1.6;       // free-running fallback tempo

      /* Musical time, in beats elapsed. This is what the pose oscillators run
         on, so every move cycle is a whole number of beats and the troupe lands
         on the music instead of near it. Advanced in update(): from the app's
         measured beat clock when it has locked, otherwise from this actor's own
         free-running tempo, which is what the dancers always used to do. */
      this.beats = 0;
      this.lastBeatPhase = 0;
      /* A fraction of a beat of personal lateness, so a troupe reads as several
         people feeling the same beat rather than one sprite drawn eight times.
         Small enough (< 1/16 note) that nobody looks off-beat. */
      this.beatOffset = (index % 4) * 0.03;
      // Wander target: each actor lazily steers toward a roaming point, kept
      // inside the bottom band so nobody drifts up over the lyric.
      this.tx = Math.random();
      this.ty = BAND_TOP + Math.random() * (BAND_BOTTOM - BAND_TOP);
      this.retargetAt = 0;
      /** Whether this dancer is currently drawing in for an expected drop. */
      this.gathering = false;
      this.move = MOVES[(Math.random() * MOVES.length) | 0];
      this.moveUntil = 0;
      this.jump = 0;
      this.facing = 1;
      this.facingCur = 1;
      this.scale = 0.8 + Math.random() * 0.25;      // per-actor size variety (kept small to clear the lyric)
      this.lastDrop = 0;
      this.lastNow = 0;

      // Clone lifespan: a drop clone is created with ttl > 0 and retires (expired)
      // when it elapses. Regular dancers keep ttl = 0 and live forever.
      this.ttl = 0;
      this.expired = false;

      // Entrance / teleport animation state (see triggerSpawn + spawnMod). A
      // negative spawnStart means "play an intro the first time I'm updated".
      this.spawnType = 'popscale';
      this.spawnStart = -1;
      this.spawnDur = 0;
      this.spawnDelay = index * 130;                // stagger so a troupe pops in one-by-one
      this.sox = 0;                                 // spawn origin offset (normalised viewport)
      this.soy = 0;

      /* Scratch objects reused by pose() and spawnMod(). Both are called once
         per dancer per frame and their results are dead by the end of draw(),
         so allocating them was pure GC pressure — measured at ~2ms/s across the
         app. Never hold a reference to either past a frame. */
      this._pose = { dx: 0, dy: 0, rot: 0, sq: 1, armL: 0, armR: 0 };
      this._sm = { ox: 0, oy: 0, scale: 1, alpha: 1, reveal: 1, flash: 0 };
    }

    /**
     * Begin an entrance/teleport animation. Picks a random style unless one is
     * named, and seeds the travel origin for the flying-in styles.
     * @param {number} now @param {?string} type one of SPAWN_ANIMS, or null for random
     */
    triggerSpawn(now, type) {
      this.spawnType = type || SPAWN_ANIMS[(Math.random() * SPAWN_ANIMS.length) | 0];
      this.spawnStart = now + (this.spawnDelay || 0);
      this.spawnDur = 480 + Math.random() * 360;
      const side = Math.random() < 0.5 ? -1 : 1;
      if (this.spawnType === 'corners') { this.sox = side * (0.5 + Math.random() * 0.4); this.soy = -(0.4 + Math.random() * 0.5); }
      else if (this.spawnType === 'warpslide') { this.sox = side * (0.8 + Math.random() * 0.5); this.soy = 0; }
      else if (this.spawnType === 'dropin') { this.sox = 0; this.soy = -(0.6 + Math.random() * 0.5); }
      else { this.sox = 0; this.soy = 0; }
    }

    /**
     * Sample the current entrance animation as draw modifiers.
     * @param {number} now
     * @returns {{ox:number,oy:number,scale:number,alpha:number,reveal:number,flash:number}}
     */
    spawnMod(now) {
      if (this.spawnStart < 0 || !this.spawnDur) return SPAWN_IDLE;
      const p = (now - this.spawnStart) / this.spawnDur;
      if (p >= 1) return SPAWN_IDLE;
      if (p < 0) return SPAWN_HIDDEN;               // still waiting out its stagger delay
      const t = p;
      const eo = 1 - Math.pow(1 - t, 3);            // ease-out cubic
      const alpha = Math.min(1, t * 1.6);
      // Filled in place; see the note on `_sm` in the constructor. The two
      // shared constants above are returned directly and allocate nothing.
      const m = this._sm;
      m.ox = 0; m.oy = 0; m.scale = 1; m.alpha = alpha; m.reveal = 1; m.flash = 0;
      switch (this.spawnType) {
        case 'corners':
          m.ox = this.sox * (1 - eo); m.oy = this.soy * (1 - eo); m.scale = 0.7 + 0.3 * eo;
          break;
        case 'dropin': {
          const bounce = eo - Math.sin(t * Math.PI) * 0.06 * (1 - t);
          m.oy = this.soy * (1 - bounce);
          break;
        }
        case 'warpslide':
          m.ox = this.sox * (1 - eo);
          break;
        case 'materialize':
          m.alpha = 1; m.reveal = t;
          break;
        case 'spiral': {
          const rad = (1 - eo) * 0.45;
          const ang = t * Math.PI * 4;
          m.ox = Math.cos(ang) * rad; m.oy = Math.sin(ang) * rad * 0.5; m.scale = 0.5 + 0.5 * eo;
          break;
        }
        case 'popscale': {
          // Elastic overshoot: scales past 1 then settles.
          const s = 1 - Math.pow(2, -10 * t) * Math.cos((t * 10 - 0.75) * ((2 * Math.PI) / 3));
          m.scale = Math.max(0.02, s);
          break;
        }
        case 'teleport':
        default: {
          // Rematerialize on the spot: over-scale collapses to 1 while a strobe
          // flicker fades the body in and a flash ring pings (drawn in draw()).
          const flick = 0.5 + 0.5 * Math.sin(t * 40);
          m.scale = 1 + (1 - eo) * 0.5;
          m.alpha = alpha * (0.4 + 0.6 * flick);
          m.flash = 1 - t;
          break;
        }
      }
      return m;
    }

    /**
     * Advance roaming + move selection. The active dancer (the vocalist on the
     * current line) roams the bottom band and cycles the full move set; every
     * other dancer just stands on the baseline and slides along X.
     * @param {number} now @param {{intensity:number,buildup:number,drop:number}} env
     */
    update(now, env) {
      if (this.spawnStart < 0) this.triggerSpawn(now, null); // play the intro on first update
      const dt = this.lastNow ? Math.min(50, now - this.lastNow) : 16;
      this.lastNow = now;

      // Clone retirement: count down and mark expired so the renderer drops it.
      if (this.ttl > 0) {
        this.ttl -= dt;
        if (this.ttl <= 0) { this.expired = true; return; }
      }

      /*
        Advance musical time.

        Locked: the app's beat clock is the source of truth, so count whole
        beats by watching its phase wrap and add the fractional part. That keeps
        the dancers phase-aligned with the music indefinitely — accumulating
        dt/period instead would drift as soon as the measured tempo was refined.

        Unlocked (no audio capture, or a passage with no usable percussion):
        fall back to the actor's own tempo, converted from radians per second to
        beats so the pose code has a single time base to read.
      */
      if (env.tempoLocked && env.beatPeriodMs > 0) {
        const phase = env.beatPhase || 0;
        if (phase < this.lastBeatPhase) this.beats = Math.floor(this.beats) + 1;
        this.lastBeatPhase = phase;
        this.beats = Math.floor(this.beats) + phase;
      } else {
        this.beats += (dt / 1000) * (this.tempo / (Math.PI * 2));
      }

      const energy = 1 + env.intensity * 2.6 + env.buildup * 1.5 + env.drop * 2;

      /*
        Anticipation: the stored heat map says a drop is coming. The troupe
        gathers toward the middle of the stage for it, so the drop scatters a
        group that had already drawn together — the reason the moment reads is
        the contrast, and that needs setting up before it lands.
      */
      const gathering = (env.anticipation || 0) > 0.35;

      if (this.active) {
        // Vocalist: roam left–right across the bottom band with a gentle bob, and
        // cycle the full (hype-biased) move set. Targets stay inside the band so
        // it never drifts up over the lyric.
        // Retarget on the usual timer, and once more the moment the gather
        // begins — testing `gathering` every frame would re-roll the target
        // continuously and leave the dancer shivering in place.
        if (now >= this.retargetAt || gathering !== this.gathering) {
          this.gathering = gathering;
          this.tx = gathering
            ? 0.5 + (Math.random() - 0.5) * 0.24
            : 0.06 + Math.random() * 0.88;
          this.ty = BAND_TOP + Math.random() * (BAND_BOTTOM - BAND_TOP);
          this.retargetAt = now + 1400 + Math.random() * 2200;
        }
        const spdX = this.speed * energy * dt;
        const spdY = this.speedY * energy * dt;
        const ddx = this.tx - this.x;
        const ddy = this.ty - this.y;
        this.dir = ddx >= 0 ? 1 : -1;
        this.x += Math.max(-spdX, Math.min(spdX, ddx * 0.06));
        this.y += Math.max(-spdY, Math.min(spdY, ddy * 0.06));
        this.x += Math.sin(now / 1700 + this.phase) * 0.00035 * energy; // curved path

        if (now >= this.moveUntil) {
          const hyped = env.intensity > 0.4 || env.buildup > 0.5;
          const pool = hyped ? HYPE_MOVES : MOVES;
          this.move = pool[(Math.random() * pool.length) | 0];
          this.moveUntil = now + (hyped ? 650 + Math.random() * 700 : 1100 + Math.random() * 1500);
          if (this.move === 'spin') this.facing *= -1;
        }
        const wantFace = this.move === 'moonwalk' ? -this.dir : this.dir;
        if (this.move !== 'spin') this.facing = wantFace >= 0 ? 1 : -1;

        if (env.drop > 0.6 && this.lastDrop <= 0.6) this.jump = 1; // pop on the drop
      } else {
        // Off the mic: still roam the band in BOTH axes, just calmer than the
        // vocalist — idle dancers travel up/down and side to side too.
        if (now >= this.retargetAt || gathering !== this.gathering) {
          this.gathering = gathering;
          this.tx = gathering
            ? 0.5 + (Math.random() - 0.5) * 0.30
            : 0.06 + Math.random() * 0.88;
          this.ty = BAND_TOP + Math.random() * (BAND_BOTTOM - BAND_TOP);
          this.retargetAt = now + 2200 + Math.random() * 2800;
        }
        const spdX = this.speed * (0.5 + energy * 0.25) * dt;
        const spdY = this.speedY * (0.5 + energy * 0.25) * dt;
        const ddx = this.tx - this.x;
        const ddy = this.ty - this.y;
        this.dir = ddx >= 0 ? 1 : -1;
        this.x += Math.max(-spdX, Math.min(spdX, ddx * 0.05));
        this.y += Math.max(-spdY, Math.min(spdY, ddy * 0.05));

        if (now >= this.moveUntil) {
          this.move = Math.random() < 0.5 ? 'bob' : 'sway'; // calm idle moves only
          this.moveUntil = now + 1300 + Math.random() * 1500;
        }
        this.facing = this.dir >= 0 ? 1 : -1;
      }

      // Shared clamps: keep everyone inside the bottom band and on-screen.
      if (this.x < 0.04) { this.x = 0.04; this.tx = 0.2 + Math.random() * 0.2; }
      if (this.x > 0.96) { this.x = 0.96; this.tx = 0.6 + Math.random() * 0.2; }
      if (this.y < BAND_TOP) this.y = BAND_TOP;
      if (this.y > BAND_BOTTOM) this.y = BAND_BOTTOM;

      this.lastDrop = env.drop;
      this.jump *= 0.88;
      this.facingCur += (this.facing - this.facingCur) * 0.25;
    }

    /**
     * Compute the animated pose (in sprite cells) for the current move.
     *
     * Every oscillator runs on MUSICAL time — `this.beats`, which the app's
     * measured beat clock drives whenever it has locked. Each move therefore
     * cycles a whole number of times per beat and lands with the drums. The
     * multipliers below are cycles per beat: 1 is one motion per beat, 0.5 a
     * slow two-beat sway, 2 a double-time shuffle.
     *
     * Before this, each dancer ran on a private free-running tempo of roughly
     * one cycle a second, so the most closely-watched element on screen was the
     * one least connected to the music. The free-running clock survives only as
     * the fallback for when no tempo has been measured.
     *
     * @param {number} t seconds (kept for callers; motion now reads `this.beats`)
     * @param {{intensity:number,pulse:number,drop:number,anticipation:number}} env
     * @returns {{dx:number,dy:number,rot:number,sq:number,armL:number,armR:number}}
     */
    pose(t, env) {
      // Beat angle: one full turn per beat, offset by this dancer's personal lag.
      const a = (this.beats + this.beatOffset) * Math.PI * 2;
      /** Oscillator at `k` cycles per beat. */
      const osc = (k) => Math.sin(a * k);

      const b = osc(1);
      const b2 = osc(2);
      const e = 0.6 + env.intensity * 1.1 + env.pulse * 0.6;
      // Filled in place rather than allocated: this runs once per dancer per
      // frame and the object is dead by the end of draw(), which is pure GC
      // pressure for no benefit.
      const p = this._pose;
      p.dx = 0;
      p.dy = b * 0.35 * e;
      p.rot = 0;
      p.sq = 1 + b2 * 0.05 * e;
      p.armL = 0;
      p.armR = 0;
      switch (this.move) {
        case 'sway': p.dx = osc(0.5) * 1.4; p.rot = osc(0.5) * 0.08; break;
        case 'pump': p.armR = 0.5 + 0.5 * Math.abs(b); p.armL = 0.3 * Math.abs(b2); p.dy = Math.abs(b) * 0.6 * e; break;
        case 'point': p.armR = 0.9; p.rot = 0.05; break;
        case 'wave': p.armL = 0.5 + 0.5 * b; p.armR = 0.5 - 0.5 * b; break;
        case 'headbang': p.rot = osc(2) * 0.28; p.dy = Math.abs(b) * 0.5 * e; break;
        case 'dab': p.armR = 1; p.armL = 0.4; p.rot = -0.22; p.dy = 0.2; break;
        case 'shuffle': p.dx = osc(2) * 0.7; p.dy = Math.abs(osc(2)) * 0.5 * e; break;
        case 'moonwalk': p.armL = 0.4 + 0.3 * b; p.armR = 0.4 - 0.3 * b; p.rot = 0.05 * b; break;
        case 'hop': p.dy = Math.max(0, b) * 1.4 * e; break;
        case 'kick': p.dx = osc(0.5) * 0.5; p.rot = osc(0.5) * 0.12; p.armL = 0.4; break;
        case 'robot': p.armR = b > 0 ? 0.8 : 0.2; p.armL = b2 > 0 ? 0.6 : 0.1; p.dx = Math.round(osc(0.5)) * 0.6; break;
        case 'floss': p.dx = osc(2) * 1.1; p.armR = 0.5 + 0.5 * osc(2); p.armL = 0.5 - 0.5 * osc(2); break;
        case 'twist': p.rot = osc(1) * 0.16; p.sq = 1 + osc(2) * 0.08; p.dy = Math.abs(b) * 0.4 * e; break;
        case 'jumpingjack': p.dy = Math.max(0, b) * 1.2 * e; { const j = Math.abs(b); p.armR = j; p.armL = j; } break;
        // A continuous half-turn per beat, so a full spin takes two beats.
        case 'breakdance': p.rot = this.beats * Math.PI; p.dy = 0.4 + Math.abs(b) * 0.6; p.sq = 1 + b2 * 0.1; break;
        case 'wobble': p.rot = osc(0.5) * 0.2; p.dx = osc(0.5) * 0.9; break;
        case 'charleston': p.dx = osc(1) * 0.8; p.rot = -osc(1) * 0.1; p.armR = 0.4 + 0.3 * b; p.armL = 0.4 - 0.3 * b; break;
        case 'vogue': p.armR = 0.6 + 0.4 * b; p.armL = 0.9; p.rot = 0.1 * b; break;
        case 'skank': p.dy = Math.abs(b) * 0.9 * e; p.armR = 0.6 * Math.abs(b); p.armL = 0.6 * Math.abs(b2); p.dx = b * 0.5; break;
        case 'crumporch': p.dx = osc(2) * 0.9; p.armR = Math.abs(b); p.armL = Math.abs(b2); p.rot = osc(1.5) * 0.14; p.dy = Math.abs(b) * 0.7 * e; break;
        case 'spin': break; // spin handled via facing flip
        default: break;     // bob
      }

      /*
        The coil before a known drop. Applied over whatever move is running
        rather than as a move of its own, because it is a state the dancer is
        in, not a step — and the release is already handled: `jump` fires on the
        drop, uncoiling everything at once.

        This is the only motion in the app driven by something that has not
        happened yet.
      */
      const antic = env.anticipation || 0;
      if (antic > 0.02) {
        p.dy += antic * 1.5;              // sink toward the floor
        p.sq *= 1 - antic * 0.16;         // and compress
        p.armL *= 1 - antic * 0.7;        // arms drop as the body gathers
        p.armR *= 1 - antic * 0.7;
      }
      return p;
    }

    /**
     * Draw the actor at its roamed X/Y anywhere on screen.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w @param {number} h viewport size (px)
     * @param {number} unit pixel-cell size (px)
     * @param {number} now
     * @param {{intensity:number,pulse:number,drop:number,buildup:number}} env
     */
    draw(ctx, w, h, unit, now, env) {
      const sm = this.spawnMod(now);              // entrance/teleport draw modifiers
      if (sm.alpha <= 0.001) return;              // still hidden (waiting out its stagger)

      // Drop clones fade out over their final ~500ms of ttl.
      const fade = this.ttl > 0 && this.ttl < 500 ? Math.max(0, this.ttl / 500) : 1;

      const t = now / 1000 + this.phase;
      const pose = this.pose(t, env);

      // Depth scale (subtle in the narrow band) × entrance scale. Per-actor
      // `scale` adds size variety.
      const depth = 0.72 + this.y * 0.42;
      const su = unit * this.scale * depth * sm.scale;
      const jumpY = -this.jump * su * 6.5;
      const x = (this.x + sm.ox) * w;             // sm.ox/oy carry the entrance travel
      const feetY = (this.y + sm.oy) * h;
      const spriteH = GRID_H * su;
      const spriteW = GRID_W * su;

      // Teleport flash: an accent ring + vertical beam pings as the body forms.
      if (sm.flash > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = sm.flash * 0.8;
        ctx.strokeStyle = this.look.accent;
        ctx.lineWidth = 2 + sm.flash * 3;
        ctx.beginPath();
        ctx.arc(x, feetY - spriteH * 0.5, spriteW * (0.4 + (1 - sm.flash) * 0.9), 0, Math.PI * 2);
        ctx.stroke();
        const bw = spriteW * 0.5 * sm.flash;
        const grad = ctx.createLinearGradient(x, feetY - spriteH * 1.4, x, feetY);
        grad.addColorStop(0, hexAlpha(this.look.accent, 0));
        grad.addColorStop(0.5, hexAlpha(this.look.accent, sm.flash * 0.5));
        grad.addColorStop(1, hexAlpha(this.look.accent, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(x - bw / 2, feetY - spriteH * 1.4, bw, spriteH * 1.4);
        ctx.restore();
      }

      ctx.save();

      // Ground shadow, tightening on jumps; fades in with the entrance. One
      // blit of a cached radial sprite, which is both cheaper than building and
      // filling a path every frame and softer than the hard ellipse it replaces.
      ctx.globalAlpha = 0.26 * (1 - this.jump * 0.5) * depth * sm.alpha * fade;
      const shW = spriteW * 1.10 * (1 - this.jump * 0.4);
      const shH = su * 3.2;
      ctx.drawImage(groundShadow(), x - shW / 2, feetY - shH / 2, shW, shH);

      // Move to feet, apply pose; body + arms inherit the entrance alpha.
      ctx.globalAlpha = sm.alpha * fade;
      ctx.translate(x + pose.dx * su, feetY + pose.dy * su + jumpY);
      ctx.rotate(pose.rot);
      ctx.scale(this.facingCur, pose.sq);

      const left = -spriteW / 2;
      const top = -spriteH;

      /*
        Drop glow. This was `ctx.shadowBlur = 18 * env.drop` on the body blit —
        a real-time Gaussian blur, the most expensive operation the 2D context
        offers, applied to every dancer on every drop. That is precisely the
        frame that is already doing the most work: confetti, ripples, clones and
        a hue jump all land together.

        A cached radial sprite behind the body reads the same at these sizes and
        costs one blit.
      */
      if (env.drop > 0.05) {
        const gr = spriteW * (1.5 + env.drop * 0.7);
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * Math.min(1, env.drop);
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(this.look.accent),
          -gr / 2, top + spriteH / 2 - gr / 2, gr, gr);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = prevAlpha;
      }
      const reveal = sm.reveal;                   // < 1 during a pixel-materialize
      if (reveal < 1) {
        // Transient spawn reveal: per-cell materialize (slow path, spawn only).
        for (let r = 0; r < GRID_H; r += 1) {
          const row = GRID[r];
          for (let c = 0; c < GRID_W; c += 1) {
            const col = colorFor(row[c], this.look);
            if (!col) continue;
            if (cellNoise(r, c) > reveal) continue;
            ctx.fillStyle = col;
            ctx.fillRect(left + c * su, top + r * su, su + 0.5, su + 0.5);
          }
        }
      } else {
        // Steady state: one blit of the pre-rendered body (was ~150 fillRects).
        ctx.imageSmoothingEnabled = false;        // keep the pixels crisp when scaled
        ctx.drawImage(bodyCanvas(this.look), left, top, spriteW, spriteH);
      }

      // Animated arms (drawn over the body; flip with facing automatically).
      this.drawArm(ctx, left + spriteW * 0.80, top + spriteH * 0.52, pose.armR, su);
      this.drawArm(ctx, left + spriteW * 0.20 - su * 1.4, top + spriteH * 0.52, pose.armL, su);

      ctx.restore();

      /*
        Name plate above the head, blitted from a cached bitmap.

        It used to assign a font, run `measureText` — which forces a text-shaping
        pass — and then fill a rect and the text, once per dancer per frame, for
        a label that never changes. The font size is rounded to whole pixels and
        the roaming band is narrow, so a troupe uses two or three distinct plate
        sizes for a whole session.
      */
      if (this.name) {
        const fontPx = Math.max(9, Math.round(su * 1.5));
        const plate = namePlate(this.name, fontPx, this.look.accent);
        const ny = feetY + pose.dy * su + jumpY - spriteH - su * 1.6;
        ctx.globalAlpha = 0.9 * sm.alpha;
        ctx.drawImage(plate, Math.round(x - plate.width / 2), Math.round(ny - plate.height / 2));
        ctx.globalAlpha = 1;
      }
    }

    /** Draw one raised forearm+fist when `raise` > 0. `su` is the depth-scaled cell. */
    drawArm(ctx, ax, ay, raise, su) {
      if (raise <= 0.05) return;
      const lift = raise * su * 3.4;
      ctx.fillStyle = this.look.hoodie;
      ctx.fillRect(ax, ay - lift, su * 1.4, lift + su * 1.2);
      ctx.fillStyle = this.look.skin;
      ctx.fillRect(ax - su * 0.1, ay - lift - su, su * 1.6, su * 1.4);
      if (raise > 0.7) {
        ctx.fillStyle = this.look.accent;
        ctx.fillRect(ax + su * 0.3, ay - lift - su * 1.6, su * 0.8, su * 0.8);
      }
    }
  }

  /* ------------------------------------------------------------------ public */

  window.ArtistSprites = {
    SpriteActor,
    splitArtists,
    setBand,
    /**
     * Recolour procedurally-generated dancers from the album-art palette, so an
     * unknown artist auto-themes to the current cover. Branded registry looks
     * (Seedhe Maut, DIVINE, …) are left untouched. Mutating the look colours makes
     * the next draw build/reuse a cache entry for the new palette automatically.
     * @param {SpriteActor[]} actors dancers to recolour in place
     * @param {string[]} colors 2+ #rrggbb colours sampled from the artwork (vibrant→muted)
     */
    recolorFromArt(actors, colors) {
      if (!Array.isArray(actors) || !Array.isArray(colors) || colors.length < 2) return;
      const accent = colors[0];
      const hoodie = colors[1] || colors[0];
      for (const a of actors) {
        const look = a && a.look;
        if (!look || !look.procedural) continue; // keep branded looks intact
        look.accent = accent;
        look.hoodie = hoodie;
        look.hoodieDark = shade(hoodie, 0.68);
        look.cap = shade(hoodie, 0.82);
        look.brim = shade(hoodie, 0.55);
        look.pants = shade(hoodie, 0.45);
      }
    },
    /**
     * Build one dancer per collaborator on the track.
     * @param {string} artistString raw artist field
     * @returns {{label:string, actors:SpriteActor[]}}
     */
    actorsFor(artistString) {
      const tokens = splitArtists(artistString);
      /** @type {object[]} */
      const looks = [];
      const labels = [];
      for (const token of tokens) {
        const known = lookupRegistry(token);
        if (known) {
          labels.push(known.label);
          for (const m of known.members) looks.push(m);
        } else {
          labels.push(token);
          looks.push(proceduralLook(token, hashOf(token)));
        }
        if (looks.length >= MAX_ACTORS) break;
      }
      // Fallback: nothing parsed → a single anonymous dancer so the stage isn't empty.
      if (looks.length === 0) looks.push(proceduralLook(artistString || 'artist', hashOf(artistString || 'artist')));

      const total = looks.length;
      const actors = looks.slice(0, MAX_ACTORS).map((look, i) => new SpriteActor(look, i, total));
      return { label: labels.join(' · '), actors };
    },
  };
})();
