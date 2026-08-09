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
  syncEarlierBtn: document.getElementById('btn-sync-earlier'),
  syncLaterBtn: document.getElementById('btn-sync-later'),
  progressFill: document.getElementById('hud-progress-fill'),
  scriptBtn: document.getElementById('btn-script'),
  translateBtn: document.getElementById('btn-translate'),
  backdropBtn: document.getElementById('btn-backdrop'),
  lyricsBtn: document.getElementById('btn-lyrics'),
  spritesBtn: document.getElementById('btn-sprites'),
  audioBtn: document.getElementById('btn-audio'),
  perfBtn: document.getElementById('btn-perf'),
  keyBtn: document.getElementById('btn-key'),
  presyncBtn: document.getElementById('btn-presync'),
  presync: document.getElementById('presync'),
  presyncInput: document.getElementById('presync-input'),
  presyncRun: document.getElementById('presync-run'),
  presyncStatus: document.getElementById('presync-status'),
  keybox: document.getElementById('keybox'),
  keyInput: document.getElementById('keybox-input'),
  keySave: document.getElementById('keybox-save'),
  keyStatus: document.getElementById('keybox-status'),
  canvas: document.getElementById('backdrop'),
  hero: document.getElementById('np-hero'),
  heroTitle: document.getElementById('np-hero-title'),
  heroArtist: document.getElementById('np-hero-artist'),
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

/** True while in a long instrumental gap — the flickering song-name hero owns
    the centre and the lyric column is dimmed. Driven from the frame loop. */
let instrumentalGap = false;

/** Layout geometry, recomputed on resize. */
let slotPx = 0;
let targetCenterPx = 0;

const MAX_WORD_SPREAD_MS = 8000;

/* 24 per-word entrance animations (see styles.css). One is chosen per line, and
   the per-word stagger mode is randomised too, so words fire "at different
   times" and the look never repeats. Energetic lines draw from the punchy pool. */
const WORD_ANIMS = [
  'w-wave', 'w-pop', 'w-blur', 'w-glitch', 'w-spin', 'w-flip', 'w-fall', 'w-rise',
  'w-zoomout', 'w-slidel', 'w-slider', 'w-squash', 'w-swing', 'w-bounce', 'w-roll',
  'w-fold', 'w-type', 'w-neon', 'w-shake', 'w-tilt', 'w-jelly', 'w-fadescale',
  'w-zoomblur', 'w-skid',
];
const HYPE_WORD_ANIMS = ['w-pop', 'w-glitch', 'w-spin', 'w-bounce', 'w-shake', 'w-skid', 'w-zoomblur', 'w-flip', 'w-jelly'];
/* Gentle, non-translating entrances (fade / scale / flicker only) used for wordy
   lines — they never shift a word vertically, so a long line can't scatter into a
   second row while mid-cascade. */
const GENTLE_WORD_ANIMS = ['w-fadescale', 'w-zoomout', 'w-neon', 'w-pop'];
/* Continuous effects layered onto the active line. `lc-hue` is intentionally
   excluded: it animates `filter`, which would fight the active line's blur-in
   (also driven by `filter`). Only the text-shadow glow remains. */
const LINE_FX = ['lc-glow', 'lc-none', 'lc-none'];
/** 0 sequential · 1 reverse · 2 random · 3 centre-out — set per line. */
let wordDelayMode = 0;
/** Per-line base stagger step (ms), randomised so timing varies line to line. */
let wordDelayStep = 45;

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

/* "Lyrics paused" hero thresholds — how a long instrumental stretch between two
   sung lines hands the centre over to the flickering song-name hero. */
const GAP_HERO_MS = 4000;    // instrumental tail (after singing stops) must exceed this
const GAP_HERO_ENTER = 600;  // wait this long past the estimated sung-end before showing
const GAP_HERO_LEAD = 900;   // pull the hero back out this long before the next line lands

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
/** Transient dancers cloned from the troupe on a drop; fade out via their ttl. */
let spriteClones = [];
let spritesEnabled = true;
let lyricsVisible = true;
let artistLabel = '';

/* --------------------------------------------------------------- album art */
/** Decoded cover-art image + a pre-blurred offscreen copy used as the backdrop. */
let artImage = null;
let artBlurred = null;
let artReady = false;
let artFadeIn = 0; // 0..1 fade-in for a freshly-loaded artwork
/** Vibrant colours sampled from the current cover, used to recolour procedural dancers. */
let artPalette = null;

/* ----------------------------------------------------- audio-reactive state */
/** Whether system-audio capture is active. */
let audioEnabled = false;
/** Last sampled audio envelope (or null when capture is off). */
let audioEnv = null;

/* ---------------------------------------------------------- performance mode */
/* Lite mode trades the heaviest backdrop layers (phyllotaxis galaxy, parametric
   maths curves, constellation web, rotating rays, equalizer) and a lower canvas
   resolution for a much higher, steadier frame rate. Persisted in localStorage.
   The lyric column, wash, glows, stars, and sprites all stay on. */
let liteMode = false;

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
 * True when playback sits in a long instrumental stretch AFTER the active line
 * has (been estimated to have) finished — the "lyrics paused, music playing"
 * state where the flickering song-name hero should take over. The active line's
 * sung length is estimated from its word count (there is no real word-end data),
 * capped at the distance to the next line. The hero appears once that estimated
 * end has passed and steps back out shortly before the next line arrives.
 * @param {number} positionMs
 * @returns {boolean}
 */
function isInstrumentalGap(positionMs) {
  if (cues.length === 0 || activeIndex < 0) return false;
  const line = cues[activeIndex];
  const next = cues[activeIndex + 1];
  const nextStart = next ? next.timeMs : (durationMs > 0 ? durationMs : Infinity);
  const words = (line.text || '').split(/\s+/).filter(Boolean).length;
  const estSung = Math.min(nextStart - line.timeMs, Math.max(1400, words * 360));
  const sungEnd = line.timeMs + estSung;
  if (nextStart - sungEnd < GAP_HERO_MS) return false; // tail too short to bother
  return positionMs > sungEnd + GAP_HERO_ENTER && (nextStart - positionMs) > GAP_HERO_LEAD;
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
  pulse = 2.2;               // harder body punch
  flicker = 1;               // hard strobe burst on the drop
  beatFlash = 1;
  hueShift = (Math.random() < 0.5 ? -1 : 1) * (25 + Math.random() * 35);
  bgHue = (bgHue + 40 + Math.random() * 80) % 360; // big colour jump on the drop
  // Force an energetic scene and fire the celebratory particles.
  scene.rays = true;
  scene.eq = true;
  // Triple concentric shockwave — a fast lead ring plus two staggered followers
  // read as a real detonation instead of a single hoop.
  spawnRipple(1.4);
  setTimeout(() => spawnRipple(1.0), 90);
  setTimeout(() => spawnRipple(0.7), 190);
  spawnConfetti(window.innerWidth, window.innerHeight, shiftHex((palette && palette[3]) || '#e94560', bgHue));
  // Re-appear the whole troupe with mixed entrance animations for a big "moment"
  // (corners fly-in, warp-slide, materialize, spiral, pop, teleport…), and
  // MULTIPLY them: transient clones burst across the screen and dance hard, then
  // fade out — the drop feels like the crowd doubling.
  if (spritesEnabled && spriteActors.length > 0) {
    const now = performance.now();
    for (const actor of spriteActors) actor.triggerSpawn(now, null);
    spawnCloneTroupe(now);
  }
  const stage = document.getElementById('stage');
  if (stage) {
    stage.classList.remove('fx-shake');
    void stage.offsetWidth; // restart the shake animation
    stage.classList.add('fx-shake');
  }
}

/**
 * Multiply the troupe on a drop: spawn short-lived clones of every dancer,
 * scattered across the lower screen, all set "active" so they dance the full
 * hype move set. Each clone fades out via its ttl. Capped so a run of drops
 * can't flood the stage.
 * @param {number} now performance.now()
 */
