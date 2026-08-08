'use strict';

/* Fullscreen transparent lyric player, Apple Music-style.
   - Tight scrolling column: active line centered, others fade with distance
     (no hard cut at the screen edge).
   - Scroll duration ADAPTS to lyric speed: fast lines push up quickly.
   - Word-level focus colour + capitalize.
   - Active line auto-enlarges on intense/fast bars.
   - Vibrant per-track background (whole screen recolours per song) + starfield.

   NOTE: real audio-reactive drops/beats need the WASAPI capture layer (not
   built). "Intensity" here is derived from lyric cadence. */

const els = {
  column: document.getElementById('column'),
  translation: document.getElementById('translation'),
  status: document.getElementById('status'),
  title: document.getElementById('np-title'),
  artist: document.getElementById('np-artist'),
  offset: document.getElementById('hud-offset'),
  progressFill: document.getElementById('hud-progress-fill'),
  scriptBtn: document.getElementById('btn-script'),
  translateBtn: document.getElementById('btn-translate'),
  backdropBtn: document.getElementById('btn-backdrop'),
  spritesBtn: document.getElementById('btn-sprites'),
  canvas: document.getElementById('backdrop'),
};

let cuesLatin = [];
let cuesDevanagari = null;
let cuesEnglish = null;
let cues = [];

let currentTrack = null;
let playbackStatus = 'Stopped';
let durationMs = 0;

let script = 'latin';
let showTranslation = true;
let transliterationAvailable = false;
let translationAvailable = false;

let anchorPositionMs = 0;
let anchorAt = performance.now();

/** DOM line elements, one per cue, and the active one. */
let lineEls = [];
let activeIndex = -1;

/** Layout geometry, recomputed on resize. */
let slotPx = 0;
let targetCenterPx = 0;

const MAX_WORD_SPREAD_MS = 8000;

/** Smoothed lyric energy (0..1); drives font size and star reactivity. */
let intensity = 0;
/** Short-lived kick on each new line, for the star/glow pulse. */
let pulse = 0;
/** Baseline energy from the song's sentiment (0..1) — sets overall motion. */
let baseEnergy = 0.35;
/** Current song mood label, for the status line. */
let currentMood = null;

/* ---- build-up / drop engine (no audio yet — inferred from lyric gaps) ---- */
/** 0..1 ramp while an instrumental gap approaches its next lyric. */
let buildup = 0;
/** 0..1 flash that decays after a drop fires; punches colour through the glass. */
let dropFlash = 0;
/** Momentary hue rotation (deg) applied to the whole wash on a drop. */
let hueShift = 0;

const GAP_DROP_MS = 5000;   // a lyric arriving after this much silence = a "drop"
const BUILDUP_WINDOW = 3500; // ramp starts this long before the drop lands

/* ---------------------------------------------------------- backdrop levels */
/* The overlay is transparent, so a faint wash is invisible over the desktop.
   These levels let the wash go from barely-there to fully opaque; a drop flash
   punches through regardless of level so colour change always reads. */
const BACKDROP_LEVELS = [
  { name: 'ghost', alpha: 0.34 },
  { name: 'tinted', alpha: 0.62 },
  { name: 'vivid', alpha: 0.84 },
  { name: 'solid', alpha: 1.0 },
];
let backdropLevel = 2; // default "vivid" — clearly visible, still lets video peek

/* ------------------------------------------------------------ artist sprites */
/** Dancing pixel actors for the current artist. */
let spriteActors = [];
let spritesEnabled = true;
let artistLabel = '';

/* --------------------------------------------------------------- sync core */

function estimatePosition() {
  if (playbackStatus !== 'Playing') return anchorPositionMs;
  return anchorPositionMs + (performance.now() - anchorAt);
}

function findCueIndex(positionMs) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].timeMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function buildWordTimings(text, startMs, endMs) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const span = Math.max(0, Math.min(endMs - startMs, MAX_WORD_SPREAD_MS));
  const totalWeight = words.reduce((sum, w) => sum + w.length, 0) || words.length;

  let cursor = startMs;
  return words.map((word) => {
    const share = (word.length / totalWeight) * span;
    const timing = { word, startMs: cursor, endMs: cursor + share };
    cursor += share;
    return timing;
  });
}

