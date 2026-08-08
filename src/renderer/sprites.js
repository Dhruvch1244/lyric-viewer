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

  const SKINS = ['#c9895e', '#a56a42', '#e0aa7a', '#8a5a38', '#d79b6b'];

  /** Deterministic distinct look from a name hash. */
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
      .replace(/\s*\b(feat\.?|ft\.?|featuring|with|prod\.?|vs\.?|x|and)\b\s*/gi, '|')
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

  const MAX_ACTORS = 6; // keep the stage readable even on posse cuts

  /* -------------------------------------------------------------- move engine */

  const MOVES = ['bob', 'sway', 'pump', 'spin', 'point', 'wave', 'headbang', 'dab', 'shuffle', 'moonwalk', 'hop', 'kick'];
  const HYPE_MOVES = ['pump', 'spin', 'shuffle', 'hop', 'wave', 'headbang', 'kick'];

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
      this.dir = index % 2 ? 1 : -1;                // roam direction
      this.speed = 0.00003 + Math.random() * 0.00004;
      this.phase = index * 1.7;
      this.tempo = 5.4 + Math.random() * 1.6;       // personal dance tempo
      this.move = MOVES[(Math.random() * MOVES.length) | 0];
      this.moveUntil = 0;
      this.jump = 0;
      this.facing = 1;
      this.facingCur = 1;
      this.lastDrop = 0;
      this.lastNow = 0;
    }

    /**
     * Advance roaming + move selection.
     * @param {number} now @param {{intensity:number,buildup:number,drop:number}} env
     */
    update(now, env) {
      const dt = this.lastNow ? Math.min(50, now - this.lastNow) : 16;
      this.lastNow = now;

      // Roam across the stage; faster when the track is intense. Bounce at edges.
      const spd = this.speed * (1 + env.intensity * 2.4 + env.buildup) * dt;
      this.x += this.dir * spd;
      if (this.x < 0.05) { this.x = 0.05; this.dir = 1; }
      if (this.x > 0.95) { this.x = 0.95; this.dir = -1; }

      // Pick a new random move periodically; hype shortens holds + biases moves.
      if (now >= this.moveUntil) {
        const hyped = env.intensity > 0.4 || env.buildup > 0.5;
        const pool = hyped ? HYPE_MOVES : MOVES;
        this.move = pool[(Math.random() * pool.length) | 0];
        this.moveUntil = now + (hyped ? 650 + Math.random() * 700 : 1100 + Math.random() * 1500);
        if (this.move === 'spin') this.facing *= -1;
      }

      // Moonwalkers face against their travel; everyone else faces where they go.
      const wantFace = this.move === 'moonwalk' ? -this.dir : this.dir;
      if (this.move !== 'spin') this.facing = wantFace >= 0 ? 1 : -1;

      // Drop => jump with a whipping motion.
      if (env.drop > 0.6 && this.lastDrop <= 0.6) this.jump = 1;
      this.lastDrop = env.drop;
      this.jump *= 0.88;
      this.facingCur += (this.facing - this.facingCur) * 0.25;
    }

    /**
     * Compute the animated pose (in sprite cells) for the current move.
     * @returns {{dx:number,dy:number,rot:number,sq:number,armL:number,armR:number}}
     */
    pose(t, env) {
      const b = Math.sin(t * this.tempo);
      const b2 = Math.sin(t * this.tempo * 2);
      const e = 0.6 + env.intensity * 1.1 + env.pulse * 0.6;
      const p = { dx: 0, dy: b * 0.35 * e, rot: 0, sq: 1 + b2 * 0.05 * e, armL: 0, armR: 0 };
      switch (this.move) {
        case 'sway': p.dx = Math.sin(t * 3) * 1.4; p.rot = Math.sin(t * 3) * 0.08; break;
        case 'pump': p.armR = 0.5 + 0.5 * Math.abs(b); p.armL = 0.3 * Math.abs(b2); p.dy = Math.abs(b) * 0.6 * e; break;
        case 'point': p.armR = 0.9; p.rot = 0.05; break;
        case 'wave': p.armL = 0.5 + 0.5 * b; p.armR = 0.5 - 0.5 * b; break;
        case 'headbang': p.rot = Math.sin(t * this.tempo * 1.6) * 0.28; p.dy = Math.abs(b) * 0.5 * e; break;
        case 'dab': p.armR = 1; p.armL = 0.4; p.rot = -0.22; p.dy = 0.2; break;
        case 'shuffle': p.dx = Math.sin(t * 9) * 0.7; p.dy = Math.abs(Math.sin(t * 9)) * 0.5 * e; break;
        case 'moonwalk': p.armL = 0.4 + 0.3 * b; p.armR = 0.4 - 0.3 * b; p.rot = 0.05 * b; break;
        case 'hop': p.dy = Math.max(0, Math.sin(t * this.tempo)) * 1.4 * e; break;
        case 'kick': p.dx = Math.sin(t * 4) * 0.5; p.rot = Math.sin(t * 4) * 0.12; p.armL = 0.4; break;
        case 'spin': break; // spin handled via facing flip
        default: break;     // bob
      }
      return p;
    }

    /**
     * Draw the actor at its roamed X in the bottom band.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w @param {number} h viewport size (px)
     * @param {number} unit pixel-cell size (px)
     * @param {number} now
     * @param {{intensity:number,pulse:number,drop:number,buildup:number}} env
     */
    draw(ctx, w, h, unit, now, env) {
      const t = now / 1000 + this.phase;
      const pose = this.pose(t, env);
      const jumpY = -this.jump * unit * 6.5;

      const x = this.x * w;
      const feetY = h * 0.9;
      const spriteH = GRID_H * unit;
      const spriteW = GRID_W * unit;

      ctx.save();

      // Ground shadow, tightening on jumps.
      ctx.globalAlpha = 0.26 * (1 - this.jump * 0.5);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(x, feetY, spriteW * 0.45 * (1 - this.jump * 0.4), unit * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Move to feet, apply pose (dx/dy/jump/rotation/facing/squash).
      ctx.translate(x + pose.dx * unit, feetY + pose.dy * unit + jumpY);
      ctx.rotate(pose.rot);
      ctx.scale(this.facingCur, pose.sq);

      const left = -spriteW / 2;
      const top = -spriteH;

      if (env.drop > 0.05) { ctx.shadowColor = this.look.accent; ctx.shadowBlur = 18 * env.drop; }
      for (let r = 0; r < GRID_H; r += 1) {
        const row = GRID[r];
        for (let c = 0; c < GRID_W; c += 1) {
          const col = colorFor(row[c], this.look);
          if (!col) continue;
          ctx.fillStyle = col;
          ctx.fillRect(left + c * unit, top + r * unit, unit + 0.5, unit + 0.5);
        }
      }
      ctx.shadowBlur = 0;

      // Animated arms (drawn over the body; flip with facing automatically).
      this.drawArm(ctx, left + spriteW * 0.80, top + spriteH * 0.52, pose.armR, unit);
      this.drawArm(ctx, left + spriteW * 0.20 - unit * 1.4, top + spriteH * 0.52, pose.armL, unit);

      ctx.restore();

      // Name plate above the head (drawn unscaled so text stays upright/legible).
      if (this.name) {
        const label = this.name;
        const ny = feetY + pose.dy * unit + jumpY - spriteH - unit * 1.6;
        ctx.font = `700 ${Math.max(10, Math.round(unit * 1.5))}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(x - tw / 2 - unit * 0.6, ny - unit, tw + unit * 1.2, unit * 2);
        ctx.fillStyle = this.look.accent;
        ctx.fillText(label, x, ny);
        ctx.globalAlpha = 1;
      }
    }

    /** Draw one raised forearm+fist when `raise` > 0. */
    drawArm(ctx, ax, ay, raise, unit) {
      if (raise <= 0.05) return;
      const lift = raise * unit * 3.4;
      ctx.fillStyle = this.look.hoodie;
      ctx.fillRect(ax, ay - lift, unit * 1.4, lift + unit * 1.2);
      ctx.fillStyle = this.look.skin;
      ctx.fillRect(ax - unit * 0.1, ay - lift - unit, unit * 1.6, unit * 1.4);
      if (raise > 0.7) {
        ctx.fillStyle = this.look.accent;
        ctx.fillRect(ax + unit * 0.3, ay - lift - unit * 1.6, unit * 0.8, unit * 0.8);
      }
    }
  }

  /* ------------------------------------------------------------------ public */

  window.ArtistSprites = {
    SpriteActor,
    splitArtists,
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