function spawnCloneTroupe(now) {
  if (!window.ArtistSprites || spriteActors.length === 0) return;
  const perActor = 2 + ((Math.random() * 2) | 0); // 2–3 clones each
  const CAP = 28;
  let made = 0;
  for (const base of spriteActors) {
    for (let k = 0; k < perActor && spriteClones.length < CAP; k += 1) {
      const clone = new window.ArtistSprites.SpriteActor(base.look, made, spriteActors.length * perActor);
      clone.active = true;                         // clones always dance hard
      clone.name = '';                             // no nameplates on clones — keeps it clean
      clone.ttl = 2400 + Math.random() * 2000;     // lifespan (ms)
      clone.x = 0.04 + Math.random() * 0.92;
      clone.y = 0.58 + Math.random() * 0.36;
      clone.scale *= 0.62 + Math.random() * 0.4;
      clone.triggerSpawn(now, null);
      spriteClones.push(clone);
      made += 1;
    }
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
  const n = timings.length;
  timings.forEach((timing, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = timing.word;
    span.dataset.start = String(timing.startMs);
    span.dataset.end = String(timing.endMs);
    // Stagger the entrance so words fire at different times; the mode is picked
    // per line (sequential / reverse / random / centre-out).
    let d;
    switch (wordDelayMode) {
      case 1: d = (n - 1 - i) * wordDelayStep; break;
      case 2: d = Math.random() * n * wordDelayStep; break;
      case 3: d = Math.abs(i - (n - 1) / 2) * wordDelayStep; break;
      default: d = i * wordDelayStep;
    }
    span.style.animationDelay = `${Math.round(d)}ms`;
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

  // Rotate which dancer is "on the mic". We have no per-line artist attribution
  // from the lyric source, so collaborators simply take turns as the line
  // advances — the active one dances, the rest idle along the bottom. The dancer
  // taking over teleports in with a flash.
  if (spriteActors.length > 0) {
    const on = index >= 0 ? index % spriteActors.length : 0;
    const now = performance.now();
    for (let i = 0; i < spriteActors.length; i += 1) {
      const actor = spriteActors[i];
      const takingMic = i === on && !actor.active;
      actor.active = i === on;
      if (takingMic) actor.triggerSpawn(now, 'teleport');
    }
  }

  // A lyric arriving after a long instrumental gap is a "drop" — but only when
  // we advanced one line naturally (not on a seek/jump), to avoid false fires.
  if (index >= 0 && index === prev + 1) {
    const prevTime = index > 0 ? cues[index - 1].timeMs : 0;
    if (cues[index].timeMs - prevTime > GAP_DROP_MS) triggerDrop();
  }

  if (index < 0) {
    els.column.style.transform = `translateY(${targetCenterPx}px)`;
    updateTranslation(index);
    updateHero();
    return;
  }

  // Intensity → active line scale (auto-enlarge on fast/intense bars), but
  // capped by line length so long lines stay inside the 80% container.
  const energy = lineEnergy(index);
  intensity = intensity * 0.4 + energy * 0.6;
  pulse = 1;
  spawnRipple(energy); // an expanding ring pings out on every new line

  // Re-estimate the beat period from this line's cadence so every reactive layer
  // pulses in time with the song. Wordy/fast lines imply a quicker tempo; clamp
  // to a musical range (~80–180 BPM). Realign the clock so a beat lands now.
  const words = (cues[index].text || '').split(/\s+/).filter(Boolean).length;
  const perWord = words > 0 ? lineDurationMs(index) / words : 500;
  beatPeriodMs = Math.max(333, Math.min(750, perWord * 1.6));
  beatClockMs = 0;
  beatFlash = 1;
  // Shrink long lines so they fit the 80% box on ONE row where possible (a lower
  // floor than before — very long lines were still overflowing and colliding with
  // the neighbouring lines). The line wraps cleanly if it still can't fit.
  const chars = (cues[index].text || '').length;
  const fit = Math.max(0.5, Math.min(1, 24 / Math.max(1, chars)));
  // Larger centre line than before, so it towers over its (now much smaller at
  // 0.62, blurred) neighbours — a strong size hierarchy. `fit` is the overflow
  // guard: it divides the scale down for long lines so a bigger base can't push
  // wide lyrics past the 80% box (the earlier overflow/collision regression).
  const activeScale = Math.min(2.5, (1.95 + intensity * 0.6) * fit);

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
      // Clear the inline blur → the CSS `.is-active { filter: blur(0) }` takes
      // over and the line "sharpens in" from its previous neighbour blur.
      el.style.filter = '';
    } else {
      el.classList.remove('is-active');
      const op = d === 1 ? 0.34 : d === 2 ? 0.07 : 0;
      el.style.opacity = String(op);
      // Neighbours keep a soft blur that deepens with distance; the incoming line
      // starts from this same blur before clearing it above.
      el.style.filter = `blur(${d === 1 ? 3.5 : d === 2 ? 6 : 8}px)`;
    }
  });

  updateHero();

  // Vary the text "moment": pick a random per-word entrance (punchier pool when
  // the line is energetic), a random stagger mode + step, and a random
  // continuous line effect — so no two lines animate the same way.
  //
  // Wordy lines use a GENTLE, non-translating entrance and a much tighter
  // cascade: a large per-word stagger on a long line left half the words frozen
  // mid-animation (shifted/scaled), which spread the line into a scattered,
  // overlapping "two-row" mess. Capping the total cascade time keeps every word
  // settling almost together, so the line always reads cleanly.
  const gentle = words > 9;
  const pool = gentle ? GENTLE_WORD_ANIMS : (energy > 0.55 ? HYPE_WORD_ANIMS : WORD_ANIMS);
  const animCls = pool[(Math.random() * pool.length) | 0];
  wordDelayMode = gentle ? 0 : (Math.random() * 4) | 0;
  const maxCascadeMs = gentle ? 150 : 260;
  wordDelayStep = Math.min(28 + Math.random() * 45, maxCascadeMs / Math.max(1, words));
  const line = lineEls[index];
  WORD_ANIMS.forEach((c) => line.classList.remove(c));
  LINE_FX.forEach((c) => line.classList.remove(c));
  void line.offsetWidth; // restart animations even on the same class
  line.classList.add(animCls);
  const lfx = LINE_FX[(Math.random() * LINE_FX.length) | 0];
  if (lfx !== 'lc-none') line.classList.add(lfx);

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

    // "Lyrics paused" hero: during a long instrumental stretch, dim the lyric
    // column (via body.is-instrumental) and let the flickering song-name hero
    // take the centre; it pulls back before the next line lands.
    const gapNow = cues.length > 0 && isInstrumentalGap(positionMs);
    if (gapNow !== instrumentalGap) {
      instrumentalGap = gapNow;
      document.body.classList.toggle('is-instrumental', gapNow);
      updateHero();
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

/* Extra reactive background layers. Everything below scales with the energy
   envelope (intensity/pulse/buildup/drop) and a slowly drifting global hue, so
   the backdrop keeps changing instead of settling. */
let bokeh = [];      // soft floating orbs
let ripples = [];    // expanding rings, one per lyric line + drops
let confetti = [];   // particle burst on drops
let bars = [];       // equalizer bar seeds
let bgHue = 0;       // global hue drift (deg) added to live-coloured layers
let lastBackNow = 0; // for per-frame dt in the backdrop loop
let sceneTimer = 0;  // countdown to the next random scene shuffle
/* Which optional layers are currently on. Reshuffled every few seconds so the
   background composition itself keeps changing. `math` and `web` are the new
   parametric maths layers; kept on most of the time since they're the headline. */
let scene = { aurora: true, bokeh: true, eq: false, rays: false, math: true, web: true };

/* ---- complex-maths visualizers (parametric "moments") ----
   A morphing family of parametric curves — Lissajous, rose (rhodonea), and
   epicycloid/spirograph — whose coefficients drift over time and swell with the
   energy envelope. `mathMorph` slowly interpolates between curve types so the
   figure continuously reshapes. */
let mathMorph = 0;          // 0..N, fractional index into the curve family
let mathRot = 0;            // slow global rotation of the whole figure
const MATH_CURVES = ['lissajous', 'rose', 'spiro'];

/* Constellation "web": nodes on parametric orbits, linked when close — a live
   force-graph look that pulses on the beat. Seeded per-resize. */
let webNodes = [];

/* Golden-angle phyllotaxis galaxy: a slowly rotating spiral of points seeded
   with the sunflower/Fibonacci packing (137.5°). Set on resize. */
let galaxy = [];

/* ---- beat / timing estimator ----
   No audio FFT yet, so we synthesise a musical pulse from lyric cadence: each
   active line sets an expected inter-beat interval and the phase clock advances
   so `beatPhase` sweeps 0→1 every beat. `beatFlash` kicks on each downbeat. */
let beatPeriodMs = 500;     // current estimated beat length
let beatClockMs = 0;        // accumulates dt, wraps every beatPeriodMs
let beatPhase = 0;          // 0..1 within the current beat
let beatFlash = 0;          // decays after each beat, drives pulses/flicker
/* Screen flicker/strobe (0..1). Rises on drops + high energy, and micro-strobes
   on the beat, then decays. Applied as a brief white veil + hue jitter. */
let flicker = 0;
/* Last quantised hue pushed to the lyric CSS var, to skip redundant style sets. */
let lastLyricHue = -999;

/* ---- adaptive quality governor (keeps the frame rate near 60) ----
   An EMA of instantaneous FPS. When frames run long, `quality` eases toward 0.5
   and the heaviest maths layers subsample (draw fewer points/links); when there's
   headroom it eases back to 1.0. This trades detail for smoothness automatically
   so the overlay stays fluid on weaker GPUs. */
let fpsEMA = 60;
let quality = 1;
/** Timestamp of the last *drawn* backdrop frame, for adaptive frame-skipping. */
let lastDrawnAt = 0;

function resizeCanvas() {
  // Cap DPR: on 4K / high-DPI displays a 1:1 canvas is enormous and the main
  // cause of lag. 1.25 keeps it crisp enough while cutting pixel count sharply;
  // Lite mode drops to 1.0 to roughly halve the pixel work on hi-DPI screens.
  const dpr = Math.min(window.devicePixelRatio || 1, liteMode ? 1.0 : 1.25);
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
  seedBokeh();
  seedBars();
  seedWeb();
  seedGalaxy();

  // Re-center after a resize.
  const idx = activeIndex;
  activeIndex = -1;
  if (idx >= 0) setActive(idx);
}

function seedStars() {
  // Fewer stars than before — the previous density was a needless cost. Lite
  // mode thins them further (denser fields cost more fill + arc calls per frame).
  const cap = liteMode ? 90 : 180;
  const div = liteMode ? 22000 : 12000;
  const count = Math.min(cap, Math.round((window.innerWidth * window.innerHeight) / div));
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

/* ------------------------------------------------- colour + layer utilities */

/** HSL (s,l in %) → #rrggbb. */
function hslToHex(h, s, l) {
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

/** Rotate a hex colour's hue by `deg`, preserving saturation/lightness. */
function shiftHex(hex, deg) {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return hslToHex((h + deg) % 360, s * 100, l * 100);
}

/** Seed floating bokeh orbs, scaled to the viewport. */
function seedBokeh() {
  const count = Math.min(liteMode ? 16 : 40, Math.round((window.innerWidth * window.innerHeight) / 60000));
  bokeh = Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.01 + Math.random() * 0.03,
    spd: 0.0005 + Math.random() * 0.001,
    drift: (Math.random() - 0.5) * 0.0006,
    hue: Math.random() * 60 - 30,
    a: 0.05 + Math.random() * 0.12,
  }));
}

/** Seed equalizer bar phases across the bottom. */
function seedBars() {
  const n = 40;
  bars = Array.from({ length: n }, (_, i) => ({
    f: 0.6 + (i / n) * 3.2,       // pseudo-frequency
    ph: Math.random() * Math.PI * 2,
    j: 0.5 + Math.random() * 0.5, // per-bar jitter weight
  }));
}

/** Seed constellation nodes; each rides its own slow parametric orbit. */
function seedWeb() {
  const count = Math.min(28, Math.round((window.innerWidth * window.innerHeight) / 90000) + 12);
  webNodes = Array.from({ length: count }, () => ({
    // Orbit centre + radii + angular speeds → a smooth Lissajous-like wander.
    cx: Math.random(), cy: Math.random(),
    rx: 0.06 + Math.random() * 0.22, ry: 0.06 + Math.random() * 0.22,
    wx: (0.00006 + Math.random() * 0.00016) * (Math.random() < 0.5 ? 1 : -1),
    wy: (0.00006 + Math.random() * 0.00016) * (Math.random() < 0.5 ? 1 : -1),
    ph: Math.random() * Math.PI * 2,
    x: 0, y: 0,
  }));
}

/**
 * Seed a golden-angle phyllotaxis spiral (sunflower packing). Point i sits at
 * angle i·137.507° and radius √i, giving the classic Fibonacci galaxy. Stored in
 * polar form so the draw loop can rotate + scale it cheaply.
 */
function seedGalaxy() {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.5° in radians
  const count = 260;
  galaxy = Array.from({ length: count }, (_, i) => ({
    ang: i * GOLDEN,
    rad: Math.sqrt(i / count),      // normalised 0..1
    tw: Math.random() * Math.PI * 2, // twinkle phase
    hue: (i / count) * 90 - 45,
  }));
}

/** Spawn an expanding ring from screen centre. */
function spawnRipple(strength) {
  ripples.push({
    r: 0,
    a: Math.min(0.75, 0.25 + strength * 0.5),
    v: 6 + strength * 12,
    lw: 2 + strength * 4, // thicker rings for stronger hits
  });
  if (ripples.length > 12) ripples.shift();
}

/** Burst confetti from centre-top on a drop. */
function spawnConfetti(w, h, accent) {
  const n = liteMode ? 60 : 120; // denser burst for a bigger drop (trimmed in Lite)
  for (let i = 0; i < n; i += 1) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
    const sp = 7 + Math.random() * 16; // wider spread + faster launch
    const streamer = Math.random() < 0.3; // some long ribbons among the squares
    confetti.push({
      x: w / 2, y: h * 0.42,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      s: 3 + Math.random() * 6, life: 1,
      streamer,
      col: Math.random() < 0.5 ? accent : shiftHex(accent, 40 + Math.random() * 280),
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
    });
  }
  if (confetti.length > 500) confetti.splice(0, confetti.length - 500);
}