/** On-screen duration of a line (ms) = gap to the next cue. */
function lineDurationMs(index) {
  const cue = cues[index];
  if (!cue) return 3000;
  const next = cues[index + 1];
  return Math.max(250, (next ? next.timeMs : cue.timeMs + 3000) - cue.timeMs);
}

/**
 * Line energy from cadence: words per second. Fast, wordy bars score high.
 * @param {number} index
 * @returns {number} 0..1
 */
function lineEnergy(index) {
  const cue = cues[index];
  if (!cue) return 0;
  const words = cue.text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const wps = words / (lineDurationMs(index) / 1000);
  return Math.max(0, Math.min(1, wps / 4.5));
}

/**
 * Fire a "drop": a lyric just landed after a long instrumental gap. Punches the
 * background flash, spikes the pulse, rotates the hue, and shakes the stage.
 */
function triggerDrop() {
  dropFlash = 1;
  pulse = 1.6;
  hueShift = (Math.random() < 0.5 ? -1 : 1) * (25 + Math.random() * 35);
  const stage = document.getElementById('stage');
  if (stage) {
    stage.classList.remove('fx-shake');
    void stage.offsetWidth; // restart the shake animation
    stage.classList.add('fx-shake');
  }
}

/* -------------------------------------------------------- column rendering */

/** Rebuild the whole column for the current cue set. */
function buildColumn() {
  els.column.textContent = '';
  lineEls = cues.map((cue) => {
    const el = document.createElement('div');
    el.className = 'ln';
    el.textContent = cue.text || ' ';
    els.column.appendChild(el);
    return el;
  });
  activeIndex = -1;
}

/** Render a cue's words (interpolated per-word timing) into an element. */
function renderWords(el, index) {
  const cue = cues[index];
  const nextCue = cues[index + 1];
  const endMs = nextCue ? nextCue.timeMs : cue.timeMs + 4000;
  const timings = buildWordTimings(cue.text, cue.timeMs, endMs);

  el.textContent = '';
  timings.forEach((timing, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = timing.word;
    span.dataset.start = String(timing.startMs);
    span.dataset.end = String(timing.endMs);
    // Stagger the entrance so words cascade in (wave/pop/glitch styles read it).
    span.style.animationDelay = `${i * 45}ms`;
    el.appendChild(span);
  });
}

/**
 * Advance the active line: scroll the column so it stays centered, fade lines
 * by distance, and adapt the scroll duration to how fast the lyrics move.
 * @param {number} index
 */
function setActive(index) {
  if (index === activeIndex) return;

  const prev = activeIndex;

  // Revert the old active line to plain text.
  if (activeIndex >= 0 && lineEls[activeIndex]) {
    lineEls[activeIndex].textContent = cues[activeIndex].text || ' ';
  }
  activeIndex = index;

  // A lyric arriving after a long instrumental gap is a "drop" — but only when
  // we advanced one line naturally (not on a seek/jump), to avoid false fires.
  if (index >= 0 && index === prev + 1) {
    const prevTime = index > 0 ? cues[index - 1].timeMs : 0;
    if (cues[index].timeMs - prevTime > GAP_DROP_MS) triggerDrop();
  }

  if (index < 0) {
    els.column.style.transform = `translateY(${targetCenterPx}px)`;
    updateTranslation(index);
    return;
  }

  // Intensity → active line scale (auto-enlarge on fast/intense bars), but
  // capped by line length so long lines stay inside the 80% container.
  const energy = lineEnergy(index);
  intensity = intensity * 0.4 + energy * 0.6;
  pulse = 1;
  const chars = (cues[index].text || '').length;
  const fit = Math.max(0.6, Math.min(1, 26 / Math.max(1, chars)));
  const activeScale = Math.min(2.0, (1.35 + intensity * 0.85) * fit);

  // Adaptive scroll duration: fast lyrics push up quickly, slow lyrics glide.
  const dur = Math.max(150, Math.min(460, lineDurationMs(index) * 0.28));
  els.column.style.transitionDuration = `${dur}ms`;

  // Scroll so the active line's center sits at the target Y.
  const shift = targetCenterPx - (index + 0.5) * slotPx;
  els.column.style.transform = `translateY(${shift}px)`;

  // Per-line state. Keep the view confined to the active line plus one clear
  // line above and below (a faint hint at ±2); everything else is hidden.
  lineEls.forEach((el, i) => {
    const d = Math.abs(i - index);
    if (i === index) {
      el.classList.add('is-active');
      el.style.setProperty('--active-scale', activeScale.toFixed(3));
      el.style.opacity = '1';
    } else {
      el.classList.remove('is-active');
      const op = d === 1 ? 0.5 : d === 2 ? 0.14 : 0;
      el.style.opacity = String(op);
    }
  });

  // Vary the text "moment": which per-word entrance animation this line uses.
  // Energetic lines get punchier styles; the set cycles so it never feels samey.
  const animSet = energy > 0.55 ? ['w-pop', 'w-glitch'] : ['w-wave', 'w-blur', 'w-pop'];
  const animCls = animSet[index % animSet.length];
  const line = lineEls[index];
  line.classList.remove('w-wave', 'w-pop', 'w-blur', 'w-glitch');
  void line.offsetWidth; // restart animations even on the same class
  line.classList.add(animCls);

  renderWords(line, index);
  updateTranslation(index);
}

