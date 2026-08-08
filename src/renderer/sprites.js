'use strict';

/*
  Pixel-art artist sprites — "Pokémon-style" chibi characters that dance to the
  music in the bottom band of the overlay.

  Design:
  - A sprite is a grid of single-char cells; each char maps to a *role*
    (skin / hoodie / cap / accent …), not a fixed colour. Recolouring a role
    yields a new artist look from the same body, so one authored body covers
    everyone. Roles are resolved to hex per artist by `ArtistRegistry`.
  - Known groups (e.g. Seedhe Maut) resolve to *multiple* actors (a duo shows
    two dancers). Unknown artists get a deterministic look seeded from a hash of
    their name, so the same artist always looks the same.
  - `SpriteActor` owns the animation: an idle bob plus a small move state machine
    (sway / pump / spin / point) and a forced jump on drops. Everything is drawn
    with `fillRect` so it stays crisp pixel art at any scale.

  Exposed on `window.ArtistSprites`:
    - actorsFor(artist, seedHash) -> SpriteActor[]   (1 for solo, 2 for a duo)
    - the SpriteActor class (update(now, env) / draw(ctx, x, y, unit))
*/

(function () {
  /* ------------------------------------------------------------- sprite body */

  // Neutral chibi rapper: big head + cap, hoodie torso, chain, short legs.
  // Every row is the same width; `padGrid` normalises defensively anyway.
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

  /**
   * Pad every row to the grid's max width so a mis-authored row can't shift
   * columns. @param {string[]} rows @returns {string[]}
   */
  function padGrid(rows) {
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return rows.map((r) => r.padEnd(w, '.'));
  }

  const GRID = padGrid(BODY);
  const GRID_W = GRID[0].length;
  const GRID_H = GRID.length;

  /* ------------------------------------------------------------ colour roles */

  /**
   * A "look" maps sprite roles to hex colours. `accent` doubles as the chain and
   * the cap logo, so a group's brand colour reads instantly.
   * @typedef {{name:string, skin:string, cap:string, brim:string,
   *   hoodie:string, hoodieDark:string, accent:string, pants:string, shoe:string}} Look
   */

  /** Resolve a role char to a hex colour for a given look. */
  function colorFor(ch, look) {
    switch (ch) {
      case 'o': return '#0b0b12';               // outline
      case 'k': return look.cap;
      case 'b': return look.brim;
      case 's': return look.skin;
      case 'e': return '#0b0b12';               // eyes
      case 'h': return look.hoodie;
      case 'H': return look.hoodieDark;
      case 'c': return look.accent;
      case 'p': return look.pants;
      case 'w': return look.shoe;
      default: return null;                      // '.' transparent
    }
  }

  /* --------------------------------------------------------- artist registry */

  const SKINS = ['#c9895e', '#a56a42', '#e0aa7a', '#8a5a38', '#d79b6b'];

  /**
   * Deterministic look from a name hash, so unknown artists are stable and
   * distinct. Hues are spread across the wheel; hoodie/cap/accent stay legible.
   * @param {string} name @param {number} hash @returns {Look}
   */
  function proceduralLook(name, hash) {
    const h = hash % 360;
    const accentH = (h + 150) % 360;
    return {
      name,
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

  /**
   * Hand-tuned looks for artists worth recognising. `match` is a lowercase
   * substring tested against the reported artist string; `members` yields one
   * actor per look (a duo => two dancers). Extend freely — unknown artists fall
   * back to a procedural look, so this list only needs the ones worth branding.
   */
  const REGISTRY = [
    {
      match: 'seedhe maut',
      label: 'Seedhe Maut',
      members: [
        { // Encore ABJ — warm/gold energy
          name: 'Encore ABJ', skin: '#b9784c', cap: '#1b1b22', brim: '#111117',
          hoodie: '#2a2a34', hoodieDark: '#1c1c24', accent: '#ffcf3f',
          pants: '#15151b', shoe: '#f2f2f2',
        },
        { // Calm — cool/teal energy
          name: 'Calm', skin: '#a06238', cap: '#0f2a2e', brim: '#0a1e21',
          hoodie: '#123b3f', hoodieDark: '#0c2a2d', accent: '#39e6c8',
          pants: '#101418', shoe: '#e8e8e8',
        },
      ],
    },
    {
      match: 'divine',
      label: 'DIVINE',
      members: [{
        name: 'DIVINE', skin: '#a5673d', cap: '#111117', brim: '#0b0b10',
        hoodie: '#20242c', hoodieDark: '#15181e', accent: '#ff4d4d',
        pants: '#14161c', shoe: '#f2f2f2',
      }],
    },
    {
      match: 'krsna',
      label: 'KR$NA',
      members: [{
        name: 'KR$NA', skin: '#c08552', cap: '#101018', brim: '#0a0a12',
        hoodie: '#23252d', hoodieDark: '#16181f', accent: '#c0c0c0',
        pants: '#131319', shoe: '#eaeaea',
      }],
    },
    {
      match: 'prabh deep',
      label: 'Prabh Deep',
      members: [{
        name: 'Prabh Deep', skin: '#b57843', cap: '#241a2e', brim: '#180f20',
        hoodie: '#2e2140', hoodieDark: '#1f1630', accent: '#b487ff',
        pants: '#171320', shoe: '#efefef',
      }],
    },
  ];

  /**
   * Case/spacing-insensitive artist match. Handles "A x B", "A, B", "A & B"
   * collab strings by testing the whole reported artist as a haystack.
   * @param {string} artist @returns {{label:string, looks:Look[]}|null}
   */
  function lookupRegistry(artist) {
    const hay = (artist || '').toLowerCase();
    for (const entry of REGISTRY) {
      if (hay.includes(entry.match)) {
        return { label: entry.label, looks: entry.members };
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- move engine */

  const MOVES = ['bob', 'sway', 'pump', 'spin', 'point'];

  /** One dancing pixel character. */
  class SpriteActor {
    /**
     * @param {Look} look
     * @param {number} phase Per-actor phase offset so a duo isn't in lockstep.
     */
    constructor(look, phase) {
      this.look = look;
      this.phase = phase || 0;
      this.move = 'bob';
      this.moveUntil = 0;
      this.jump = 0;        // 0..1 airborne factor, kicked to 1 on a drop
      this.facing = 1;      // scaleX target for spins
      this.facingCur = 1;
      this.armRaise = 0;    // 0..1, mic/point arm lift
      this.lastDrop = 0;
    }

    /**
     * Advance animation state.
     * @param {number} now performance.now() ms
     * @param {{intensity:number, pulse:number, drop:number, buildup:number}} env
     */
    update(now, env) {
      // Pick a new random move periodically; hype (intensity) shortens the hold
      // and biases toward energetic moves.
      if (now >= this.moveUntil) {
        const energetic = env.intensity > 0.4 || env.buildup > 0.5;
        const pool = energetic ? ['pump', 'spin', 'sway', 'pump'] : MOVES;
        this.move = pool[(Math.random() * pool.length) | 0];
        const hold = energetic ? 700 + Math.random() * 700 : 1200 + Math.random() * 1400;
        this.moveUntil = now + hold;
        if (this.move === 'spin') this.facing *= -1;
      }

      // A rising drop edge forces a jump with arms up.
      if (env.drop > 0.6 && this.lastDrop <= 0.6) {
        this.jump = 1;
        this.armRaise = 1;
      }
      this.lastDrop = env.drop;

      this.jump *= 0.88;
      this.facingCur += (this.facing - this.facingCur) * 0.2;

      const wantArm = this.move === 'point' || this.move === 'pump' ? 1 : 0;
      const armTarget = Math.max(wantArm, env.buildup * 0.8, this.jump);
      this.armRaise += (armTarget - this.armRaise) * 0.15;
    }

    /**
     * Draw the actor. Origin (x, y) is the sprite's *feet* centre.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x feet centre X (px)
     * @param {number} y feet centre Y (px)
     * @param {number} unit pixel size (px per sprite cell)
     * @param {number} now
     * @param {{intensity:number, pulse:number, drop:number, buildup:number}} env
     */
    draw(ctx, x, y, unit, now, env) {
      const t = now / 1000 + this.phase;
      const beat = 0.5 + 0.5 * Math.sin(t * 6.0);          // fast dance bob
      const life = 0.4 + env.intensity * 0.9 + env.pulse * 0.6;

      // Vertical motion: idle bob + jump arc; horizontal sway for the "sway" move.
      const bob = Math.sin(t * 6.0) * unit * (0.25 + life * 0.5);
      const jumpY = -this.jump * unit * 6;
      const sway = this.move === 'sway' ? Math.sin(t * 3.0) * unit * 1.4 : 0;
      const squash = 1 + Math.sin(t * 6.0) * 0.06 * (0.5 + life); // breathe/pump

      const spriteH = GRID_H * unit;
      const spriteW = GRID_W * unit;

      ctx.save();
      // Soft ground shadow that tightens as the actor jumps.
      const shW = spriteW * 0.5 * (1 - this.jump * 0.4);
      ctx.globalAlpha = 0.28 * (1 - this.jump * 0.5);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(x, y, shW, unit * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Move to feet centre, apply sway/jump, spin (scaleX), and squash/stretch.
      ctx.translate(x + sway, y + bob + jumpY);
      ctx.scale(this.facingCur, squash);

      // Draw the body grid (feet at local y=0, so top-left is up-and-left).
      const left = -spriteW / 2;
      const top = -spriteH;
      // Faint accent rim-glow on drops so the character "pops" with the flash.
      if (env.drop > 0.05) {
        ctx.shadowColor = this.look.accent;
        ctx.shadowBlur = 18 * env.drop;
      }
      for (let r = 0; r < GRID_H; r += 1) {
        const row = GRID[r];
        for (let c = 0; c < GRID_W; c += 1) {
          const col = colorFor(row[c], this.look);
          if (!col) continue;
          ctx.fillStyle = col;
          // +0.5 overdraw removes hairline seams between cells when scaled.
          ctx.fillRect(left + c * unit, top + r * unit, unit + 0.5, unit + 0.5);
        }
      }
      ctx.shadowBlur = 0;

      // Animated raised arm (mic / fist-pump / point) drawn over the body.
      if (this.armRaise > 0.05) {
        const ax = left + GRID_W * unit * 0.80;
        const ay = top + GRID_H * unit * 0.52;
        const lift = this.armRaise * unit * 3.2;
        ctx.fillStyle = this.look.hoodie;
        ctx.fillRect(ax, ay - lift, unit * 1.4, lift + unit * 1.2);   // forearm
        ctx.fillStyle = this.look.skin;
        ctx.fillRect(ax - unit * 0.1, ay - lift - unit, unit * 1.6, unit * 1.4); // fist
        // A little accent spark at the fist on strong lifts (mic light / energy).
        if (this.armRaise > 0.7) {
          ctx.fillStyle = this.look.accent;
          ctx.fillRect(ax + unit * 0.3, ay - lift - unit * 1.6, unit * 0.8, unit * 0.8);
        }
      }

      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ public */

  window.ArtistSprites = {
    SpriteActor,
    /**
     * Build the actors for an artist string. Known groups map to their branded
     * duo/solo looks; anyone else gets one deterministic procedural dancer.
     * @param {string} artist
     * @param {number} seedHash stable hash of the artist name
     * @returns {{label:string, actors:SpriteActor[]}}
     */
    actorsFor(artist, seedHash) {
      const known = lookupRegistry(artist);
      const looks = known ? known.looks : [proceduralLook(artist || 'unknown', seedHash >>> 0)];
      const label = known ? known.label : (artist || '');
      const actors = looks.map((look, i) => new SpriteActor(look, i * 1.9));
      return { label, actors };
    },
  };
})();