/* Wavy horizontal aurora bands, hue-shifted live so the wash keeps changing. */
function drawAurora(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const bands = 3;
  for (let bi = 0; bi < bands; bi += 1) {
    const baseY = h * (0.3 + bi * 0.22);
    const amp = h * (0.05 + 0.05 * life) * (bi + 1) * 0.5;
    const col = shiftHex(palette[1 + (bi % 2)] || '#4361ee', bgHue + bi * 30);
    ctx.fillStyle = hexA(col, 0.06 + 0.05 * life);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 24) {
      const y = baseY + Math.sin(x / w * Math.PI * 3 + now / 1400 + bi) * amp
        + Math.sin(x / w * Math.PI * 7 - now / 900) * amp * 0.3;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
}

/* Soft drifting orbs. */
function drawBokeh(now, w, h, motion, life) {
  ctx.globalCompositeOperation = 'lighter';
  for (const o of bokeh) {
    const k = 0.6 + motion * 0.4;
    o.y -= o.spd * k;
    o.x += o.drift * k;
    if (o.y < -0.05) { o.y = 1.05; o.x = Math.random(); }
    const col = shiftHex(palette[3] || '#4cc9f0', bgHue + o.hue);
    ctx.fillStyle = hexA(col, o.a * (0.6 + life));
    ctx.beginPath();
    ctx.arc(o.x * w, o.y * h, o.r * Math.max(w, h) * (0.8 + life * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* Bottom equalizer that reacts to the energy envelope (fake spectrum). */
function drawEqualizer(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const n = bars.length;
  const bw = w / n;
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    const v = (0.5 + 0.5 * Math.sin(now / 240 * bar.f + bar.ph)) * bar.j;
    const bh = h * (0.02 + v * (0.05 + life * 0.22));
    const col = shiftHex(palette[3] || '#4cc9f0', bgHue + (i / n) * 120 - 60);
    ctx.fillStyle = hexA(col, 0.12 + life * 0.18);
    ctx.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
  }
}

/* Rotating light rays from centre — reserved for high-energy/drop scenes. */
function drawRays(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const cx = w / 2;
  const cy = h * 0.42;
  const rays = 14;
  const R = Math.max(w, h);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(now / 6000);
  const col = shiftHex(palette[2] || '#7209b7', bgHue);
  for (let i = 0; i < rays; i += 1) {
    ctx.rotate((Math.PI * 2) / rays);
    ctx.fillStyle = hexA(col, 0.04 + life * 0.05);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(R, -R * 0.03);
    ctx.lineTo(R, R * 0.03);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/* ---- complex-maths parametric figure ("moment" centrepiece) ----
   Traces one of three curve families and morphs continuously between them. The
   figure breathes with the energy envelope and spins slowly, so it reads as a
   living mathematical object rather than a static logo. */
function drawMathCurves(now, w, h, life, motion) {
  const cx = w / 2;
  const cy = h * 0.44;
  const R = Math.min(w, h) * (0.16 + life * 0.20 + beatFlash * 0.06);
  // Morph continuously through the curve family; blend the two nearest types.
  const idx = Math.floor(mathMorph) % MATH_CURVES.length;
  const nextIdx = (idx + 1) % MATH_CURVES.length;
  const blend = mathMorph - Math.floor(mathMorph);
  ctx.globalCompositeOperation = 'lighter';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(mathRot);

  // Three concentric passes in accent-shifted hues → a layered, ribboned look.
  for (let pass = 0; pass < 3; pass += 1) {
    const scale = R * (0.55 + pass * 0.28);
    const col = shiftHex(palette[1 + (pass % 3 === 0 ? 2 : pass % 3)] || '#4cc9f0', bgHue + pass * 40);
    ctx.strokeStyle = hexA(col, 0.14 + life * 0.22 + beatFlash * 0.18);
    ctx.lineWidth = 1.4 + life * 1.6 + beatFlash * 1.2;
    ctx.beginPath();
    const STEP = 0.06 / Math.max(0.4, quality); // coarser sampling when GPU-bound
    for (let a = 0; a <= Math.PI * 2 + STEP; a += STEP) {
      const r1 = mathRadius(MATH_CURVES[idx], a, now, pass);
      const r2 = mathRadius(MATH_CURVES[nextIdx], a, now, pass);
      const r = (r1 * (1 - blend) + r2 * blend) * scale;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Polar radius (normalised ~0..1.2) for a given curve family at angle `a`. */
function mathRadius(kind, a, now, pass) {
  const t = now / 1000;
  switch (kind) {
    case 'rose': {
      // Rhodonea r = cos(kθ); petal count drifts slowly over time.
      const k = 3 + pass + Math.floor((Math.sin(t * 0.11) + 1) * 2);
      return 0.35 + 0.65 * Math.abs(Math.cos(k * a));
    }
    case 'spiro': {
      // Epicycloid-ish sum of harmonics → a spirograph rosette that wobbles.
      return 0.6 + 0.22 * Math.cos((5 + pass) * a + t * 0.7)
        + 0.14 * Math.sin((8 + pass) * a - t * 0.5);
    }
    case 'lissajous':
    default: {
      // Lissajous rendered radially: two beating frequencies fold the ring.
      return 0.7 + 0.2 * Math.sin((3 + pass) * a + t) * Math.cos((2 + pass) * a - t * 0.6);
    }
  }
}

/* ---- constellation web ----
   Nodes ride smooth parametric orbits; any two within a threshold are linked by
   a line whose opacity falls with distance. The link threshold widens on the
   beat, so the whole graph "inhales" rhythmically — a live force-graph moment. */
function drawConstellation(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const maxDim = Math.max(w, h);
  // Subsample the node set when GPU-bound (the link pass is O(n²)).
  const nUsed = Math.max(10, Math.round(webNodes.length * quality));
  // Advance node positions along their orbits.
  for (let k = 0; k < nUsed; k += 1) {
    const n = webNodes[k];
    n.x = (n.cx + Math.cos(now * n.wx + n.ph) * n.rx) * w;
    n.y = (n.cy + Math.sin(now * n.wy + n.ph) * n.ry) * h;
  }
  const linkDist = maxDim * (0.14 + life * 0.06 + beatFlash * 0.05);
  const linkCol = shiftHex(palette[3] || '#4cc9f0', bgHue);
  ctx.lineWidth = 1;
  for (let i = 0; i < nUsed; i += 1) {
    const a = webNodes[i];
    for (let j = i + 1; j < nUsed; j += 1) {
      const b = webNodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < linkDist) {
        const alpha = (1 - d / linkDist) * (0.16 + life * 0.22 + beatFlash * 0.2);
        ctx.strokeStyle = hexA(linkCol, alpha);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    // Node dot, pulsing on the beat.
    const nr = (1.4 + life * 1.8 + beatFlash * 2.2);
    ctx.fillStyle = hexA(linkCol, 0.5 + beatFlash * 0.4);
    ctx.beginPath();
    ctx.arc(a.x, a.y, nr, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---- phyllotaxis galaxy ----
   The golden-angle spiral of stars, rotated slowly and pulsing on the beat. The
   sunflower packing gives it real mathematical structure while staying organic. */
function drawGalaxy(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const cx = w / 2;
  const cy = h * 0.44;
  const spin = now * 0.00006 + beatFlash * 0.05;
  const spread = Math.min(w, h) * (0.42 + life * 0.10 + beatFlash * 0.04);
  const step = Math.max(1, Math.round(1 / Math.max(0.4, quality))); // thin out when slow
  for (let gi = 0; gi < galaxy.length; gi += step) {
    const p = galaxy[gi];
    const a = p.ang + spin;
    const r = p.rad * spread;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.72; // slight tilt → disc, not flat ring
    const tw = 0.5 + 0.5 * Math.sin(now * 0.002 + p.tw);
    const col = shiftHex(palette[2] || '#7209b7', bgHue + p.hue);
    ctx.fillStyle = hexA(col, (0.10 + life * 0.16) * tw + beatFlash * 0.12);
    const dot = 0.8 + p.rad * 1.6 + beatFlash * 1.2;
    ctx.beginPath();
    ctx.arc(x, y, dot, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* Expanding rings (per lyric line + drops) and confetti (drops). */
function drawRipples(w, h) {
  ctx.globalCompositeOperation = 'lighter';
  const cx = w / 2;
  const cy = h * 0.44;
  for (const rp of ripples) {
    rp.r += rp.v;
    rp.a *= 0.96;
    ctx.strokeStyle = hexA(shiftHex(palette[3] || '#4cc9f0', bgHue), rp.a);
    ctx.lineWidth = rp.lw || 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ripples = ripples.filter((rp) => rp.a > 0.02);
}

function drawConfetti() {
  ctx.globalCompositeOperation = 'source-over';
  for (const c of confetti) {
    c.x += c.vx;
    c.y += c.vy;
    c.vy += 0.35;          // gravity
    c.vx *= 0.99;
    c.life -= 0.012;
    c.rot += c.vr;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.globalAlpha = Math.max(0, c.life);
    ctx.fillStyle = c.col;
    if (c.streamer) ctx.fillRect(-c.s / 4, -c.s * 1.6, c.s * 0.5, c.s * 3.2); // ribbon
    else ctx.fillRect(-c.s / 2, -c.s / 2, c.s, c.s * 0.6);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  confetti = confetti.filter((c) => c.life > 0);
}

let shootTimer = 0;
let shooting = null;

function drawBackdrop(now) {
  try {
    // Adaptive frame-skip: cap the effective redraw rate when GPU-bound — and
    // always in Lite mode — so we draw fewer, cheaper frames instead of
    // stuttering at the display's full refresh rate. rAF still fires every vsync
    // via the finally block; we just return early until enough time has elapsed.
    // The dt-normalised decays below keep motion speed correct at any frame rate.
    const throttleMs = liteMode ? 33 : (fpsEMA < 30 ? 32 : fpsEMA < 45 ? 20 : 0);
    if (throttleMs && lastDrawnAt && (now - lastDrawnAt) < throttleMs) return;
    lastDrawnAt = now;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const ambient = 0.12 + 0.05 * Math.sin(now / 4200);
    // Sentiment energy raises the constant floor of motion, so high-energy songs
    // stay visibly more alive than mellow ones even between lyric lines. Build-up
    // and drop add a temporary surge on top.
    const life = Math.min(1, intensity + ambient + baseEnergy * 0.45 + buildup * 0.5);
    const motion = 1 + baseEnergy * 1.4 + buildup * 1.6 + dropFlash * 1.2;
    const accent = (palette && palette[3]) || '#e94560';

    // Per-frame dt (backdrop loop is independent of the lyric frame loop).
    const rawDt = lastBackNow ? now - lastBackNow : 16;
    const dt = Math.min(60, rawDt);
    lastBackNow = now;

    // Real-audio envelope (null when capture is off). When present it becomes the
    // source of truth for kicks/build-ups/drops below.
    audioEnv = (audioEnabled && window.AudioReactive) ? window.AudioReactive.sample(now) : null;
    const audioActive = Boolean(audioEnv && audioEnv.active);

    // Adaptive quality: track FPS and ease `quality` so heavy layers back off when
    // frames run long, keeping motion near 60fps. Uses the true (unclamped) dt.
    const instFps = 1000 / Math.max(1, rawDt);
    fpsEMA += (instFps - fpsEMA) * 0.05;
    const qTarget = fpsEMA > 55 ? 1 : fpsEMA > 45 ? 0.8 : fpsEMA > 32 ? 0.6 : 0.45;
    quality += (qTarget - quality) * 0.02;

    // Slowly drift the global hue (faster when intense), and jump it on drops —
    // this shifts the whole wash + live layers so the background never settles.
    bgHue = (bgHue + dt * 0.01 * (0.6 + intensity + baseEnergy) + dropFlash * 0.6) % 360;

    // Beat clock: advance the phase, fire a flash + micro-flicker on each downbeat.
    // The period tightens with energy so hyped songs pulse faster. This is the
    // "timing" spine every reactive layer reads from.
    beatClockMs += dt * (0.85 + baseEnergy * 0.6 + intensity * 0.8);
    if (beatClockMs >= beatPeriodMs) {
      beatClockMs -= beatPeriodMs;
      // When real audio is driving the pulse, suppress the synthetic downbeat so
      // the two clocks don't fight — kicks below own the flash instead.
      if (!audioActive) {
        beatFlash = 1;
        flicker = Math.max(flicker, 0.28 + intensity * 0.4); // strobe tick on the beat
        spawnRipple(0.3 + intensity * 0.4);
      }
    }
    beatPhase = beatClockMs / beatPeriodMs;
    beatFlash *= Math.pow(0.9, dt / 16);   // frame-rate-independent decay
    flicker *= Math.pow(0.82, dt / 16);

    // Real audio overrides the synthetic envelope: kicks punch the pulse/flash,
    // build-ups drive the flicker + centre bloom, and a detected drop fires the
    // full drop moment (flash, confetti, hue jump, dancer multiplication).
    if (audioActive) {
      intensity = Math.max(intensity, Math.min(1, audioEnv.level * 1.6));
      if (audioEnv.kick > 0.12) {
        beatFlash = Math.max(beatFlash, audioEnv.kick);
        pulse = Math.max(pulse, 0.5 + audioEnv.kick);
        if (audioEnv.kick > 0.45) spawnRipple(audioEnv.kick);
      }
      buildup = Math.max(buildup, audioEnv.build);
      if (audioEnv.build > 0.3) flicker = Math.max(flicker, audioEnv.build * (0.35 + Math.random() * 0.5));
      if (audioEnv.drop) triggerDrop();
    }

    // Beat map: while capturing live audio, LEARN this song's beats against its
    // playback position; otherwise PLAY BACK a previously learned map so drops,
    // kicks and anticipatory build-ups fire from memory — no capture required.
    if (window.BeatMap) {
      const pos = estimatePosition();
      if (audioActive) {
        window.BeatMap.note(pos, audioEnv);
      } else if (playbackStatus === 'Playing' && window.BeatMap.hasPlayback()) {
        const bm = window.BeatMap.tick(pos);
        if (bm.buildup > buildup) buildup = bm.buildup;
        if (bm.kick > 0.12) {
          beatFlash = Math.max(beatFlash, bm.kick);
          pulse = Math.max(pulse, 0.5 + bm.kick);
          if (bm.kick > 0.45) spawnRipple(bm.kick);
        }
        if (bm.drop) triggerDrop();
      }
    }

    // Morph the maths figure continuously and rotate it; faster when energetic.
    mathMorph += dt * 0.00007 * (1 + intensity * 2 + baseEnergy);
    mathRot += dt * 0.00012 * (0.5 + intensity * 1.5) * (1 + dropFlash);

    // Reshuffle which optional layers are on every few seconds, for variety. The
    // maths layers stay on far more often since they're the headline visual.
    sceneTimer -= dt;
    if (sceneTimer <= 0) {
      scene.aurora = Math.random() < 0.75;
      scene.bokeh = Math.random() < 0.7;
      scene.eq = Math.random() < 0.5;
      scene.rays = Math.random() < 0.35;
      scene.math = Math.random() < 0.85;
      scene.web = Math.random() < 0.8;
      sceneTimer = 5000 + Math.random() * 6000;
    }

    // Lite mode: force the heaviest parametric layers off regardless of the
    // shuffle (galaxy is gated at its call site below).
    if (liteMode) { scene.rays = false; scene.eq = false; scene.math = false; scene.web = false; }
    // With real audio, keep the bottom equalizer up — it reads as a live spectrum.
    if (audioActive && !liteMode) scene.eq = true;

    const accentLive = shiftHex(accent, bgHue);
    const tintLive = shiftHex(baseTint, bgHue * 0.5);

    // Drive the lyric colour from the same live hue so the text recolours through
    // the song, and hand the beat pulse to CSS so the active line throbs in time.
    // Throttled to meaningful changes to avoid needless style recalcs each frame.
    const liveHueQ = Math.round(bgHue / 3) * 3;
    if (liveHueQ !== lastLyricHue) {
      lastLyricHue = liveHueQ;
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty('--accent-live', accentLive);
      rootStyle.setProperty('--accent-live2', shiftHex(accent, bgHue + 60));
    }
    document.documentElement.style.setProperty('--beat', (beatFlash + dropFlash).toFixed(2));

    ctx.clearRect(0, 0, w, h);

    // Per-track wash + album-art levels share the chosen backdrop opacity, so the
    // whole overlay stays as see-through (ghost) or solid as the user picked.
    const level = BACKDROP_LEVELS[backdropLevel] || BACKDROP_LEVELS[2];

    // Album-art backdrop photo (pre-blurred + darkened), painted behind the wash.
    // Fades in over ~0.9s when a new cover arrives; capped by the backdrop level
    // so a "ghost" overlay still lets the desktop show through.
    let artAlpha = 0;
    if (artReady && artBlurred) {
      artFadeIn = Math.min(1, artFadeIn + dt / 900);
      artAlpha = artFadeIn * level.alpha;
      drawArtCover(w, h, artAlpha);
    }

    // Wash opacity follows the level and swells with build-up/drop so colour
    // change reads even through a transparent overlay. When a cover photo is
    // present the wash is thinned so the photo stays visible beneath the colour.
    const washAlpha = Math.min(1, level.alpha * (1 - artAlpha * 0.5) + buildup * 0.12 + dropFlash * 0.15);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = washAlpha;
    ctx.fillStyle = tintLive;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    // Reactive background layers (each self-limits by scene flags + energy).
    if (scene.aurora) drawAurora(now, w, h, life);
    if (scene.bokeh) drawBokeh(now, w, h, motion, life);
    if (scene.rays && (life > 0.4 || dropFlash > 0.1)) drawRays(now, w, h, life);
    if (scene.eq) drawEqualizer(now, w, h, life);
    // Complex-maths layers: the phyllotaxis galaxy sits behind, the parametric
    // figure + constellation web ride on top — all beat-reactive "moments".
    // The 260-point galaxy is the single most expensive always-on layer, so Lite
    // mode drops it entirely.
    if (!liteMode) drawGalaxy(now, w, h, life);
    if (scene.math) drawMathCurves(now, w, h, life, motion);
    if (scene.web) drawConstellation(now, w, h, life);
    // Depth vignette (cached gradient, rebuilt only on resize). Must draw in
    // 'source-over' — the layers above leave the composite op set to 'lighter',
    // under which a black gradient would add nothing.
    ctx.globalCompositeOperation = 'source-over';
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

    // Expanding rings (spawned per lyric line + drops).
    if (ripples.length) drawRipples(w, h);

    // Build-up bloom: an accent glow swells at centre as a drop approaches, with
    // an "anticipation ring" that tightens toward the core (telegraphs the drop)
    // and, at high build, vertical riser streaks that whip upward.
    if (buildup > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.85, buildup * 0.75);
      const br = maxDim * (0.25 + buildup * 0.65);
      const sprite = accentGlow(accentLive);
      const cx = w / 2;
      const cy = h * 0.5;
      ctx.drawImage(sprite, cx - br, cy - br, br * 2, br * 2);

      // Tightening ring: large and faint early, small and bright as build → 1.
      const ringR = maxDim * (0.55 - buildup * 0.42);
      ctx.globalAlpha = buildup * buildup * 0.9;
      ctx.strokeStyle = hexA('#ffffff', 1);
      ctx.lineWidth = 2 + buildup * 5;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4, ringR), 0, Math.PI * 2);
      ctx.stroke();

      // Riser streaks — only near the peak of the build, and not in Lite mode.
      if (!liteMode && buildup > 0.45) {
        const streaks = 10;
        const rise = h * (0.1 + buildup * 0.4);
        ctx.strokeStyle = hexA(accentLive, (buildup - 0.45) * 1.3);
        ctx.lineWidth = 1.5 + buildup * 2;
        for (let i = 0; i < streaks; i += 1) {
          const sx = (i + 0.5) / streaks * w;
          const jitter = Math.sin(now * 0.02 + i) * 8;
          const baseY = h * 0.95;
          ctx.beginPath();
          ctx.moveTo(sx + jitter, baseY);
          ctx.lineTo(sx, baseY - rise * (0.6 + Math.random() * 0.4));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Drop flash: accent floods the screen, a white core spikes at the peak, and
    // a shockwave ring expands as it decays — visible even through the glass.
    if (dropFlash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.75, dropFlash * 0.75);
      ctx.fillStyle = accentLive;
      ctx.fillRect(0, 0, w, h);
      if (dropFlash > 0.6) {
        ctx.globalAlpha = (dropFlash - 0.6) * 1.1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.globalAlpha = 1;
      const cx = w / 2;
      const cy = h * 0.5;
      // Lead white shockwave.
      const rr = (1 - dropFlash) * maxDim * 0.95;
      ctx.strokeStyle = hexA('#ffffff', dropFlash * 0.8);
      ctx.lineWidth = 4 + dropFlash * 10;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      // Lagging accent shockwave, wider and softer, for a layered detonation.
      const rr2 = (1 - dropFlash) * maxDim * 1.25;
      ctx.strokeStyle = hexA(accentLive, dropFlash * 0.55);
      ctx.lineWidth = 2 + dropFlash * 6;
      ctx.beginPath();
      ctx.arc(cx, cy, rr2, 0, Math.PI * 2);
      ctx.stroke();
      // Radial burst spokes fired from centre at the peak (skipped in Lite).
      if (!liteMode && dropFlash > 0.55) {
        const spokes = 12;
        const inner = maxDim * 0.05;
        const outer = maxDim * (0.12 + (1 - dropFlash) * 0.6);
        ctx.strokeStyle = hexA('#ffffff', (dropFlash - 0.55) * 1.4);
        ctx.lineWidth = 2 + dropFlash * 3;
        for (let i = 0; i < spokes; i += 1) {
          const a = (i / spokes) * Math.PI * 2 + bgHue * 0.01;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
          ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
          ctx.stroke();
        }
      }
    }

    // Screen flicker / strobe: on the beat and during hype the whole frame gets
    // a brief additive veil. A per-frame random keeps it a genuine flicker rather
    // than a smooth fade, punching the "moment" hard on drops.
    if (flicker > 0.02) {
      const strobe = flicker * (0.5 + Math.random() * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, strobe * 0.5);
      ctx.fillStyle = Math.random() < 0.5 ? '#ffffff' : accentLive;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // Pixel-art artist dancers roaming the whole screen (they steer around the
    // central lyric zone); each names + positions itself and reacts to the same
    // energy envelope as the backdrop.
    ctx.globalCompositeOperation = 'source-over';
    if (spritesEnabled && window.ArtistSprites && (spriteActors.length > 0 || spriteClones.length > 0)) {
      const env = { intensity, pulse, drop: dropFlash, buildup };
      // Kept small so even the tallest dancer's head stays clear of the centred
      // lyric; dancers now roam a taller band + full width (see sprites.js).
      const unit = Math.max(3, Math.round(h * 0.010));
      for (const actor of spriteActors) {
        actor.update(now, env);
        actor.draw(ctx, w, h, unit, now, env);
      }
      // Transient drop clones: dance hard, then fade out and retire via their ttl.
      if (spriteClones.length > 0) {
        for (const c of spriteClones) {
          c.update(now, env);
          c.draw(ctx, w, h, unit, now, env);
        }
        spriteClones = spriteClones.filter((c) => !c.expired);
      }
    }

    // Confetti burst (drops) rendered last so it sits in front of the dancers.
    if (confetti.length) drawConfetti();

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

/**
 * Fold featured artists credited in the TITLE into the artist string, so every
 * guest gets a dancer even when SMTC only reports the primary artist. Matches the
 * common "(feat. X)" / "ft." / "with X" credit shapes.
 * @param {string} artist primary artist string from SMTC
 * @param {string} title track title, which may credit guests
 * @returns {string} combined artist string for ArtistSprites.actorsFor
 */
function enrichArtist(artist, title) {
  // Only the explicit "feat./ft./featuring" credit — NOT "with", which produces
  // false guests from ordinary titles like "With You".
  const m = title.match(/[([]?\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]?/i);
  if (!m) return artist;
  const guests = m[1].trim().replace(/\s*[-–—].*$/, ''); // drop trailing "- Remix" etc.
  if (!guests) return artist;
  return artist ? `${artist} feat. ${guests}` : guests;
}

/**
 * Merge a richer artist credit (from the lyrics source or iTunes) with the SMTC
 * primary artist and rebuild the dancer troupe — but only when it yields MORE
 * dancers, so a single-artist credit never churns an already-good lineup. This
 * is how collaborators SMTC omits (e.g. a 3-artist single reported as one name)
 * get their own on-screen dancer.
 * @param {string} artistName richer credit string
 */
function maybeEnrichArtists(artistName) {
  if (!artistName || !currentTrack || !window.ArtistSprites) return;
  const merged = [currentTrack.artist || '', artistName].filter(Boolean).join(', ');
  const resolved = window.ArtistSprites.actorsFor(enrichArtist(merged, currentTrack.title || ''));
  if (resolved.actors.length > spriteActors.length) {
    spriteActors = resolved.actors;
    artistLabel = resolved.label;
    applyArtPalette(); // theme the freshly-added dancers to the current cover too
  }
}

/**
 * Show a big glowing title + artist when no lyric line is active — an
 * instrumental track, a track with no synced lyrics, or the intro before the
 * first line. Hidden the moment a lyric line takes focus.
 */
function updateHero() {
  const noActiveLine = cues.length === 0 || activeIndex < 0 || instrumentalGap;
  const show = Boolean(currentTrack) && noActiveLine;
  if (show) {
    els.heroTitle.textContent = currentTrack.title || '';
    els.heroArtist.textContent = artistLabel || currentTrack.artist || '';
  }
  els.hero.classList.toggle('is-visible', show);
}

/**
 * Decode a data-URI album cover and pre-render a blurred copy for the backdrop.
 * @param {string} dataUri
 */
function loadArtImage(dataUri) {
  const img = new Image();
  img.onload = () => {
    artImage = img;
    buildBlurredArt();
    artReady = Boolean(artBlurred);
    artFadeIn = 0;
    // Derive a palette from the cover and theme the procedural dancers to it.
    artPalette = extractArtPalette(img);
    applyArtPalette();
  };
  img.onerror = () => { /* keep the previous backdrop */ };
  img.src = dataUri;
}

/**
 * Sample a downscaled copy of the cover for its most prominent vibrant colours.
 * Runs once per cover; the result recolours procedural (non-branded) dancers.
 * @param {HTMLImageElement} img decoded cover image
 * @returns {string[]|null} 2–4 #rrggbb colours (most prominent first), or null
 */
function extractArtPalette(img) {
  const N = 40; // sampling resolution — small is plenty for dominant colours
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  let data;
  try {
    g.drawImage(img, 0, 0, N, N);
    data = g.getImageData(0, 0, N, N).data;
  } catch {
    return null; // tainted canvas (shouldn't happen with data: URIs) — bail
  }

  // Bucket colours into a coarse 3-bit-per-channel grid, weighting each bucket by
  // frequency × saturation so vivid colours beat large flat dark/washed areas.
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const gg = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128) continue;               // skip transparent
    const max = Math.max(r, gg, b);
    const min = Math.min(r, gg, b);
    const lum = (r + gg + b) / 3;
    if (lum < 28 || lum > 238) continue;           // skip near-black / near-white
    const sat = max === 0 ? 0 : (max - min) / max;
    const key = ((r >> 5) << 6) | ((gg >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0 };
    e.r += r; e.g += gg; e.b += b; e.n += 1; e.sat += sat;
    buckets.set(key, e);
  }
  if (buckets.size === 0) return null;

  const ranked = [...buckets.values()]
    .map((e) => ({
      r: Math.round(e.r / e.n),
      g: Math.round(e.g / e.n),
      b: Math.round(e.b / e.n),
      score: e.n * (0.35 + e.sat / e.n), // frequency, boosted by average saturation
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((e) => `#${((1 << 24) | (e.r << 16) | (e.g << 8) | e.b).toString(16).slice(1)}`);

  return ranked.length >= 2 ? ranked : null;
}

/** Re-apply the cached art palette to the current dancers (troupe + clones). */
function applyArtPalette() {
  if (!artPalette || !window.ArtistSprites || !window.ArtistSprites.recolorFromArt) return;
  window.ArtistSprites.recolorFromArt(spriteActors, artPalette);
  window.ArtistSprites.recolorFromArt(spriteClones, artPalette);
}

/** Bake a heavy blur + darken into a small offscreen canvas once (cheap redraw). */
function buildBlurredArt() {
  if (!artImage) return;
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return;
  g.filter = 'blur(24px) brightness(0.62) saturate(1.25)';
  // Overscan slightly so the blur doesn't reveal transparent edges.
  g.drawImage(artImage, -size * 0.08, -size * 0.08, size * 1.16, size * 1.16);
  g.filter = 'none';
  artBlurred = c;
}

/**
 * Paint the pre-blurred album art as a full-screen cover behind the wash.
 * @param {number} w @param {number} h viewport px @param {number} alpha 0..1
 */
function drawArtCover(w, h, alpha) {
  if (!artBlurred) return;
  const s = Math.max(w, h);
  const dx = (w - s) / 2;
  const dy = (h - s) / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;
  ctx.drawImage(artBlurred, dx, dy, s, s);
  // Extra darken so the centred lyric stays legible over bright covers.
  ctx.globalAlpha = alpha * 0.42;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.globalAlpha = 1;
}

/**
 * Start (or restart) system-audio capture for the reactive engine.
 * @returns {Promise<boolean>} whether capture is active
 */
async function enableAudio() {
  const ok = window.AudioReactive ? await window.AudioReactive.start() : false;
  audioEnabled = ok;
  els.audioBtn.setAttribute('aria-pressed', String(ok));
  try { localStorage.setItem('audioEnabled', ok ? '1' : '0'); } catch { /* ignore */ }
  return ok;
}

/* ------------------------------------------------------------------- wiring */

/**
 * Save the beat map learned for the CURRENT track (called before switching away,
 * on idle, and on window close). Only persists if live audio actually captured
 * enough events this play; otherwise any previously stored map is left untouched.
 */
function flushBeatmap() {
  if (!currentTrack || !window.BeatMap) return;
  const beatmap = window.BeatMap.takeRecording();
  if (!beatmap) return;
  window.player.saveBeatmap({
    track: {
      title: currentTrack.title,
      artist: currentTrack.artist,
      durationMs: currentTrack.durationMs || durationMs,
    },
    beatmap,
  });
}

window.player.onTrack((track) => {
  flushBeatmap();                 // persist what we learned for the previous song
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

  // Resolve one dancing pixel actor per collaborator on the track (known groups
  // → branded looks/duos, everyone else → a deterministic procedural dancer).
  // SMTC usually reports only the primary artist, so we also mine the TITLE for
  // "(feat. X)" / "ft." credits and fold them in — that's how most collab tracks
  // expose their guests — giving more than one dancer when there really are more.
  if (window.ArtistSprites) {
    const resolved = window.ArtistSprites.actorsFor(enrichArtist(track.artist || '', track.title || ''));
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

  // New song → drop the old backdrop photo + any leftover clones, and show the
  // glowing hero until lyrics (if any) start.
  artReady = false;
  artImage = null;
  artBlurred = null;
  artPalette = null;
  spriteClones = [];

  // Begin learning this song's beats afresh; the stored map (if any) arrives via
  // the `beatmap` event that main sends right after this one.
  if (window.BeatMap) {
    window.BeatMap.load(null);
    window.BeatMap.startRecording();
  }
  updateHero();
});

/* A learned beat map for the current song (null on first listen). Played back when
   live audio capture is off, so drops/kicks fire — and anticipate — from memory. */
window.player.onBeatmap((data) => {
  if (!window.BeatMap) return;
  if (currentTrack && data.track && data.track.title !== currentTrack.title) return;
  window.BeatMap.load(data.beatmap || null);
});

/* Cover art + richer artist credit fetched in the main process. */
window.player.onArtwork((data) => {
  if (currentTrack && data.track && data.track.title !== currentTrack.title) return;
  if (data.artwork) loadArtImage(data.artwork);
  maybeEnrichArtists(data.artistName);
  updateHero();
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

  // LRCLIB often reports the full artist credit even when SMTC gave just the
  // primary — fold any extra collaborators in so each gets a dancer.
  if (payload.source && payload.source.artistName) maybeEnrichArtists(payload.source.artistName);

  switch (payload.status) {
    case 'searching': setStatus('finding lyrics…'); break;
    case 'not-found': setStatus('no synced lyrics found'); clearColumn(); break;
    case 'error': setStatus('lyric lookup failed'); clearColumn(); break;
    default: setStatus('');
  }
  applyScript();
  refreshButtons();
  updateHero();
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
  flushBeatmap();                 // persist the last song's learned beats
  if (window.BeatMap) window.BeatMap.load(null);
  currentTrack = null;
  cuesLatin = [];
  cuesDevanagari = null;
  cuesEnglish = null;
  cues = [];
  spriteActors = [];
  spriteClones = [];
  artReady = false;
  artImage = null;
  artBlurred = null;
  buildup = 0;
  dropFlash = 0;
  clearColumn();
  setStatus('nothing playing');
  els.title.textContent = '';
  els.artist.textContent = '';
  els.progressFill.style.width = '0%';
  updateHero();
});

/** Current lyric-sync offset for this track (ms); mirrored from the main store. */
let currentOffsetMs = 0;
const OFFSET_STEP_MS = 100;

/** Update the offset chip label and the local mirror. */
function applyOffsetLabel(value) {
  currentOffsetMs = value || 0;
  els.offset.textContent = currentOffsetMs === 0
    ? 'in sync'
    : `offset ${currentOffsetMs > 0 ? '+' : ''}${currentOffsetMs}ms`;
}

/** Set an absolute offset via main and reflect the value it returns. */
async function setSyncOffset(valueMs) {
  try {
    const result = await window.player.setOffset(valueMs);
    applyOffsetLabel(typeof result === 'number' ? result : valueMs);
  } catch { /* leave the label as-is on failure */ }
}

window.player.onOffset((data) => {
  applyOffsetLabel(data.offsetMs || 0);
});

// On-screen timing nudge: shift the current song's lyrics earlier / later, or
// click the offset chip to snap back to in-sync (mirrors Ctrl+Alt+←/→/0).
els.syncEarlierBtn.addEventListener('click', () => setSyncOffset(currentOffsetMs - OFFSET_STEP_MS));
els.syncLaterBtn.addEventListener('click', () => setSyncOffset(currentOffsetMs + OFFSET_STEP_MS));
els.offset.addEventListener('click', () => setSyncOffset(0));

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

/* Show / hide the lyric text (column + translation). The reactive backdrop and
   dancers keep running, so the overlay stays alive as a pure visualiser. */
function applyLyricsVisibility() {
  document.body.classList.toggle('lyrics-hidden', !lyricsVisible);
  els.lyricsBtn.setAttribute('aria-pressed', String(lyricsVisible));
}
els.lyricsBtn.addEventListener('click', () => {
  lyricsVisible = !lyricsVisible;
  applyLyricsVisibility();
  try { localStorage.setItem('lyricsVisible', lyricsVisible ? '1' : '0'); } catch { /* ignore */ }
});

/* Toggle system-audio-reactive mode. Captures whatever is playing (loopback) and
   drives kicks/build-ups/drops from the real spectrum. Falls back silently to the
   lyric-cadence engine if capture is unavailable. */
els.audioBtn.addEventListener('click', async () => {
  if (window.AudioReactive && window.AudioReactive.isActive()) {
    window.AudioReactive.stop();
    audioEnabled = false;
    els.audioBtn.setAttribute('aria-pressed', 'false');
    try { localStorage.setItem('audioEnabled', '0'); } catch { /* ignore */ }
    setStatus('');
    return;
  }
  setStatus('enabling audio-reactive…');
  const ok = await enableAudio();
  setStatus(ok ? '' : 'audio capture unavailable');
});

/* Toggle Lite (performance) mode. Re-seeds the canvas so the new resolution and
   reduced particle counts take effect immediately. */
els.perfBtn.addEventListener('click', () => {
  liteMode = !liteMode;
  els.perfBtn.setAttribute('aria-pressed', String(liteMode));
  try { localStorage.setItem('liteMode', liteMode ? '1' : '0'); } catch { /* ignore */ }
  resizeCanvas();
});

/* API-key panel. The 🔑 chip reveals a token input; saving it persists to the
   main-process settings store and flips the chip to "on" when a provider is now
   configured. The current provider is reflected on open. */
async function refreshProviderChip() {
  try {
    const { provider } = await window.player.getProviderStatus();
    els.keyBtn.setAttribute('aria-pressed', provider ? 'true' : 'false');
    els.keyBtn.title = provider ? `LLM provider: ${provider}` : 'Set HuggingFace API key';
    return provider;
  } catch {
    return null;
  }
}

function closeKeybox() {
  els.keybox.setAttribute('hidden', '');
  document.body.classList.remove('keybox-open');
}

els.keyBtn.addEventListener('click', async () => {
  const willShow = els.keybox.hasAttribute('hidden');
  if (willShow) {
    els.keybox.removeAttribute('hidden');
    // Pin the HUD open so the cursor-idle fade doesn't hide the input mid-type.
    document.body.classList.add('keybox-open');
    const provider = await refreshProviderChip();
    els.keyStatus.textContent = provider ? `active: ${provider}` : 'no provider configured';
    els.keyInput.focus();
  } else {
    closeKeybox();
  }
});

async function saveApiKey() {
  const value = els.keyInput.value.trim();
  els.keyStatus.textContent = 'saving…';
  try {
    const res = await window.player.setApiKey('HF_API_KEY', value);
    if (res.status === 'ok') {
      els.keyInput.value = '';
      els.keyStatus.textContent = res.provider ? `saved · active: ${res.provider}` : 'saved · cleared';
      await refreshProviderChip();
    } else {
      els.keyStatus.textContent = res.message || 'save failed';
    }
  } catch (err) {
    els.keyStatus.textContent = err.message || 'save failed';
  }
}

els.keySave.addEventListener('click', saveApiKey);
els.keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveApiKey();
  if (e.key === 'Escape') closeKeybox();
});

/* Pre-sync panel. The 📋 chip reveals a paste area; running it fetches + caches
   synced lyrics for the whole list in the background so those songs play instantly
   and offline later. Progress streams back via the `presync-progress` event. */
function closePresync() {
  els.presync.setAttribute('hidden', '');
  document.body.classList.remove('keybox-open');
}

els.presyncBtn.addEventListener('click', () => {
  const willShow = els.presync.hasAttribute('hidden');
  if (willShow) {
    els.presync.removeAttribute('hidden');
    document.body.classList.add('keybox-open'); // pin the HUD open while typing
    els.presyncInput.focus();
  } else {
    closePresync();
  }
});

els.presyncRun.addEventListener('click', async () => {
  const text = els.presyncInput.value.trim();
  if (!text) { els.presyncStatus.textContent = 'paste some tracks first'; return; }
  els.presyncRun.disabled = true;
  els.presyncStatus.textContent = 'starting…';
  try {
    await window.player.presyncList(text);
  } catch (err) {
    els.presyncStatus.textContent = err.message || 'pre-sync failed';
  } finally {
    els.presyncRun.disabled = false;
  }
});

els.presyncInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePresync();
});

window.player.onPresyncProgress((data) => {
  if (!data) return;
  if (data.status === 'done') {
    els.presyncStatus.textContent = data.summary || 'done';
    return;
  }
  const label = data.current ? ` · ${data.current}` : '';
  els.presyncStatus.textContent = `${data.done}/${data.total}${label}`;
});

refreshProviderChip();

let cursorTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 2500);
});

window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', flushBeatmap); // save learned beats on close

/* Bootstrap. */
try {
  const bl = parseInt(localStorage.getItem('backdropLevel'), 10);
  if (!Number.isNaN(bl) && bl >= 0 && bl < BACKDROP_LEVELS.length) backdropLevel = bl;
  const se = localStorage.getItem('spritesEnabled');
  if (se !== null) spritesEnabled = se === '1';
  const lv = localStorage.getItem('lyricsVisible');
  if (lv !== null) lyricsVisible = lv === '1';
  liteMode = localStorage.getItem('liteMode') === '1';
} catch { /* ignore */ }
applyBackdropLabel();
els.spritesBtn.setAttribute('aria-pressed', String(spritesEnabled));
els.perfBtn.setAttribute('aria-pressed', String(liteMode));
applyLyricsVisibility();

/* If audio-reactive was on last session, re-enable it. getDisplayMedia may need a
   user gesture, so attempt immediately and, on failure, retry on the first click. */
if (localStorage.getItem('audioEnabled') === '1') {
  enableAudio().then((ok) => {
    if (!ok) window.addEventListener('pointerdown', () => enableAudio(), { once: true });
  });
}

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
  applyOffsetLabel((data && data.offsetMs) || 0);
});
setStatus('waiting for playback…');