function paintWords(positionMs) {
  if (activeIndex < 0 || !lineEls[activeIndex]) return;
  for (const span of lineEls[activeIndex].querySelectorAll('.word')) {
    const start = Number(span.dataset.start);
    const end = Number(span.dataset.end);
    span.classList.toggle('word--active', positionMs >= start && positionMs < end);
    span.classList.toggle('word--sung', positionMs >= end);
  }
}

function updateTranslation(index) {
  if (!showTranslation || !cuesEnglish || index < 0 || index >= cuesEnglish.length) {
    els.translation.classList.remove('is-visible');
    els.translation.textContent = '';
    return;
  }
  const text = (cuesEnglish[index] && cuesEnglish[index].text) || '';
  els.translation.textContent = text;
  els.translation.classList.toggle('is-visible', Boolean(text.trim()));
}

/* ---------------------------------------------------------------- main loop */

function frame() {
  try {
    const positionMs = estimatePosition();
    if (cues.length > 0) {
      setActive(findCueIndex(positionMs));
      paintWords(positionMs);
    }
    if (durationMs > 0) {
      const pct = Math.max(0, Math.min(100, (positionMs / durationMs) * 100));
      els.progressFill.style.width = `${pct}%`;
    }

    // Build-up ramp: while a long instrumental gap approaches its next lyric,
    // ramp 0→1 over the final BUILDUP_WINDOW ms so the wash swells before a drop.
    let targetBuildup = 0;
    if (cues.length > 0) {
      const nextIdx = activeIndex + 1;
      const gapStart = activeIndex >= 0 ? cues[activeIndex].timeMs : 0;
      if (nextIdx < cues.length && cues[nextIdx].timeMs - gapStart > GAP_DROP_MS) {
        const toNext = cues[nextIdx].timeMs - positionMs;
        if (toNext > 0 && toNext < BUILDUP_WINDOW) targetBuildup = 1 - toNext / BUILDUP_WINDOW;
      }
    }
    buildup += (targetBuildup - buildup) * 0.08;

    intensity *= 0.997;
    pulse *= 0.92;
    dropFlash *= 0.94;
    hueShift *= 0.95;
  } catch (err) {
    console.error('[frame]', err);
  } finally {
    requestAnimationFrame(frame);
  }
}

/* --------------------------------------------------------------- starfield */

const ctx = els.canvas.getContext('2d');
let stars = [];
let glows = [];
let palette = ['#0d0d1a', '#4361ee', '#7209b7', '#4cc9f0'];
let baseTint = '#0d0d1a';
let vignette = null; // cached gradient, rebuilt on resize

function resizeCanvas() {
  // Cap DPR: on 4K / high-DPI displays a 1:1 canvas is enormous and the main
  // cause of lag. 1.25 keeps it crisp enough while cutting pixel count sharply.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  els.canvas.width = Math.floor(window.innerWidth * dpr);
  els.canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = window.innerWidth;
  const h = window.innerHeight;
  vignette = ctx.createRadialGradient(w / 2, h * 0.5, 0, w / 2, h * 0.5, Math.max(w, h) * 0.8);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');

  slotPx = window.innerHeight * 0.11;
  targetCenterPx = window.innerHeight * 0.44;
  document.documentElement.style.setProperty('--slot', `${slotPx}px`);
  seedStars();

  // Re-center after a resize.
  const idx = activeIndex;
  activeIndex = -1;
  if (idx >= 0) setActive(idx);
}

function seedStars() {
  // Fewer stars than before — the previous density was a needless cost.
  const count = Math.min(180, Math.round((window.innerWidth * window.innerHeight) / 12000));
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: Math.random() * 1.4 + 0.3,
    baseAlpha: Math.random() * 0.5 + 0.25,
    twPhase: Math.random() * Math.PI * 2,
    twSpeed: Math.random() * 0.0018 + 0.0006,
    drift: Math.random() * 0.015 + 0.004,
  }));
}

/**
 * Pre-render a soft radial glow into an offscreen canvas once, so the draw loop
 * can `drawImage` it (cheap) instead of building a gradient every frame (costly).
 * @param {string} color hex
 * @returns {HTMLCanvasElement}
 */
function makeGlowSprite(color) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `${color}66`);
  grad.addColorStop(0.5, `${color}22`);
  grad.addColorStop(1, `${color}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** #rrggbb + alpha → rgba() string. */
function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
}

/** Cached accent glow sprite, rebuilt only when the accent colour changes. */
let accentGlowSprite = null;
let accentGlowColor = null;
function accentGlow(color) {
  if (color !== accentGlowColor) {
    accentGlowSprite = makeGlowSprite(color);
    accentGlowColor = color;
  }
  return accentGlowSprite;
}

function seedGlows(colors) {
  glows = colors.map((color, i) => ({
    sprite: makeGlowSprite(color),
    x: Math.random(),
    y: Math.random(),
    r: 0.55 + Math.random() * 0.35,
    // Faster linear drift so the wash is always visibly moving within a song.
    vx: (Math.random() - 0.5) * 0.00035,
    vy: (Math.random() - 0.5) * 0.00035,
    // Independent orbital sway on top of the drift, so it never looks frozen.
    orbR: 0.05 + Math.random() * 0.06,
    orbSpeed: (0.00008 + Math.random() * 0.00012) * (i % 2 ? 1 : -1),
    orbPhase: Math.random() * Math.PI * 2,
    phase: i * 1.7,
  }));
}

let shootTimer = 0;
let shooting = null;

function drawBackdrop(now) {
  try {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ambient = 0.12 + 0.05 * Math.sin(now / 4200);
    // Sentiment energy raises the constant floor of motion, so high-energy songs
    // stay visibly more alive than mellow ones even between lyric lines. Build-up
    // and drop add a temporary surge on top.
    const life = Math.min(1, intensity + ambient + baseEnergy * 0.45 + buildup * 0.5);
    const motion = 1 + baseEnergy * 1.4 + buildup * 1.6 + dropFlash * 1.2;
    const accent = (palette && palette[3]) || '#e94560';

    ctx.clearRect(0, 0, w, h);

    // Per-track wash across the whole screen. Opacity follows the chosen backdrop
    // level (ghost→solid), and swells with build-up/drop so colour change reads
    // even through a transparent overlay.
    const level = BACKDROP_LEVELS[backdropLevel] || BACKDROP_LEVELS[2];
    const washAlpha = Math.min(1, level.alpha + buildup * 0.12 + dropFlash * 0.15);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = washAlpha;
    ctx.fillStyle = baseTint;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    // Depth vignette (cached gradient, rebuilt only on resize).
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
    }

    // Vibrant colour glows — pre-rendered sprites drawn cheaply each frame.
    ctx.globalCompositeOperation = 'lighter';
    const maxDim = Math.max(w, h);
    for (const g of glows) {
      g.x += g.vx * motion;
      g.y += g.vy * motion;
      if (g.x < -0.3 || g.x > 1.3) g.vx *= -1;
      if (g.y < -0.3 || g.y > 1.3) g.vy *= -1;
      const p = 1 + Math.sin(now / 3000 + g.phase) * 0.1 + pulse * 0.3;
      // Drift position plus a continuous orbital sway → always visibly moving.
      const ox = Math.cos(now * g.orbSpeed * motion + g.orbPhase) * g.orbR;
      const oy = Math.sin(now * g.orbSpeed * motion + g.orbPhase) * g.orbR;
      const cx = (g.x + ox) * w;
      const cy = (g.y + oy) * h;
      const radius = g.r * maxDim * p;
      ctx.drawImage(g.sprite, cx - radius, cy - radius, radius * 2, radius * 2);
    }

    // Stars — always drifting/twinkling; intensify with lyric energy.
    const boost = 0.7 + life * 0.9;
    for (const s of stars) {
      s.y -= s.drift * (1 + life * 1.2) * motion;
      if (s.y < -2) {
        s.y = h + 2;
        s.x = Math.random() * w;
      }
      const tw = 0.55 + 0.45 * Math.sin(now * s.twSpeed + s.twPhase);
      const alpha = Math.min(1, s.baseAlpha * tw * boost);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (1 + intensity * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
    }

    // Occasional shooting star; likelier during intense moments.
    shootTimer -= 1;
    if (!shooting && shootTimer <= 0 && Math.random() < 0.003 + intensity * 0.02) {
      shooting = {
        x: Math.random() * w * 0.8,
        y: Math.random() * h * 0.4,
        vx: 6 + Math.random() * 5,
        vy: 2 + Math.random() * 3,
        life: 1,
      };
      shootTimer = 120;
    }
    if (shooting) {
      shooting.x += shooting.vx;
      shooting.y += shooting.vy;
      shooting.life -= 0.02;
      ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, shooting.life)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(shooting.x, shooting.y);
      ctx.lineTo(shooting.x - shooting.vx * 4, shooting.y - shooting.vy * 4);
      ctx.stroke();
      if (shooting.life <= 0) shooting = null;
    }

    // Build-up bloom: an accent glow swells at centre as a drop approaches.
    if (buildup > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = buildup * 0.6;
      const br = maxDim * (0.25 + buildup * 0.55);
      const sprite = accentGlow(accent);
      ctx.drawImage(sprite, w / 2 - br, h * 0.5 - br, br * 2, br * 2);
      ctx.globalAlpha = 1;
    }

    // Drop flash: accent floods the screen, a white core spikes at the peak, and
    // a shockwave ring expands as it decays — visible even through the glass.
    if (dropFlash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.75, dropFlash * 0.75);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, w, h);
      if (dropFlash > 0.6) {
        ctx.globalAlpha = (dropFlash - 0.6) * 1.1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.globalAlpha = 1;
      const rr = (1 - dropFlash) * maxDim * 0.95;
      ctx.strokeStyle = hexA('#ffffff', dropFlash * 0.7);
      ctx.lineWidth = 3 + dropFlash * 7;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.5, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Pixel-art artist dancers along the bottom band. Solo sits bottom-right so
    // it never covers lyrics; a duo flanks bottom-centre.
    ctx.globalCompositeOperation = 'source-over';
    if (spritesEnabled && spriteActors.length > 0 && window.ArtistSprites) {
      const env = { intensity, pulse, drop: dropFlash, buildup };
      const unit = Math.max(2, Math.round(h * 0.010));
      const feetY = h * 0.9;
      const n = spriteActors.length;
      const step = Math.min(w * 0.16, unit * 22);
      spriteActors.forEach((actor, i) => {
        const fx = n === 1 ? w * 0.85 : w / 2 + (i - (n - 1) / 2) * step;
        actor.update(now, env);
        actor.draw(ctx, fx, feetY, unit, now, env);
      });
    }

    ctx.globalCompositeOperation = 'source-over';
  } catch (err) {
    console.error('[backdrop]', err);
  } finally {
    requestAnimationFrame(drawBackdrop);
  }
}

/* ----------------------------------------------------------------- helpers */

function setStatus(text) {
  els.status.textContent = text;
}

function clearColumn() {
  els.column.textContent = '';
  lineEls = [];
  activeIndex = -1;
  els.column.style.transform = `translateY(${targetCenterPx}px)`;
  els.translation.classList.remove('is-visible');
  els.translation.textContent = '';
}

function applyScript() {
  const useDeva = script === 'devanagari' && cuesDevanagari;
  cues = useDeva ? cuesDevanagari : cuesLatin;
  document.body.classList.toggle('lang-devanagari', Boolean(useDeva));
  els.scriptBtn.setAttribute('aria-pressed', String(script === 'devanagari'));
  buildColumn();
}

function refreshButtons() {
  els.scriptBtn.disabled = cuesLatin.length === 0 || (!cuesDevanagari && !transliterationAvailable);
  els.translateBtn.setAttribute('aria-pressed', String(showTranslation && Boolean(cuesEnglish)));
  els.translateBtn.disabled = cuesLatin.length === 0 || (!cuesEnglish && !translationAvailable);
}

/* ------------------------------------------------------------------- wiring */

window.player.onTrack((track) => {
  currentTrack = track;
  durationMs = track.durationMs || 0;
  cuesLatin = [];
  cuesDevanagari = null;
  cuesEnglish = null;
  cues = [];
  clearColumn();
  els.title.textContent = track.title || '';
  els.artist.textContent = track.artist || '';

  // Reset mood/energy; the sentiment analysis (if available) upgrades this soon.
  baseEnergy = typeof track.energy === 'number' ? track.energy : 0.35;
  currentMood = null;
  buildup = 0;
  dropFlash = 0;

  // Resolve dancing pixel actors for this artist (known groups → branded looks,
  // everyone else → a deterministic procedural dancer).
  if (window.ArtistSprites) {
    const artist = track.artist || '';
    let hash = 0;
    for (let i = 0; i < artist.length; i += 1) hash = (hash * 31 + artist.charCodeAt(i)) >>> 0;
    const resolved = window.ArtistSprites.actorsFor(artist, hash);
    spriteActors = resolved.actors;
    artistLabel = resolved.label;
  }

  // Instant hash palette; recolours the whole background for this song.
  if (Array.isArray(track.palette) && track.palette.length >= 4) {
    palette = track.palette;
    baseTint = palette[0];
    seedGlows([palette[1], palette[2], palette[1]]);
    document.documentElement.style.setProperty('--accent', palette[3]);
  }
});

window.player.onTick((state) => {
  playbackStatus = state.status;
  anchorPositionMs = state.positionMs ?? 0;
  anchorAt = performance.now();
  if (state.durationMs) durationMs = state.durationMs;
});

/* Sentiment-driven graphics: recolour + re-pace the visuals to the song's mood. */
window.player.onMood((data) => {
  if (currentTrack && data.track && data.track.title !== currentTrack.title) return;
  if (Array.isArray(data.palette) && data.palette.length >= 4) {
    palette = data.palette;
    baseTint = palette[0];
    seedGlows([palette[1], palette[2], palette[1]]);
    document.documentElement.style.setProperty('--accent', palette[3]);
  }
  if (typeof data.energy === 'number') baseEnergy = data.energy;
  currentMood = data.mood || null;
  if (currentMood) setStatus(currentMood);
});

window.player.onLyrics((payload) => {
  if (currentTrack && payload.track && payload.track.title !== currentTrack.title) return;
  cuesLatin = payload.cues || [];
  cuesDevanagari = payload.cuesDevanagari || null;
  transliterationAvailable = Boolean(payload.transliterationAvailable);
  translationAvailable = Boolean(payload.translationAvailable);

  switch (payload.status) {
    case 'searching': setStatus('finding lyrics…'); break;
    case 'not-found': setStatus('no synced lyrics found'); clearColumn(); break;
    case 'error': setStatus('lyric lookup failed'); clearColumn(); break;
    default: setStatus('');
  }
  applyScript();
  refreshButtons();
});

window.player.onTranslation((payload) => {
  if (currentTrack && payload.track && payload.track.title !== currentTrack.title) return;
  switch (payload.status) {
    case 'translating': setStatus('translating…'); break;
    case 'ok':
      cuesEnglish = payload.cues || null;
      setStatus('');
      updateTranslation(activeIndex);
      break;
    case 'skipped': cuesEnglish = null; break;
    case 'error': setStatus('translation failed'); break;
    default: break;
  }
  refreshButtons();
});

window.player.onIdle(() => {
  currentTrack = null;
  cuesLatin = [];
  cuesDevanagari = null;
  cuesEnglish = null;
  cues = [];
  spriteActors = [];
  buildup = 0;
  dropFlash = 0;
  clearColumn();
  setStatus('nothing playing');
  els.title.textContent = '';
  els.artist.textContent = '';
  els.progressFill.style.width = '0%';
});

window.player.onOffset((data) => {
  const value = data.offsetMs || 0;
  els.offset.textContent = value === 0 ? 'in sync' : `offset ${value > 0 ? '+' : ''}${value}ms`;
});

els.scriptBtn.addEventListener('click', async () => {
  const next = script === 'devanagari' ? 'latin' : 'devanagari';
  if (next === 'devanagari' && !cuesDevanagari) {
    if (!transliterationAvailable) {
      setStatus('set GEMINI_API_KEY or ANTHROPIC_API_KEY for Devanagari');
      return;
    }
    setStatus('transliterating…');
    const result = await window.player.setScript('devanagari');
    if (result && result.status === 'ok' && Array.isArray(result.cues)) {
      cuesDevanagari = result.cues;
      script = 'devanagari';
      applyScript();
      setStatus('');
    } else {
      setStatus(result && result.message ? result.message : 'transliteration failed');
      return;
    }
  } else {
    script = next;
    await window.player.setScript(next);
    applyScript();
    setStatus('');
  }
  refreshButtons();
});

els.translateBtn.addEventListener('click', async () => {
  if (cuesEnglish) {
    showTranslation = !showTranslation;
    await window.player.setShowTranslation(showTranslation);
    updateTranslation(activeIndex);
    refreshButtons();
    return;
  }
  if (!translationAvailable) {
    setStatus('set GEMINI_API_KEY or ANTHROPIC_API_KEY for translation');
    return;
  }
  setStatus('translating…');
  const result = await window.player.requestTranslation();
  if (result && result.status === 'ok' && Array.isArray(result.cues)) {
    cuesEnglish = result.cues;
    showTranslation = true;
    await window.player.setShowTranslation(true);
    updateTranslation(activeIndex);
    setStatus('');
  } else {
    setStatus(result && result.message ? result.message : 'translation failed');
  }
  refreshButtons();
});

/* Backdrop opacity cycle: ghost → tinted → vivid → solid. Persisted locally so
   the choice sticks between sessions (renderer-only, no main-process changes). */
function applyBackdropLabel() {
  const level = BACKDROP_LEVELS[backdropLevel] || BACKDROP_LEVELS[2];
  els.backdropBtn.textContent = `◐ ${level.name}`;
}
els.backdropBtn.addEventListener('click', () => {
  backdropLevel = (backdropLevel + 1) % BACKDROP_LEVELS.length;
  try { localStorage.setItem('backdropLevel', String(backdropLevel)); } catch { /* ignore */ }
  applyBackdropLabel();
});

/* Toggle the pixel-art artist dancers. */
els.spritesBtn.addEventListener('click', () => {
  spritesEnabled = !spritesEnabled;
  els.spritesBtn.setAttribute('aria-pressed', String(spritesEnabled));
  try { localStorage.setItem('spritesEnabled', spritesEnabled ? '1' : '0'); } catch { /* ignore */ }
});

let cursorTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 2500);
});

window.addEventListener('resize', resizeCanvas);

/* Bootstrap. */
try {
  const bl = parseInt(localStorage.getItem('backdropLevel'), 10);
  if (!Number.isNaN(bl) && bl >= 0 && bl < BACKDROP_LEVELS.length) backdropLevel = bl;
  const se = localStorage.getItem('spritesEnabled');
  if (se !== null) spritesEnabled = se === '1';
} catch { /* ignore */ }
applyBackdropLabel();
els.spritesBtn.setAttribute('aria-pressed', String(spritesEnabled));

resizeCanvas();
seedGlows([palette[1], palette[2], palette[1]]);
requestAnimationFrame(drawBackdrop);
requestAnimationFrame(frame);

window.player.getPrefs().then((prefs) => {
  script = prefs.script === 'devanagari' ? 'devanagari' : 'latin';
  showTranslation = prefs.showTranslation !== false;
  applyScript();
});
window.player.getOffset().then((data) => {
  const value = (data && data.offsetMs) || 0;
  els.offset.textContent = value === 0 ? 'in sync' : `offset ${value > 0 ? '+' : ''}${value}ms`;
});
setStatus('waiting for playback…');
