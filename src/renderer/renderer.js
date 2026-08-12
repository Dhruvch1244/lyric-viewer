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
  fps: document.getElementById('hud-fps'),
  bpm: document.getElementById('hud-bpm'),
  work: document.getElementById('hud-work'),
  meters: document.getElementById('meters'),
  syncEarlierBtn: document.getElementById('btn-sync-earlier'),
  syncLaterBtn: document.getElementById('btn-sync-later'),
  progressFill: document.getElementById('hud-progress-fill'),
  scriptBtn: document.getElementById('btn-script'),
  translateBtn: document.getElementById('btn-translate'),
  ttScript: document.getElementById('tt-script'),
  ttTranslate: document.getElementById('tt-translate'),
  backdropBtn: document.getElementById('btn-backdrop'),
  presetBtn: document.getElementById('btn-preset'),
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
  libraryBtn: document.getElementById('btn-library'),
  library: document.getElementById('library'),
  libraryGrid: document.getElementById('library-grid'),
  librarySearch: document.getElementById('library-search'),
  libraryAdd: document.getElementById('library-add'),
  libraryAddFolder: document.getElementById('library-add-folder'),
  libraryCount: document.getElementById('library-count'),
  libraryClose: document.getElementById('library-close'),
  libraryEmpty: document.getElementById('library-empty'),
  transport: document.getElementById('transport'),
  trPrev: document.getElementById('tr-prev'),
  trPlay: document.getElementById('tr-play'),
  trNext: document.getElementById('tr-next'),
  trStop: document.getElementById('tr-stop'),
  trNow: document.getElementById('tr-now'),
  source: document.getElementById('hud-source'),
  mdBtn: document.getElementById('btn-milkdrop'),
  mdPanel: document.getElementById('milkdrop-panel'),
  mdSearch: document.getElementById('mdp-search'),
  mdList: document.getElementById('mdp-list'),
  mdStatus: document.getElementById('mdp-status'),
  mdPin: document.getElementById('mdp-pin'),
  mdRandom: document.getElementById('mdp-random'),
  mdClose: document.getElementById('mdp-close'),
  compactLine: document.getElementById('compact-line'),
  compactTranslation: document.getElementById('compact-translation'),
  ccEarlier: document.getElementById('cc-earlier'),
  ccLater: document.getElementById('cc-later'),
  ccTranslate: document.getElementById('cc-translate'),
  modeBtn: document.getElementById('btn-mode'),
  posterBtn: document.getElementById('btn-poster'),
  poster: document.getElementById('poster'),
  posterGrid: document.getElementById('poster-grid'),
  posterStatus: document.getElementById('poster-status'),
  posterAuto: document.getElementById('poster-auto'),
  posterClose: document.getElementById('poster-close'),
  welcome: document.getElementById('welcome'),
  welcomeClose: document.getElementById('welcome-close'),
  whatsnew: document.getElementById('whatsnew'),
  whatsnewList: document.getElementById('whatsnew-list'),
  whatsnewVersion: document.getElementById('whatsnew-version'),
  whatsnewClose: document.getElementById('whatsnew-close'),
  captureNudge: document.getElementById('capture-nudge'),
  nudgeEnable: document.getElementById('nudge-enable'),
  nudgeDismiss: document.getElementById('nudge-dismiss'),
  updatePill: document.getElementById('update-pill'),
  updateCard: document.getElementById('update-card'),
  updateVersion: document.getElementById('update-version'),
  updateInstall: document.getElementById('update-install'),
  updateLater: document.getElementById('update-later'),
  localcliCard: document.getElementById('localcli-card'),
  localcliText: document.getElementById('localcli-text'),
  localcliOptions: document.getElementById('localcli-options'),
  localcliDismiss: document.getElementById('localcli-dismiss'),
  keybox: document.getElementById('keybox'),
  keyInput: document.getElementById('keybox-input'),
  keySave: document.getElementById('keybox-save'),
  keyStatus: document.getElementById('keybox-status'),
  canvas: document.getElementById('backdrop'),
  swirl: document.getElementById('swirl'),
  milkdrop: document.getElementById('milkdrop'),
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
/**
 * Word spans of the ACTIVE line only, with their timing bounds and last painted
 * state — `{el, startMs, endMs, state}`. Rebuilt by renderWords; read by
 * paintWords on every frame, which is why it holds numbers rather than making
 * the frame loop go back to the DOM for them.
 */
let activeWords = [];

/** How many lines either side of the active one are ever visible. */
const LINE_WINDOW = 2;
/**
 * Inclusive range of lines currently carrying inline styles. Everything outside
 * it is in the state buildColumn left it in, so only the boundary needs
 * touching when the window moves — see setActive.
 */
let styledFrom = 0;
let styledTo = -1;   // empty range

/**
 * Return a line to the hidden, unstyled state buildColumn creates.
 *
 * `visibility: hidden` rather than `display: none` because the column scrolls
 * by translating a fixed stack — removing a line from layout would shift every
 * position below it. `filter: none` rather than `blur(0)` because a filter of
 * any kind keeps the element on its own compositing layer.
 *
 * @param {HTMLElement} el
 */
function resetLineStyle(el) {
  if (!el) return;
  el.classList.remove('is-active');
  el.style.opacity = '0';
  el.style.visibility = 'hidden';
  el.style.filter = 'none';
}

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
/**
 * The visual profile derived from the song's mood + energy — motion character,
 * not just palette. Neutral until the sentiment pass lands. See mood.js.
 */
let moodProfile = { key: 'neutral', motion: 1, turbulence: 1, flicker: 1, warmth: 0 };

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
  // "faint", not "ghost": Ghost is a visual PRESET (lyrics + cloud, nothing
  // else) and having two chips offer the same word for different things was
  // confusing. This label is safe to rename — the choice persists as an index,
  // not a name — whereas the preset id is stored as a string in localStorage
  // and in the per-track overrides, so renaming that would silently discard
  // every look a user had pinned to a song.
  { name: 'faint', alpha: 0.34 },
  { name: 'tinted', alpha: 0.62 },
  { name: 'vivid', alpha: 0.84 },
  { name: 'solid', alpha: 1.0 },
];
let backdropLevel = 2; // default "vivid" — clearly visible, still lets video peek

/* ------------------------------------------------------------ artist sprites */
/** Dancing pixel actors for the current artist. */
let spriteActors = [];

/**
 * Per-line artist index for the current song, or null when nobody worked it out.
 * @type {number[]|null}
 */
let lineSingers = null;

/** Who is on the mic now, so a shared line keeps them there rather than jumping. */
let activeMicActor = -1;

/** The attribution as received, kept so it can be re-mapped when actors change. */
let attributionPayload = null;

/**
 * Bind the current cast to an attribution. The mapping itself lives in
 * sprites.js, next to the code that builds the cast and knows why the two
 * index spaces differ — and where it can be unit-tested.
 *
 * @param {{artists: string[], singers: number[]}|null} attribution
 * @returns {number[]|null} one actor index per line, or null to keep rotating
 */
function mapAttributionToActors(attribution) {
  if (!attribution) return null;
  return window.ArtistSprites.mapAttribution(
    spriteActors, attribution.artists, attribution.singers,
  );
}

/** Apply an attribution (or clear it) and refresh the mapping. */
function setAttribution(attribution) {
  attributionPayload = attribution || null;
  lineSingers = mapAttributionToActors(attributionPayload);
}
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

/* Whether the overlay window is on screen. False after Ctrl+Alt+H or the tray's
   hide. Both render loops park on this — see the onVisibility handler. */
let overlayVisible = true;

/* Last progress width actually written, in tenths of a percent. -1 forces the
   next frame to write, which is what resets it on a track change. */
let lastProgressPct = -1;

/* Eased spectral centroid, 0..1 — the live "brightness" of the mix, which is
   what separates a filtered breakdown from a full-range drop at equal loudness.
   Starts at the value a mid-range mix settles on, so the first seconds of a
   track do not swing the hue while it converges. */
let brightness = 0.3;

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

/**
 * Per-word timings for a line — syllable-weighted, see wordtiming.js.
 *
 * Kept as a thin wrapper so the renderer still works if that script fails to
 * load: the fallback is the old even split, which is worse but never blank.
 *
 * @param {string} text
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Array<{word: string, startMs: number, endMs: number}>}
 */
function buildWordTimings(text, startMs, endMs) {
  if (window.WordTiming) return window.WordTiming.build(text, startMs, endMs);

  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const span = Math.max(0, Math.min(endMs - startMs, MAX_WORD_SPREAD_MS));
  const each = span / words.length;
  return words.map((word, i) => ({
    word,
    startMs: startMs + each * i,
    endMs: startMs + each * (i + 1),
  }));
}

/**
 * When a line stops being sung (ms).
 *
 * `endMs` is real data — the LRC gap marker that closes the line (see
 * normaliseCues in src/main/lyrics.js). Only when a line has none do we fall
 * back to "it runs until the next line starts", which overstates every line
 * followed by an instrumental stretch.
 *
 * @param {number} index
 * @returns {number}
 */
function lineEndMs(index) {
  const cue = cues[index];
  if (!cue) return 0;
  if (Number.isFinite(cue.endMs) && cue.endMs > cue.timeMs) return cue.endMs;
  const next = cues[index + 1];
  return next ? next.timeMs : cue.timeMs + 3000;
}

/** On-screen duration of a line (ms). */
function lineDurationMs(index) {
  const cue = cues[index];
  if (!cue) return 3000;
  return Math.max(250, lineEndMs(index) - cue.timeMs);
}

/**
 * True when playback sits in a long instrumental stretch AFTER the active line
 * has finished — the "lyrics paused, music playing" state where the flickering
 * song-name hero should take over.
 *
 * The line's sung end comes from its `endMs` gap marker when the lyric source
 * provided one, and is otherwise estimated from its word count (capped at the
 * distance to the next line). The hero appears once that end has passed and
 * steps back out shortly before the next line arrives.
 *
 * @param {number} positionMs
 * @returns {boolean}
 */
function isInstrumentalGap(positionMs) {
  if (cues.length === 0 || activeIndex < 0) return false;
  const line = cues[activeIndex];
  const next = cues[activeIndex + 1];
  const nextStart = next ? next.timeMs : (durationMs > 0 ? durationMs : Infinity);

  let sungEnd;
  if (Number.isFinite(line.endMs) && line.endMs > line.timeMs) {
    sungEnd = Math.min(line.endMs, nextStart);
  } else {
    const words = (line.text || '').split(/\s+/).filter(Boolean).length;
    sungEnd = line.timeMs + Math.min(nextStart - line.timeMs, Math.max(1400, words * 360));
  }

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
 * How hard the GPU swirl field should spiral right now, 0..1.
 *
 * The rule is "swirl into the space the lyrics aren't using". Big spirals are
 * gorgeous but they fight dense text for attention, so the field opens up when
 * there is visual headroom and pulls back when there is a lot to read:
 *
 *   - no lyrics at all / instrumental tail  -> fully open, nothing to compete with
 *   - a short line held for a long time     -> open, the screen is mostly empty
 *   - a long, fast, wordy bar               -> calm, keep the text legible
 *
 * Build-ups and drops override the calm-down, because a drop should always be
 * allowed to take over the screen.
 *
 * @param {number} positionMs current playback position
 * @returns {number} 0..1 target swirl strength
 */
function swirlTarget(positionMs) {
  // Energy floor: hyped songs keep more motion even mid-verse.
  const floor = 0.16 + baseEnergy * 0.30;

  // Nothing to read — either no synced lyrics, lyrics hidden, or an
  // instrumental stretch. This is the "swirl big" case.
  const noText = cues.length === 0 || activeIndex < 0 || !lyricsVisible || instrumentalGap;
  let target;
  if (noText) {
    target = 0.82;
  } else {
    const cue = cues[activeIndex];
    const chars = (cue && cue.text ? cue.text.trim().length : 0);
    if (chars === 0) {
      target = 0.82;
    } else {
      // Occupancy: how much of this line's on-screen time is actually spent
      // delivering text. ~14 chars/second is a normal sung cadence, so a line
      // at or above that reads as "dense" and damps the swirl toward the floor.
      const seconds = lineDurationMs(activeIndex) / 1000;
      const density = Math.min(1, (chars / 14) / Math.max(0.35, seconds));
      // Short lines (hooks, one-word ad-libs) get extra room on top.
      const brevity = 1 - Math.min(1, chars / 46);
      target = floor + (1 - density) * 0.55 + brevity * 0.20;
    }
  }

  // Musical surges always win over the text-density damping.
  target = Math.max(target, buildup * 0.95, dropFlash * 0.9);
  // A little continuous lift from overall loudness so quiet passages settle.
  target += intensity * 0.10;

  return Math.max(0, Math.min(1, target));
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
/**
 * Scripts whose glyphs carry combining marks (matras, nuktas, viramas) that
 * must stay welded to their base consonant. Bebas Neue's Latin tracking and
 * the `overflow-wrap: anywhere` used for long Latin lines both break those
 * clusters apart, which shows up as vowel signs floating off their letters.
 * `.ln--complex` turns both off — see styles.css.
 *
 * Covers Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu,
 * Kannada, Malayalam, Sinhala, Thai, Arabic and Hebrew.
 */
const COMPLEX_SCRIPT_RE = new RegExp(
  '[' +
  '\\u0590-\\u05FF' +   // Hebrew
  '\\u0600-\\u06FF' +   // Arabic
  '\\u0900-\\u0DFF' +   // Devanagari … Sinhala (incl. Gurmukhi, Bengali, Tamil)
  '\\u0E00-\\u0E7F' +   // Thai
  ']'
);

/**
 * Whether a lyric line needs complex-script text shaping.
 * @param {string} text
 * @returns {boolean}
 */
function needsComplexShaping(text) {
  return COMPLEX_SCRIPT_RE.test(text || '');
}

function buildColumn() {
  els.column.textContent = '';
  lineEls = cues.map((cue) => {
    const el = document.createElement('div');
    // Tagged per line, not per track, so a code-switched song (a Hindi hook
    // over English bars) shapes each line correctly.
    el.className = needsComplexShaping(cue.text) ? 'ln ln--complex' : 'ln';
    el.textContent = cue.text || ' ';
    // The `.ln` rule carries `filter: blur(4px)` for the sharpen-in effect,
    // which would promote every line in the song to its own compositing layer
    // the moment the column is built. Start hidden and unfiltered; setActive()
    // reveals and blurs only the two lines either side of the active one.
    el.style.visibility = 'hidden';
    el.style.filter = 'none';
    els.column.appendChild(el);
    return el;
  });
  activeIndex = -1;
  activeWords = [];   // the old line's spans are gone with the old column
  styledFrom = 0; styledTo = -1;   // fresh elements carry no inline styling yet
}

/** Render a cue's words (interpolated per-word timing) into an element. */
function renderWords(el, index) {
  const cue = cues[index];
  /*
    Measured timings win. `cue.words` is present when this song has been through
    word-level alignment (correct words from the lyric source, measured timing
    from Whisper — see src/main/wordalign.js). Only when that is absent do we
    fall back to estimating the split from syllables.
  */
  const timings = Array.isArray(cue.words) && cue.words.length > 0
    ? cue.words
    : buildWordTimings(cue.text, cue.timeMs, lineEndMs(index));

  el.textContent = '';
  activeWords = [];
  const n = timings.length;
  timings.forEach((timing, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = timing.word;
    // Bounds are kept alongside the element (see paintWords) rather than read
    // back out of the DOM every frame.
    activeWords.push({ el: span, startMs: timing.startMs, endMs: timing.endMs, state: -1 });
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

  /* The compact modes have no scrolling column, so this one element is the
     whole lyric display. Written here rather than every frame — the line only
     changes when the active cue does. */
  if (els.compactLine) {
    els.compactLine.textContent = index >= 0 && cues[index] ? (cues[index].text || '') : '';
  }

  /*
    Which dancer is "on the mic".

    Until 0.21.0 this was `index % spriteActors.length` — collaborators took
    turns as the line advanced, because no lyric source carries per-line
    attribution and none can be bought. On a three-artist track that is right
    one line in three by accident.

    When an attribution has been worked out for the song (see attribute.js) it
    names the artist per line instead, and the rotation stays as the fallback
    for everything else: no provider, a solo artist, a line the model marked
    shared. -1 means shared or unknown, and keeps whoever was already up rather
    than picking someone arbitrary for a chorus.
  */
  if (spriteActors.length > 0) {
    let on = index >= 0 ? index % spriteActors.length : 0;
    if (lineSingers && index >= 0 && index < lineSingers.length) {
      const named = lineSingers[index];
      if (named >= 0 && named < spriteActors.length) on = named;
      else if (activeMicActor >= 0) on = activeMicActor;
    }
    activeMicActor = on;
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
  // The gap is measured from where the previous line STOPPED being sung, not
  // where it started; measuring from the start counts the line's own length as
  // silence and fires drops that aren't there.
  if (index >= 0 && index === prev + 1) {
    const prevTime = index > 0 ? lineEndMs(index - 1) : 0;
    if (cues[index].timeMs - prevTime > GAP_DROP_MS) triggerDrop();
  }

  if (index < 0) {
    // No line is active, so the cached spans above now point at detached
    // elements — drop them rather than let paintWords keep styling orphans.
    activeWords = [];
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

  /*
    Per-line state, applied ONLY to the lines that can be seen.

    This used to walk every line in the song on each change. The window is five
    lines wide, so on a 90-line track that was ~85 elements per line change
    being written four style properties each to set them to values they already
    held — and every one of those writes dirties the column's style tree, so
    the recalculation lands exactly on the frame the lyric advances, which is
    the most visible moment there is.

    Lines are now touched when they ENTER the window and reset when they LEAVE
    it, so the work is proportional to the view rather than the song.
  */
  const from = Math.max(0, index - LINE_WINDOW);
  const to = Math.min(lineEls.length - 1, index + LINE_WINDOW);

  for (let i = styledFrom; i <= styledTo; i += 1) {
    if (i < from || i > to) resetLineStyle(lineEls[i]);
  }
  styledFrom = from;
  styledTo = to;

  for (let i = from; i <= to; i += 1) {
    const el = lineEls[i];
    const d = Math.abs(i - index);
    if (i === index) {
      el.classList.add('is-active');
      el.style.setProperty('--active-scale', activeScale.toFixed(3));
      el.style.opacity = '1';
      // Must be set explicitly, not inherited from having been a neighbour a
      // moment ago: lines start hidden, so a line reached WITHOUT passing
      // through the neighbour state — the first line of a song, or any line
      // landed on by a seek — would otherwise go active while still hidden.
      el.style.visibility = '';
      // Clear the inline blur → the CSS `.is-active { filter: blur(0) }` takes
      // over and the line "sharpens in" from its previous neighbour blur.
      el.style.filter = '';
    } else {
      el.classList.remove('is-active');
      const op = d === 1 ? 0.34 : d === 2 ? 0.07 : 0;
      el.style.opacity = String(op);

      /*
        Only the two lines either side are ever visible, so only they get a
        blur.

        This used to blur EVERY line in the song, including the dozens sitting
        at opacity 0. A CSS filter promotes each element to its own compositing
        layer, so a 60-line track had Chromium rasterising 60 blur layers per
        frame with ~55 of them invisible — which is why the frame rate
        collapsed as soon as lyrics were on screen and recovered the moment
        only the hero showed. Measured on a real device: 15-20fps with lyrics
        against 27-28fps without.

        `visibility: hidden` keeps the element in layout — the column scrolls
        by translating a fixed stack, so removing lines with `display: none`
        would shift every position — while taking it out of paint entirely.
      */
      el.style.visibility = '';
      el.style.filter = `blur(${d === 1 ? 3.5 : 6}px)`;
    }
  }

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

/* Word states, cheap to compare. */
const WORD_PENDING = 0;
const WORD_SINGING = 1;
const WORD_SUNG = 2;

/**
 * Highlight the word being sung.
 *
 * Runs every frame, so it does no DOM *reading* at all: the spans and their
 * numeric bounds are captured once in renderWords, and each word remembers the
 * state it is already in so the class list is only touched on a transition —
 * roughly once per word per line instead of once per word per frame.
 *
 * The previous version called querySelectorAll and re-parsed two dataset
 * attributes (string → number) for every word on every frame: for a 10-word
 * line that was 600 queries and 1200 string parses a second, to produce about
 * ten actual changes.
 *
 * @param {number} positionMs
 */
function paintWords(positionMs) {
  for (let i = 0; i < activeWords.length; i += 1) {
    const w = activeWords[i];
    const state = positionMs >= w.endMs ? WORD_SUNG
      : positionMs >= w.startMs ? WORD_SINGING
        : WORD_PENDING;

    if (state !== w.state) {
      w.state = state;
      const cl = w.el.classList;
      cl.toggle('word--active', state === WORD_SINGING);
      cl.toggle('word--sung', state === WORD_SUNG);
      // Leaving the active state: clear the fill so a re-entry starts clean and
      // a sung word is not left mid-wipe.
      if (state !== WORD_SINGING) w.el.style.removeProperty('--fill');
    }

    /*
      Karaoke-grade fill. The active word is wiped left→right over its own
      duration, the way karaoke has always coloured the syllable being sung —
      not the old all-at-once highlight. This is the ONE per-frame style write
      in the lyric loop, on a single element, and it is quantised to ~40 steps
      so a word only re-paints when the wipe visibly advances.
    */
    if (state === WORD_SINGING) {
      const dur = w.endMs - w.startMs;
      const p = dur > 0 ? (positionMs - w.startMs) / dur : 1;
      const step = Math.max(0, Math.min(1, Math.round(p * 40) / 40));
      if (step !== w.fill) {
        w.fill = step;
        w.el.style.setProperty('--fill', String(step));
      }
    }
  }
}

/**
 * Why the translation line is not showing, or '' when it is fine.
 *
 * Translations are looked up BY INDEX, so a list of a different length is
 * unusable and gets hidden — correct, but until now completely silent, which
 * left "does translation work with sync?" unanswerable from the UI. The honest
 * answer is that they work together until the line counts disagree, and that
 * now says so.
 *
 * @returns {string}
 */
function translationBlockedReason() {
  if (!cuesEnglish) return '';
  if (cuesEnglish.length !== cues.length) {
    return `${cues.length} lyric lines, ${cuesEnglish.length} translated — can't line them up`;
  }
  return '';
}

function updateTranslation(index) {
  // The translation is looked up BY INDEX, so it is only meaningful against the
  // exact list it was produced from. A Devanagari track fetched as its own
  // LRCLIB entry can have a different line count from the Latin one, which
  // would otherwise caption each line with a neighbour's translation.
  const aligned = Boolean(cuesEnglish) && cuesEnglish.length === cues.length;
  if (!showTranslation || !aligned || index < 0 || index >= cuesEnglish.length) {
    els.translation.classList.remove('is-visible');
    els.translation.textContent = '';
    if (els.compactTranslation) els.compactTranslation.textContent = '';
    return;
  }
  const text = (cuesEnglish[index] && cuesEnglish[index].text) || '';
  els.translation.textContent = text;
  els.translation.classList.toggle('is-visible', Boolean(text.trim()));
  // The compact modes hide the stage, so the normal translation element goes
  // with it; this is the same text in the one place still on screen.
  if (els.compactTranslation) els.compactTranslation.textContent = text;
}

/* ---------------------------------------------------------------- main loop */

function frame() {
  try {
    // Hidden overlay: nothing here has a visible effect, and the DOM writes
    // below are the expensive kind. Position is derived from a timestamp, not
    // accumulated, so skipping frames loses nothing.
    if (!overlayVisible) return;

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

    // Progress bar, quantised to 0.1% rather than written every vsync. The bar
    // is a few hundred pixels wide, so a full-precision 60Hz write is ~50 style
    // invalidations a second that resolve to the same pixels — on a surface
    // whose compositing is already the dominant cost. Quantising is the whole
    // throttle: 0.1% of a 3-minute track is 180ms, so this settles at ~5
    // writes/s and scales with the track rather than needing a second timer.
    if (durationMs > 0) {
      const pct = Math.max(0, Math.min(100, (positionMs / durationMs) * 100));
      const step = Math.round(pct * 10) / 10;
      if (step !== lastProgressPct) {
        lastProgressPct = step;
        els.progressFill.style.width = `${step}%`;
      }
    }

    // Build-up ramp: while a long instrumental gap approaches its next lyric,
    // ramp 0→1 over the final BUILDUP_WINDOW ms so the wash swells before a drop.
    let targetBuildup = 0;
    if (cues.length > 0) {
      const nextIdx = activeIndex + 1;
      const gapStart = activeIndex >= 0 ? lineEndMs(activeIndex) : 0;
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

/* GPU swirl field (src/renderer/swirl.js). When it initialises, it owns the
   fluid colour base and the 2D flat wash below is thinned right down so the
   shader shows through; when WebGL2 is missing this stays false and the
   original wash is painted at full strength. */
const swirlOn = (() => {
  try {
    return Boolean(window.SwirlField && window.SwirlField.init(els.swirl));
  } catch (err) {
    console.warn('[swirl] init threw, using the 2D wash:', err && err.message);
    return false;
  }
})();

/* Smoothed 0..1 swirl drive. Eased rather than set directly so the spiral
   accelerates and unwinds over ~a second instead of snapping between lines. */
let swirlDrive = 0;

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
/* Which 2D layers are drawn this frame. Owned by the active preset (see
   src/renderer/presets.js) — never assigned at random any more. */
let scene = { aurora: true, bokeh: true, eq: false, rays: false, math: true, web: true, galaxy: true };

/** The user's chosen preset id; persisted. */
let presetId = 'liquid';

/** The preset actually on screen, which may be a cheaper substitute. */
let renderedPresetId = '';

/** When the on-screen preset last changed, for the cross-fade. */
let presetFadeAt = 0;

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
/* Measured tempo (see tempo.js). While locked, the beat clock runs in real time
   and is phase-aligned to the kick onsets, so the visuals land ON the beat
   rather than near it. Hysteresis: lock in high, release low, so a breakdown
   with no percussion doesn't flap the clock in and out. */
let tempoLocked = false;
let tempoBpm = 0;
let lastTempoCheckAt = 0;
/** Previous confident estimate, so a lock needs two that agree. */
let lastTempoBpm = 0;
const TEMPO_LOCK_IN = 0.62;
const TEMPO_LOCK_OUT = 0.40;
/** Onsets required before the clock is handed over — a couple of bars. */
const TEMPO_LOCK_ONSETS = 24;

/* ------------------------------------------------------------ anticipation */

/* How far ahead the learned heat map is read. Long enough to cover a build-up
   (they run four to eight bars), short enough that a rise forty seconds out
   does not colour the present. */
const ANTICIPATION_WINDOW_MS = 6000;

/** Expectation of a rise, 0..1, from the stored map. Zero on an unheard song. */
let anticipation = 0;
/** Time to the expected peak (ms), for the countdown on the timeline. */
let anticipationToPeakMs = 0;

let beatPeriodMs = 500;     // current estimated beat length
let beatClockMs = 0;        // accumulates dt, wraps every beatPeriodMs
let beatPhase = 0;          // 0..1 within the current beat
let beatFlash = 0;          // decays after each beat, drives pulses/flicker
/* Screen flicker/strobe (0..1). Rises on drops + high energy, and micro-strobes
   on the beat, then decays. Applied as a brief white veil + hue jitter. */
let flicker = 0;
/* Last quantised hue pushed to the lyric CSS var, to skip redundant style sets. */
let lastLyricHue = -999;

/** Last --beat value written to the DOM, to avoid redundant style writes. */
let lastBeatVar = -1;

/* ---- adaptive quality governor (keeps the frame rate near 60) ----
   An EMA of instantaneous FPS. When frames run long, `quality` eases toward 0.5
   and the heaviest maths layers subsample (draw fewer points/links); when there's
   headroom it eases back to 1.0. This trades detail for smoothness automatically
   so the overlay stays fluid on weaker GPUs. */
let fpsEMA = 60;
let quality = 1;
/** Throttle for the on-screen FPS readout. */
let lastFpsShownAt = 0;
/** Timestamp of the last *drawn* backdrop frame, for adaptive frame-skipping. */
let lastDrawnAt = 0;

/*
  Smoothed cost of ONE backdrop frame, in ms — the governor's input.

  This used to be driven by fpsEMA, which latched: `rawDt` is the interval
  between *drawn* frames, so once the throttle engaged the app only ever
  measured its own throttled output. Falling under 30fps set a 32ms throttle,
  which produced ~31fps, which kept fpsEMA under 45 forever. The app could not
  discover it had headroom again, so it stayed frame-skipped with `quality`
  dragged down to 0.45 long after whatever caused the dip had passed — on a
  machine that could have run at full rate.

  Frame COST does not have that feedback path: it measures the work, not the
  pace we chose to do it at, so recovery is immediate when the load drops.
*/
let drawCostMs = 8;

/*
  Smoothed interval between animation-frame callbacks (ms) — how fast frames are
  actually being PRESENTED, as opposed to how long our own work takes.

  These are different numbers and the difference is the whole point. Measured on
  this app: the full "concert" look costs ~5-6ms of JavaScript, Ghost mode costs
  0.1ms, and the presented frame rate barely moves between them — the time goes
  to GPU raster and to compositing a full-screen transparent window, both of
  which happen after our code has returned. So CPU cost is the wrong signal for
  "are we struggling"; the presented interval is the right one.

  Sampled on EVERY callback, including ones where drawing is skipped, so it
  measures the compositor rather than our own throttle.
*/
let frameIntervalMs = 16.7;
let lastFrameAt = 0;

/*
  Drawing-buffer scale currently applied to the swirl field.

  The field renders below CSS resolution and is stretched back up by the
  compositor; because it is a soft, blurred cloud the upscale is invisible,
  which makes resolution the cheapest quality lever the app has — fill cost
  falls with the SQUARE of the scale, so 0.7 → 0.4 is roughly a third of the
  pixels for a barely perceptible change in softness. See applySwirlScale.
*/
let swirlScale = 0;
/** Resolution ladder, coarse on purpose — see applySwirlScale. */
const SWIRL_SCALES = [0.30, 0.40, 0.55, 0.70];
/** When the swirl resolution last changed, so climbing back up is rate-limited. */
let lastSwirlScaleAt = 0;
/** Whether the 2D backdrop canvas is currently out of the page (Ghost mode). */
let canvasHidden = false;

/* Whether the GPU field's canvas is currently out of the page. Presets that ask
   for a transparent background take it out entirely rather than rendering it at
   alpha 0 — an untouched full-screen WebGL canvas is still a compositor layer,
   and on this app compositing is the dominant cost. */
let swirlHidden = false;

/* ------------------------------------------------------------ visual engine */
/*
  Two engines, never both. The swirl field is the signature look and the
  default; Butterchurn (MilkDrop presets) is the variety answer — see
  milkdrop.js for why it exists and what it must not become.

  They are mutually exclusive because each is a full-screen WebGL2 context, and
  two alive at once doubles GPU cost for no benefit on an app whose dominant
  cost is already compositing. Switching tears the idle one down.
*/
let activeEngine = 'swirl';

/** The MilkDrop preset currently loaded, so a cycle can advance from it. */
let milkdropName = null;

/** Guards the beat-synced transition against firing repeatedly in one drop. */
let lastMilkdropSwitchAt = 0;

/** Last size sent across the frame boundary, so resizes are not sent per frame. */
let milkdropSize = '';

/* Which preset SHOULD be showing, and why. See the precedence note in
   applyEngine — one place owns this, or the engine fights itself every frame.
   `milkdropChosen` is a session choice (a click or the dice) and is not
   persisted; a pin is. */
let milkdropWanted = null;
let milkdropChosen = null;
/** The visual preset id `milkdropWanted` was seeded from. */
let milkdropSeededFor = null;

/* ------------------------------------------------------------ display mode */
/*
  'full' is the overlay this app has always been. 'bar' is a small floating
  panel and 'strip' is a click-through line along the bottom edge — both exist
  because taking over the screen is the single biggest reason someone tries the
  app once and stops.

  Neither compact mode draws a visualiser. That is not a simplification for its
  own sake: the whole saving is compositing fewer pixels, and a full-screen
  WebGL context inside a 54px window would compose the same surface it always
  did while showing almost none of it.
*/
let displayMode = 'full';

/**
 * Whether the current mode is too small to draw a backdrop.
 *
 * Named modes, not "anything but full". Wallpaper mode fills the whole display
 * and wants every layer; a `!== 'full'` test would have classed it as compact
 * and torn both GPU surfaces out of the page, leaving the desktop showing a
 * lyric line on a flat colour.
 */
function isCompact() {
  return displayMode === 'bar' || displayMode === 'strip';
}

/**
 * Minimum seconds between beat-synced preset changes.
 *
 * Long, deliberately. Plane9's scene transitions are what make a visualiser
 * feel designed, but a MilkDrop preset needs time to develop — cutting every
 * drop in a four-on-the-floor track would be a strobe, not a sequence.
 */
const MILKDROP_SWITCH_MS = 42000;

/*
  Resolution ladder for the 2D backdrop, mirroring the swirl's.

  The swirl could already shed pixels under load; the 2D canvas could not, so
  when the machine struggled only half the fill cost was adjustable. Compositing
  these two full-screen layers is by far the largest single cost in any profile
  (`(program)` sits near 850ms/s against ~50ms/s for all app JavaScript), and
  backing-store size is the only lever we have on it.

  Deliberately shallower than the swirl's ladder and it only engages under real
  pressure. The swirl is soft and upscales invisibly; this canvas carries the
  pixel-art dancers and the timeline, which soften visibly when downscaled. A
  slightly soft dancer beats a dropped frame, but only when frames are actually
  being dropped.
*/
const CANVAS_SCALES = [0.70, 0.85, 1.0];
let canvasScale = 1.0;
let lastCanvasScaleAt = 0;

/**
 * Move the 2D canvas up or down a rung based on presented frame cadence.
 * Uses the same signal and hysteresis as applySwirlScale — resolution is a GPU
 * lever and needs a GPU signal, not our JavaScript cost.
 * @param {number} now
 */
function applyCanvasScale(now) {
  let rung = CANVAS_SCALES.indexOf(canvasScale);
  if (rung < 0) rung = CANVAS_SCALES.length - 1;

  if (frameIntervalMs > 24 && rung > 0) {
    rung -= 1;
    lastCanvasScaleAt = now;
  } else if (frameIntervalMs < 13 && rung < CANVAS_SCALES.length - 1
    && now - lastCanvasScaleAt > 1500) {
    rung += 1;
    lastCanvasScaleAt = now;
  }

  const next = CANVAS_SCALES[rung];
  if (next === canvasScale) return;
  canvasScale = next;
  /*
    Only the backing store — NOT the full resizeCanvas, which also reseeds the
    stars, bokeh, web, galaxy and wormhole. Reseeding on a rung change would
    visibly reshuffle every particle layer, so a frame-rate dip would announce
    itself as the starfield jumping. Everything cached by CSS-pixel dimensions
    (the timeline bitmap, the vinyl platter, the stage gradients) stays valid,
    because setTransform keeps drawing in CSS pixels either way.
  */
  sizeBackdropCanvas();
}

/** Size the 2D backing store for the current DPR cap and governor rung. */
function sizeBackdropCanvas() {
  // Cap DPR at 1.0: the backdrop is soft glows, gradients and blur, so native
  // hi-DPI is pure wasted fill-rate (the single biggest cause of lag on 4K).
  // Lyrics stay crisp regardless — they are DOM, not canvas.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.0) * canvasScale;
  els.canvas.width = Math.floor(window.innerWidth * dpr);
  els.canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizeCanvas() {
  // Cap DPR at 1.0 for the backdrop canvas: it is all soft glows, gradients and
  // blur, so rendering at native hi-DPI resolution is pure wasted fill-rate (the
  // single biggest cause of lag on 4K screens). Lyrics stay crisp — they're DOM,
  // unaffected by the canvas backing-store resolution.
  sizeBackdropCanvas();

  const w = window.innerWidth;
  const h = window.innerHeight;

  // The swirl field is soft and upscaled by the compositor, so it renders at a
  // fraction of CSS resolution — the cheapest quality lever it has. Lite mode
  // halves it again.
  // Re-size the field to the new window at whatever rung the governor has us on
  // (applySwirlScale owns the scale itself; this only follows the dimensions).
  if (swirlOn) {
    if (!swirlScale) swirlScale = liteMode ? SWIRL_SCALES[0] : SWIRL_SCALES[2];
    window.SwirlField.resize(w, h, swirlScale);
  }
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
  seedWormhole();

  // Re-center after a resize.
  const idx = activeIndex;
  activeIndex = -1;
  if (idx >= 0) setActive(idx);
}

function seedStars() {
  // Fewer stars than before — the previous density was a needless cost. Lite
  // mode thins them further (denser fields cost more fill + arc calls per frame).
  const cap = liteMode ? 80 : 130;
  const div = liteMode ? 24000 : 16000;
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
  const count = Math.min(liteMode ? 12 : 28, Math.round((window.innerWidth * window.innerHeight) / 80000));
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
    // Index into the bucketed colour table, resolved once at seed time so the
    // draw loop never computes a colour.
    bucket: Math.min(GALAXY_HUE_BUCKETS - 1,
      Math.floor((i / count) * GALAXY_HUE_BUCKETS)),
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

/* Opacity steps the constellation's links are grouped into. Eight is enough
   that a 1px line at these alphas reads as a continuous falloff. */
const WEB_ALPHA_BUCKETS = 8;

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

  /*
    Links are batched by opacity rather than stroked one at a time.

    At 28 nodes the pair loop reaches 378 links, and each one used to cost a
    `hexA` string build plus its own beginPath/moveTo/lineTo/stroke — the
    heaviest stroke load in the app. Opacity is the only thing that varied, so
    the segments are collected into a handful of buckets and each bucket is
    stroked once. Eight steps of alpha on a 1px line at these opacities is not
    distinguishable from continuous.

    Path2D has no clear operation, so the buckets are reallocated each frame —
    eight small objects against the 378 strings and 378 stroke calls removed.
  */
  const paths = [];
  for (let k = 0; k < WEB_ALPHA_BUCKETS; k += 1) paths.push(new Path2D());

  const linkBase = 0.16 + life * 0.22 + beatFlash * 0.2;
  for (let i = 0; i < nUsed; i += 1) {
    const a = webNodes[i];
    for (let j = i + 1; j < nUsed; j += 1) {
      const b = webNodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < linkDist) {
        const t = 1 - d / linkDist;
        const bucket = Math.min(WEB_ALPHA_BUCKETS - 1, Math.floor(t * WEB_ALPHA_BUCKETS));
        const path = paths[bucket];
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
      }
    }
  }

  ctx.strokeStyle = linkCol;
  for (let k = 0; k < WEB_ALPHA_BUCKETS; k += 1) {
    // Bucket centre, so a bucket reads as the average of the links it holds.
    const t = (k + 0.5) / WEB_ALPHA_BUCKETS;
    ctx.globalAlpha = Math.min(1, t * linkBase);
    ctx.stroke(paths[k]);
  }

  // Node dots, pulsing on the beat. fillRect for the same reason as the galaxy.
  ctx.globalAlpha = Math.min(1, 0.5 + beatFlash * 0.4);
  ctx.fillStyle = linkCol;
  const nd = (1.4 + life * 1.8 + beatFlash * 2.2) * DOT_SQUARE_SCALE;
  for (let i = 0; i < nUsed; i += 1) {
    const a = webNodes[i];
    ctx.fillRect(a.x - nd / 2, a.y - nd / 2, nd, nd);
  }
  ctx.globalAlpha = 1;
}

/* ---- phyllotaxis galaxy ----
   The golden-angle spiral of stars, rotated slowly and pulsing on the beat. The
   sunflower packing gives it real mathematical structure while staying organic. */
/*
  Colour buckets for the galaxy.

  Each particle carries its own hue offset spanning 90°, and the old code turned
  that into a colour PER PARTICLE PER FRAME: `shiftHex` is a full RGB→HSL→hex
  round trip ending in a string build, and `hexA` added a second one. At 260
  particles that was ~31,000 string-building colour operations a second — the
  single most expensive thing in Concert, and invisible to a draw-call probe
  because none of it is a canvas call.

  Twelve buckets across 90° is 7.5° apart, which is not perceptible on a 2px
  twinkling dot. Rebuilt only when the snapped hue or the palette changes.
*/
const GALAXY_HUE_BUCKETS = 12;

/* Square side that covers the same area as a circle of radius r, doubled for
   diameter: 2·r·√π/2. Keeps a dot's visual weight unchanged when it is drawn
   with fillRect instead of arc+fill. */
const DOT_SQUARE_SCALE = Math.sqrt(Math.PI);
/** @type {{key: string, colours: string[]}|null} */
let galaxyPalette = null;

/**
 * The bucketed colour table for the galaxy.
 * @returns {string[]} GALAXY_HUE_BUCKETS colours, dim → bright hue offset
 */
function galaxyColours() {
  const hq = Math.round(bgHue / TIMELINE_HUE_STEP) * TIMELINE_HUE_STEP;
  const base = palette[2] || '#7209b7';
  const key = `${hq}|${base}`;
  if (galaxyPalette && galaxyPalette.key === key) return galaxyPalette.colours;
  const colours = [];
  for (let i = 0; i < GALAXY_HUE_BUCKETS; i += 1) {
    // Mirrors the particle hue spread: (i/count)*90 - 45.
    const hue = (i / (GALAXY_HUE_BUCKETS - 1)) * 90 - 45;
    colours.push(shiftHex(base, hq + hue));
  }
  galaxyPalette = { key, colours };
  return colours;
}

function drawGalaxy(now, w, h, life) {
  ctx.globalCompositeOperation = 'lighter';
  const cx = w / 2;
  const cy = h * 0.44;
  const spin = now * 0.00006 + beatFlash * 0.05;
  const spread = Math.min(w, h) * (0.42 + life * 0.10 + beatFlash * 0.04);
  const step = Math.max(1, Math.round(1 / Math.max(0.4, quality))); // thin out when slow
  const colours = galaxyColours();
  const twBase = 0.10 + life * 0.16;
  for (let gi = 0; gi < galaxy.length; gi += step) {
    const p = galaxy[gi];
    const a = p.ang + spin;
    const r = p.rad * spread;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.72; // slight tilt → disc, not flat ring
    const tw = 0.5 + 0.5 * Math.sin(now * 0.002 + p.tw);
    // Alpha rides globalAlpha instead of being baked into a fresh colour string.
    ctx.globalAlpha = Math.min(1, twBase * tw + beatFlash * 0.12);
    ctx.fillStyle = colours[p.bucket];
    // fillRect over beginPath+arc+fill, the same trade the stars layer already
    // makes below — these dots are a few px and the shape is not readable.
    // Sized by EQUAL AREA, not equal width: a square of side 2r covers 27% more
    // than the circle it replaces, which made the galaxy read heavier than it
    // used to. sqrt(pi)/2 ≈ 0.886 restores the original weight.
    const d = (0.8 + p.rad * 1.6 + beatFlash * 1.2) * DOT_SQUARE_SCALE;
    ctx.fillRect(x - d / 2, y - d / 2, d, d);
  }
  ctx.globalAlpha = 1;
}

/* ---- wormhole ----

   A tunnel flying toward the viewer: rings travel from a vanishing point out
   past the corners, each one rotated a little further than the last so the
   whole thing reads as twisting.

   The perspective is what sells it. Radius goes as z², so rings bunch up near
   the throat and accelerate as they approach the edge — linear spacing looks
   like concentric circles expanding, not like travel.

   Geometry is seeded once and recycled (z wraps past 1), so the draw loop
   allocates nothing. Cost is one ellipse stroke per ring.

   This is also where anticipation pays off best: the tunnel tightens and speeds
   up before a drop the stored heat map already knows about, so the acceleration
   leads the music instead of reacting to it. */
const WORMHOLE_RINGS = 26;

/** Vapour blobs drifting inside the tunnel — what gives it volume. */
const WORMHOLE_WISPS = 22;

/** @type {Array<{z: number, twist: number, squash: number, band: number}>} */
let wormholeRings = [];
/** @type {Array<{z: number, angle: number, spin: number, radial: number, scale: number}>} */
let wormholeWisps = [];
/** Accumulated tunnel roll (radians), kept across frames so it never jumps. */
let wormholeSpin = 0;

function seedWormhole() {
  wormholeRings = Array.from({ length: WORMHOLE_RINGS }, (_, i) => ({
    // Evenly spaced in depth, so the tunnel is continuous from the first frame.
    z: i / WORMHOLE_RINGS,
    twist: (i / WORMHOLE_RINGS) * Math.PI * 2,
    // A little per-ring variation, so it reads as a rough tunnel not a machine.
    squash: 0.78 + Math.random() * 0.10,
    // Which of the pre-rendered vapour bands this ring wears. Three distinct
    // shapes recycling through the tunnel is enough to stop the eye finding the
    // repeat, and costs three bitmaps instead of twenty-six.
    band: i % SMOKE_BANDS,
  }));
  wormholeWisps = Array.from({ length: WORMHOLE_WISPS }, () => ({
    z: Math.random(),
    angle: Math.random() * Math.PI * 2,
    // Own slow roll, so the smoke inside the tunnel does not turn as one rigid
    // body with the walls.
    spin: (Math.random() - 0.5) * 0.00022,
    // How far out toward the wall it sits. Kept off both the centre and the
    // rim: on the axis it would just thicken the throat glow, and on the rim it
    // would read as a lumpy ring rather than as something floating inside.
    radial: 0.34 + Math.random() * 0.5,
    scale: 0.5 + Math.random() * 0.85,
  }));
}

/* -------------------------------------------------------- smoke ring sprites */
/*
  The tunnel used to be drawn as ellipse strokes, which is why it read as a
  stack of neon hoops rather than as something you are flying through. Smoke
  cannot be stroked: it has no edge, and softening a stroke by widening and
  dimming it (what the previous version did) only fades the line — it does not
  make it volumetric.

  So each band is pre-rendered once into a bitmap, with real Gaussian blur, and
  blitted per ring. Three wins at once:

    - it is genuinely soft, because `filter: blur()` is affordable when it runs
      three times per colour instead of twenty-six times per frame;
    - scaling a 256px bitmap up to a near ring is *itself* a blur, so the rings
      that fill the screen are the softest ones — which is exactly how depth of
      field behaves and the opposite of what a stroke does;
    - it is one `drawImage` per ring against one large ellipse path + stroke,
      so the layer got cheaper while getting denser.

  Irregular arc segments rather than a closed ring are what keep it from
  reading as a donut: gaps let the band behind show through the one in front.
*/
const SMOKE_BANDS = 3;
const SMOKE_SIZE = 256;

/** @type {{key: string, bands: HTMLCanvasElement[]}|null} */
let smokeCache = null;

/**
 * Pre-render the vapour bands for one colour pair.
 *
 * Keyed on the *quantised* colours, never on `accentLive`/`tintLive` — those
 * are `shiftHex(...)` of a hue that moves every frame, so keying on them would
 * rebuild the cache continuously and save nothing. This trap has been hit
 * before in this file; see `quantisedColours()`.
 *
 * @param {string} accent hex
 * @param {string} tint hex
 * @returns {HTMLCanvasElement[]} one canvas per band
 */
function smokeBands(accent, tint) {
  const key = `${accent}|${tint}`;
  if (smokeCache && smokeCache.key === key) return smokeCache.bands;

  const mid = SMOKE_SIZE / 2;
  const bands = [];
  for (let b = 0; b < SMOKE_BANDS; b += 1) {
    const c = document.createElement('canvas');
    c.width = c.height = SMOKE_SIZE;
    const g = c.getContext('2d');
    const colour = b % 2 === 0 ? accent : tint;

    // Heavy blur on the wide, faint underlayer and a lighter one on the wisps
    // that ride on top. The two-pass split is what stops it looking like a
    // uniformly fogged circle: there is still structure inside the softness.
    for (let pass = 0; pass < 2; pass += 1) {
      g.filter = pass === 0 ? 'blur(9px)' : 'blur(4px)';
      // The detail pass carries most of the *shape*; the wide pass is only the
      // haze it sits in. Weighting them the other way round reads as fog with a
      // circle in it rather than as smoke with structure.
      g.strokeStyle = hexA(colour, pass === 0 ? 0.19 : 0.17);
      g.lineCap = 'round';

      const arcs = pass === 0 ? 5 : 9;
      for (let i = 0; i < arcs; i += 1) {
        // Deterministic per band so a rebuild after a colour change does not
        // reshuffle the tunnel's shape in front of the user.
        const seed = (b * 37 + i * 61 + pass * 13) % 100 / 100;
        const start = seed * Math.PI * 2;
        const extent = (0.5 + seed * 1.6) * (pass === 0 ? 1.5 : 0.8);
        /*
          Vapour sits well out toward the sprite's rim, and the band is narrow.
          The first version put it at 0.62 with a 30px band and 13px of blur:
          once a near ring is scaled to ~1300px across, that inward spill covers
          the middle of the screen, and with `lighter` compositing a dozen rings
          doing it at once saturated the whole viewport into a flat wall of
          colour. The tunnel needs its hole to stay open — that hole IS the
          tunnel.
        */
        const radius = mid * (0.76 + seed * 0.12);
        g.lineWidth = (pass === 0 ? 19 : 8) * (0.7 + seed * 0.7);
        g.beginPath();
        g.arc(mid, mid, radius, start, start + extent);
        g.stroke();
      }
    }
    g.filter = 'none';
    bands.push(c);
  }

  smokeCache = { key, bands };
  return bands;
}

/**
 * Draw the wormhole.
 * @param {number} w @param {number} h @param {number} dt frame delta (ms)
 * @param {number} life overall energy 0..1
 */
function drawWormhole(w, h, dt, life) {
  if (wormholeRings.length === 0) seedWormhole();

  const cx = w / 2;
  const cy = h * 0.44;
  // Past the corners, so rings leave the screen rather than stopping at it.
  const maxR = Math.hypot(w, h) * 0.62;

  /*
    Travel speed. The beat gives it a pulse, a drop punches it, and
    anticipation winds it up BEFORE the drop — the tunnel is leaning into
    something that has not happened yet.
  */
  const speed = (0.00011 + baseEnergy * 0.00009 + life * 0.00010)
    * (1 + beatFlash * 0.8 + dropFlash * 2.4 + anticipation * 1.6);
  wormholeSpin += dt * 0.00006 * (1 + anticipation * 2.2 + dropFlash * 1.5);

  // Anticipation also narrows the throat, so the tunnel visibly constricts.
  const squeeze = 1 - anticipation * 0.22;

  const q = quantisedColours();
  const bands = smokeBands(q.accent, q.tint);
  ctx.globalCompositeOperation = 'lighter';

  for (let i = 0; i < wormholeRings.length; i += 1) {
    const ring = wormholeRings[i];
    ring.z += dt * speed;
    if (ring.z >= 1) ring.z -= 1;

    const z = ring.z;
    const r = maxR * z * z * squeeze;
    if (r < 1) continue;

    /*
      Near rings must be the brightest and heaviest thing on screen — that
      contrast against the dim throat IS the depth cue. An earlier version faded
      them out as they grew, which flattened the whole tunnel into a target.

      They need almost no fade-out, because `maxR` is past the corners: a ring
      leaves the viewport at about z = 0.9, so fading only over the last tenth
      removes the recycle pop without ever dimming a ring you can still see.
    */
    /*
      Fading starts much earlier than the stroke version needed (z ≈ 0.72 rather
      than 0.9). A stroke that big is a thin line mostly off screen and costs
      nothing to leave at full brightness; a vapour band that big is a
      screen-filling cloud, and a stack of them on `lighter` reaches saturation
      long before they leave the viewport.
    */
    const fade = Math.min(1, z * 6) * Math.min(1, (1 - z) * 3.6);
    // Brighter than the transparent-background version needed. Over a bare
    // desktop the smoke only had to exist; over the (thinned) field it has to
    // win, and `lighter` compositing against a lit background costs contrast.
    const alpha = (0.10 + z * 0.44) * fade * (0.55 + life * 0.6);
    if (alpha < 0.01) continue;

    /*
      One blit per band, scaled to the ring's radius and rotated with depth —
      the rotation growing with z is what makes the tunnel look twisted rather
      than like a stack of hoops.

      The sprite is drawn at 1.55× the ring radius on purpose. The vapour in it
      sits at ~0.62 of the sprite's half-width, so this puts the *dense part* of
      the band on the ring's radius and lets the soft falloff spill inside and
      outside it, which is where the sense of depth in the fog comes from.
    */
    const draw = r * 1.55;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ring.twist + wormholeSpin + z * 2.6);
    ctx.scale(1, ring.squash);
    ctx.drawImage(bands[ring.band], -draw, -draw, draw * 2, draw * 2);
    ctx.restore();
  }

  /*
    Vapour inside the tunnel.

    Rings alone — however soft — still describe a *surface*. The wisps are what
    make the space between the walls look occupied, and they are what separates
    "a smoky tunnel" from "a soft tunnel". They travel on the same z² curve as
    the rings so they share the perspective, and they use the glow sprite that
    is already cached for the throat, so the whole effect adds one blit each.
  */
  const glowSprite = accentGlow(q.accent);
  for (let i = 0; i < wormholeWisps.length; i += 1) {
    const wisp = wormholeWisps[i];
    wisp.z += dt * speed * 0.86;   // slightly slower than the walls: parallax
    if (wisp.z >= 1) wisp.z -= 1;
    wisp.angle += dt * wisp.spin * (1 + dropFlash * 2);

    const z = wisp.z;
    const r = maxR * z * z * squeeze;
    const fade = Math.min(1, z * 5) * Math.min(1, (1 - z) * 3.2);
    const alpha = (0.04 + z * 0.14) * fade * (0.5 + life * 0.7);
    if (alpha < 0.01) continue;

    const a = wisp.angle + wormholeSpin + z * 2.6;
    const px = cx + Math.cos(a) * r * wisp.radial;
    const py = cy + Math.sin(a) * r * wisp.radial * 0.82;
    // Capped against the viewport, not just scaled with r: a near wisp sized off
    // an off-screen radius becomes a 350px blob and stops reading as something
    // floating inside the tunnel.
    const size = Math.min(Math.max(6, r * 0.20 * wisp.scale), Math.min(w, h) * 0.16);

    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(glowSprite, px - size, py - size, size * 2, size * 2);
  }

  // The throat: a bright core so the vanishing point reads as somewhere the
  // tunnel is coming FROM. Uses the cached glow sprite, so it is one blit.
  const glowR = Math.min(w, h) * (0.08 + beatFlash * 0.03 + anticipation * 0.06);
  ctx.globalAlpha = Math.min(1, 0.20 + beatFlash * 0.22 + anticipation * 0.3);
  ctx.drawImage(accentGlow(q.accent), cx - glowR, cy - glowR, glowR * 2, glowR * 2);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
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

/**
 * Pick a drawing-buffer scale for the swirl field from what the last frames
 * actually cost, and apply it if it changed.
 *
 * Resizing a WebGL drawing buffer reallocates it, so this must not chase the
 * cost signal continuously. Two things prevent thrashing: a coarse ladder (four
 * rungs, not a continuum) and asymmetric thresholds — drop a rung as soon as
 * frames run long, climb back only when there is real headroom, never faster
 * than once a second.
 *
 * This is what lets the field stay big and fluid during a drop: instead of
 * cutting the effect, the same effect is rendered into fewer pixels and blown
 * back up. On a soft field that reads as slightly softer, not as "the visuals
 * turned off".
 *
 * @param {number} now
 */
function applySwirlScale(now) {
  const ceiling = liteMode ? 1 : SWIRL_SCALES.length - 1;
  let rung = SWIRL_SCALES.indexOf(swirlScale);
  if (rung < 0) rung = ceiling;

  /*
    Driven by the PRESENTED frame interval, not by how long our JavaScript took.
    An earlier version of this used the CPU cost and never fired once: the whole
    backdrop costs ~5ms, so a ">15ms" trigger could not be reached even while
    the app was visibly dropping frames. Resolution is a GPU lever and needs a
    GPU signal.

    22ms is ~45fps (shed pixels), 13ms is ~77fps (enough headroom to earn one
    back). The asymmetry plus the one-second floor stops it hunting.
  */
  /*
    0.21.0: the drop is rate-limited too, which the comment above always
    claimed and the code never did. Profiling a real song put `resize` at
    289ms of self time — for a function that reallocates a WebGL drawing
    buffer and should fire a handful of times a session. Unguarded, one long
    frame dropped a rung, the reallocation cost another long frame, and that
    dropped the next rung: the governor was feeding itself, and each round
    trip was a visible hitch. 300ms still sheds pixels within a few frames of
    a genuine sag, while one bad frame now costs one reallocation instead of
    three.
  */
  if (frameIntervalMs > 22 && rung > 0 && now - lastSwirlScaleAt > 300) {
    rung -= 1;
    lastSwirlScaleAt = now;
  } else if (frameIntervalMs < 13 && rung < ceiling && now - lastSwirlScaleAt > 1000) {
    rung += 1;
    lastSwirlScaleAt = now;
  }

  const next = SWIRL_SCALES[Math.min(rung, ceiling)];
  if (next === swirlScale) return;
  swirlScale = next;
  window.SwirlField.resize(window.innerWidth, window.innerHeight, next);
}

/**
 * Render the GPU cloud. Shared by the full backdrop and by Ghost mode, which
 * draws nothing else at all.
 *
 * @param {number} now
 * @param {number} dt frame delta (ms)
 * @param {number} life 0..1 energy envelope
 * @param {number} alpha field opacity, already thinned for any cover photo
 * @param {object} style per-preset shader biases
 * @param {number} bass 0..1 live bass envelope (0 when capture is off)
 * @param {string} tintLive base tint for this frame
 * @param {string} accentLive accent for this frame
 */
/**
 * Which MilkDrop preset should be showing for this visual look — the ONE place
 * that decides, so the engine-init path and the steady-state path cannot
 * disagree.
 *
 * Precedence: a pin (this song, persisted) beats a session choice (a click or
 * the dice) beats the look's own starting preset, falling back to a curated
 * default so a look never opens on a dud.
 *
 * THE BUG THIS FIXES. A session choice must survive an *engine bounce*. The
 * FPS governor swaps MilkDrop for the cheap swirl preset whenever the frame
 * rate dips below 24 — which happens constantly, because MilkDrop is
 * GPU-heavy — and swaps back when it recovers. The old init path cleared
 * `milkdropChosen` on every such re-entry, so a preset you picked reverted to
 * the look's seed a second or two later, for no reason you could see. The reset
 * now happens ONLY when the visual look itself changes (a different `preset.id`),
 * not when the same look's engine restarts.
 *
 * @param {object} preset the visual look being rendered
 * @returns {string|null} the preset name to show
 */
function milkdropTargetFor(preset) {
  if (preset.id !== milkdropSeededFor) {
    // A genuinely new look: its starting point is the new intent, and any
    // session choice belonged to the previous look.
    milkdropSeededFor = preset.id;
    milkdropChosen = null;
    milkdropWanted = preset.milkdrop;
  }
  const seed = (milkdropWanted && window.MilkDrop.names().includes(milkdropWanted))
    ? milkdropWanted
    : milkdropDefault();
  return pinnedMilkdrop() || milkdropChosen || seed;
}

/**
 * Put the right engine on screen, and draw it if it is the MilkDrop one.
 *
 * The swirl field is rendered further down the backdrop loop, where it can be
 * thinned against a cover photo and a solo look. MilkDrop has nothing to thin
 * against — it owns the screen — so it is simplest to draw it here, next to the
 * decision that selects it.
 *
 * @param {object} preset the preset actually being rendered
 * @param {number} now rAF timestamp
 * @param {number} dt frame delta (ms)
 * @param {number} w @param {number} h CSS pixels
 */
function applyEngine(preset, now, dt, w, h) {
  if (!window.MilkDrop || !els.milkdrop) return;
  const wanted = preset.engine === 'milkdrop' ? 'milkdrop' : 'swirl';

  if (wanted !== activeEngine) {
    activeEngine = wanted;
    document.body.classList.toggle('engine-milkdrop', wanted === 'milkdrop');
    if (els.mdBtn) els.mdBtn.hidden = wanted !== 'milkdrop';
    if (wanted === 'milkdrop') {
      els.milkdrop.hidden = false;
      window.MilkDrop.init(els.milkdrop);
      window.MilkDrop.resize(w, h);
      milkdropSize = `${Math.floor(w)}x${Math.floor(h)}`;
      // Cut rather than blend on the way in: there is nothing to blend FROM,
      // and a fade from black reads as the app being slow to start. The target
      // respects a pin and a session choice — see milkdropTargetFor for why
      // that matters here specifically.
      milkdropName = window.MilkDrop.loadPreset(milkdropTargetFor(preset), 0);
      lastMilkdropSwitchAt = now;
    } else {
      window.MilkDrop.destroy();
      els.milkdrop.hidden = true;
      closeMilkdropPanel();
    }
  }

  if (activeEngine !== 'milkdrop') return;

  /*
    The engine reports whether it is actually alive only once its frame has
    loaded and parsed the preset packs — WebGL2 support, a bundle that failed to
    load and a pack that would not parse are all invisible from out here. Until
    then, draw nothing and keep the frame hidden-but-present so it can finish
    starting. It settles within a second of the first switch.
  */
  if (!window.MilkDrop.isSupported()) return;

  const pinned = pinnedMilkdrop();
  const want = milkdropTargetFor(preset);

  if (want && want !== milkdropName && now - lastMilkdropSwitchAt > 500) {
    // An explicit choice cuts; an automatic one blends.
    milkdropName = window.MilkDrop.loadPreset(want, (pinned || milkdropChosen) ? 0 : 2.7);
    lastMilkdropSwitchAt = now;
  }

  /*
    Beat-synced transitions, borrowed from Plane9 — cutting on a drop rather
    than on a timer is most of why a visualiser feels alive rather than like a
    screensaver on shuffle.

    Gated on a real drop AND a long cooldown. A MilkDrop preset needs time to
    develop, so cutting on every drop in a four-on-the-floor track would be a
    strobe rather than a sequence.
  */
  if (!pinned && !milkdropChosen
      && dropFlash > 0.6 && now - lastMilkdropSwitchAt > MILKDROP_SWITCH_MS) {
    /* Hidden presets are excluded here, not only from the browser. This is
       where an unwanted preset actually turns up, so a veto that did not reach
       it would be a bookmark rather than a veto.

       Liked presets, when there are any, are the only ones the cycle draws
       from — the fastest way to make 1754 looks feel curated is to let someone
       curate them. */
    const all = milkdropCyclePool();
    if (all.length > 1) {
      const i = all.indexOf(milkdropName);
      // Recorded as the new intent, not just loaded — otherwise the block above
      // reverts it on the next frame.
      milkdropWanted = all[(i + 1) % all.length];
      // Cross-fade over a musical phrase, not a fixed 2.7s. Fading across four
      // beats lands the transition on a bar boundary, so the new preset arrives
      // *with* the music rather than at an arbitrary wall-clock offset. The
      // beat clock is always running (estimated or tempo-locked), so this
      // scales from slow to fast tracks. Clamped so a half/double-time estimate
      // cannot produce an instant cut or a fade that outlives the cooldown.
      const phraseBlend = Math.max(1.2, Math.min(3.2, (beatPeriodMs * 4) / 1000));
      milkdropName = window.MilkDrop.loadPreset(milkdropWanted, phraseBlend);
      lastMilkdropSwitchAt = now;
      markMilkdropSeen(milkdropWanted);
      setStatus(`MilkDrop — ${milkdropName}`);
    }
  }

  // Resize crosses a frame boundary, so it is sent only on a real change rather
  // than every frame — the CSS already stretches the frame itself.
  const size = `${Math.floor(w)}x${Math.floor(h)}`;
  if (size !== milkdropSize) {
    milkdropSize = size;
    window.MilkDrop.resize(w, h);
  }

  window.MilkDrop.render(dt / 1000);
}

function renderSwirl(now, dt, life, alpha, style, bass, tintLive, accentLive) {
  if (!swirlOn) return;

  // Ease the drive toward its target so spirals wind up and unwind smoothly.
  // Opening up is slower than calming down: a drop should be able to snap the
  // field shut, but the big swirl should bloom in, not pop.
  const target = swirlTarget(estimatePosition());
  const rate = target > swirlDrive ? 0.020 : 0.055;
  swirlDrive += (target - swirlDrive) * (1 - Math.pow(1 - rate, dt / 16));

  applySwirlScale(now);
  window.SwirlField.setQuality(liteMode ? 0.5 : quality);

  /*
    Per-preset percussion gain. A look that draws nothing else (Ghost) needs the
    field itself to carry the drums, because every other reactive element lives
    on the 2D canvas it switched off. Looks that keep those layers stay at 1 so
    the field does not fight them.

    Values above 1 are safe: every term the shader feeds these into is either
    additive or a small subtraction from a scale factor.
  */
  const kick = style && style.kick ? style.kick : 1;

  window.SwirlField.render({
    timeMs: now,
    palette: [tintLive, palette[1], palette[2], accentLive],
    alpha,
    life,
    swirl: swirlDrive,
    buildup,
    drop: dropFlash * kick,
    beat: beatFlash * kick,
    bass: bass * kick,
    /*
      Deep-space starfield, rendered on the GPU inside the swirl shader — a new
      depth layer that costs the CPU nothing, where the old star/galaxy layers
      cost one draw call per point. Kept subtle and lifted by energy so it reads
      as depth behind the liquid, and pulled back hard for a solo/bare look that
      wants the field and nothing else. (The phyllotaxis galaxy on the 2D canvas
      is untouched; porting that faithfully is the larger remaining half of the
      GPU-layer move — see NEXT_STEPS.)
    */
    stars: (style && style.bare) ? 0 : Math.min(1, 0.4 + life * 0.45),
    /*
      The phyllotaxis galaxy, now drawn on the GPU. Only for looks that asked
      for it (scene.galaxy) — the same gate the CPU version had — so nothing
      changes about WHICH presets show it, only where it is computed.
    */
    galaxy: scene.galaxy ? 1 : 0,
    // Per-preset character, so the field changes with the look instead of
    // staying identical underneath every one of them.
    style,
  });
}

/* ------------------------------------------------- the learned song, drawn */

/*
  Timeline geometry, in viewport fractions.

  The song reads as a skyline along the bottom edge rather than a ring around
  the lyrics. A ring puts the loudest part of the song at whatever angle the
  clock happens to point at, which is a poor way to compare two moments, and it
  competes with the text for the middle of the screen. Left-to-right is how
  everyone already reads a track, and the bottom strip is space the lyrics were
  never using.

  The dancers roam down to 0.96, so they stand in front of the skyline. That is
  deliberate: the bar becomes the floor they dance on.
*/
const TIMELINE_BASE_Y = 0.965;
const TIMELINE_MAX_H = 0.10;
const TIMELINE_LEFT = 0.04;
const TIMELINE_RIGHT = 0.96;

/** A `drop` section closer than this gets a countdown on the timeline. */
const COUNTDOWN_WINDOW_MS = 8000;

/** Last measured structure-label width, keyed by the string it belongs to. */
let labelWidthCache = { text: '', width: 0 };

/**
 * The live accent/tint, snapped to a hue bucket.
 *
 * Everything cached by colour has to key on a value that actually holds still.
 * `accentLive` does not — it is `shiftHex(accent, bgHue)` and the hue drifts
 * continuously, so keying on it rebuilt every few frames and cached almost
 * nothing. (Measured: the timeline bitmap was being rebuilt on ~20% of frames.)
 *
 * Snapping the hue first is the same trade the lyric CSS variable already makes
 * at 3°: the cached art's hue lags by up to one bucket, which is invisible on a
 * soft fade and worth 60× fewer rebuilds. Live colours are still used for the
 * crisp elements drawn on top — the playhead, the label, the tonearm.
 *
 * @returns {{key: string, accent: string, tint: string}}
 */
function quantisedColours() {
  const hq = Math.round(bgHue / TIMELINE_HUE_STEP) * TIMELINE_HUE_STEP;
  const base = (palette && palette[3]) || '#e94560';
  return {
    key: `${hq}|${base}|${baseTint}`,
    accent: shiftHex(base, hq),
    tint: shiftHex(baseTint, hq * 0.5),
  };
}

/**
 * Draw the song as a timeline of cells along the bottom edge.
 *
 * Each cell is one slice of the track, so the whole song is visible at once:
 * the played part is lit and the part still to come is drawn from what was
 * learned on an earlier listen. That is the point of the mode — on a replay you
 * can see the drop coming.
 *
 * Cells never heard are drawn as a faint stub rather than skipped, so a song
 * heard once reads as "not known yet" instead of broken. A song never heard at
 * all draws nothing, because a row of 96 identical stubs is not information.
 *
 * @param {number} w @param {number} h
 * @param {string} accent @param {string} tint
 */
/*
  The timeline is pre-rendered to a bitmap and blitted, the same idiom the glow
  sprites and the vignette already use in this file.

  Drawing it live cost 96 fillRects every frame — measured at 164 per frame in
  Heatmap against Liquid's 69 — to produce a picture that changes only when a
  bin is learned or the window resizes.

  The played/unplayed split does NOT go in the bitmap. Dimming is a single
  uniform multiplier on alpha, so one bitmap drawn at full strength and blitted
  twice — the played part at 1.0, the rest at DIM — is pixel-identical to
  baking two variants, and keeps the playhead out of the cache key.

  The hue is quantised because `accentLive` drifts continuously with `bgHue`;
  keying the cache on the exact colour would rebuild every frame and cache
  nothing. 12° is about one rebuild a second at normal drift, against 60.
*/
const TIMELINE_DIM = 0.44;
const TIMELINE_HUE_STEP = 12;

/** @type {{canvas: HTMLCanvasElement, key: string, left: number, baseY: number, span: number, maxH: number}|null} */
let timelineSprite = null;

/**
 * Build (or reuse) the timeline bitmap for the current map, size and colour.
 * @param {Array} cells @param {number} w @param {number} h
 * @returns {{canvas: HTMLCanvasElement, left: number, baseY: number, span: number, maxH: number}}
 */
function timelineBitmap(cells, w, h) {
  const q = quantisedColours();
  const key = `${window.HeatMap.revision()}|${w}|${h}|${q.key}`;
  if (timelineSprite && timelineSprite.key === key) return timelineSprite;
  const { accent, tint } = q;

  const n = cells.length;
  const left = w * TIMELINE_LEFT;
  const span = w * (TIMELINE_RIGHT - TIMELINE_LEFT);
  const maxH = h * TIMELINE_MAX_H;
  const baseY = h * TIMELINE_BASE_Y;
  const cellW = span / n;
  const gap = Math.min(2.5, cellW * 0.24);

  const canvas = (timelineSprite && timelineSprite.canvas) || document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(span));
  canvas.height = Math.max(1, Math.ceil(maxH));
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < n; i += 1) {
    const c = cells[i];
    // Height carries energy; brightness (applied at blit time) carries how far
    // the playhead has reached — so the strip reads as a shape AND a position.
    const barH = c.known ? Math.max(2, maxH * (0.05 + c.level * 0.95)) : 2;
    const alpha = c.known ? 0.22 + c.level * 0.62 : 0.08;
    // Bass-heavy slices lean to the accent, bright ones to the secondary tint.
    g.fillStyle = hexA(c.bass >= c.treble ? accent : tint, alpha);
    g.fillRect(i * cellW + gap / 2, maxH - barH, Math.max(1, cellW - gap), barH);
  }

  timelineSprite = { canvas, key, left, baseY, span, maxH };
  return timelineSprite;
}

function drawHeatmap(w, h, accent, tint) {
  if (!window.HeatMap) return;
  const cells = window.HeatMap.cells();
  if (cells.length === 0) return;
  if (window.HeatMap.coverage() <= 0) return;   // nothing learned; say nothing

  const sprite = timelineBitmap(cells, w, h);
  const { canvas, left, baseY, span, maxH } = sprite;

  const played = durationMs > 0
    ? Math.max(0, Math.min(1, estimatePosition() / durationMs))
    : 0;
  const headX = left + played * span;
  const headPx = Math.round(played * canvas.width);
  const top = baseY - maxH;

  ctx.globalCompositeOperation = 'lighter';
  // Played: full strength.
  if (headPx > 0) {
    ctx.drawImage(canvas, 0, 0, headPx, canvas.height, left, top, headPx, maxH);
  }
  // Still to come: the same pixels, dimmed.
  const restPx = canvas.width - headPx;
  if (restPx > 0) {
    ctx.globalAlpha = TIMELINE_DIM;
    ctx.drawImage(canvas, headPx, 0, restPx, canvas.height,
      left + headPx, top, restPx, maxH);
    ctx.globalAlpha = 1;
  }

  // The playhead: a bright tick standing clear of the tallest cell.
  ctx.strokeStyle = hexA(accent, 0.9);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headX, baseY + 3);
  ctx.lineTo(headX, baseY - maxH * 1.12);
  ctx.stroke();

  ctx.globalCompositeOperation = 'source-over';
  drawSongStructure(headX, left, span, baseY, maxH, accent);
}

/**
 * Name the part of the song being played, and count down to the next drop.
 *
 * Only drawn once enough of the track has been heard for the sections to mean
 * anything — `HeatMap.sections()` returns nothing before then, so a half-learned
 * song stays quiet rather than labelling a guess.
 *
 * @param {number} headX playhead x (px)
 * @param {number} left @param {number} span @param {number} baseY @param {number} maxH
 * @param {string} accent
 */
function drawSongStructure(headX, left, span, baseY, maxH, accent) {
  const sections = window.HeatMap.sections();
  if (sections.length === 0 || durationMs <= 0) return;

  const pos = estimatePosition();
  const toX = (ms) => left + Math.max(0, Math.min(1, ms / durationMs)) * span;

  // Boundary ticks, so the shape reads as sections rather than one long graph.
  ctx.strokeStyle = hexA(accent, 0.28);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < sections.length; i += 1) {
    const x = toX(sections[i].startMs);
    ctx.moveTo(x, baseY + 2);
    ctx.lineTo(x, baseY - maxH * 0.28);
  }
  ctx.stroke();

  const here = sections.find((s) => pos >= s.startMs && pos < s.endMs);
  const nextDrop = sections.find((s) => s.kind === 'drop' && s.startMs > pos);
  const toDropMs = nextDrop ? nextDrop.startMs - pos : Infinity;

  // A countdown outranks the label: knowing a drop is four seconds away is
  // worth more than being told the current bar is a verse.
  const text = toDropMs < COUNTDOWN_WINDOW_MS
    ? `drop in ${(toDropMs / 1000).toFixed(1)}s`
    : (here ? here.kind : '');
  if (!text) return;

  const labelY = baseY - maxH * 1.12 - 10;
  ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  /*
    Keep the label on screen when the playhead is near either end. The width is
    cached against the string: `measureText` forces a text-shaping pass, and the
    countdown only ever shows one decimal, so this label takes at most ten
    distinct values a second while being drawn sixty times.
  */
  if (text !== labelWidthCache.text) {
    labelWidthCache = { text, width: ctx.measureText(text).width };
  }
  const tw = labelWidthCache.width;
  const x = Math.max(left + tw / 2, Math.min(left + span - tw / 2, headX));
  ctx.fillStyle = hexA(accent, toDropMs < COUNTDOWN_WINDOW_MS ? 0.95 : 0.5);
  ctx.fillText(text.toUpperCase(), x, labelY);
  ctx.textAlign = 'start';
}

/*
  Vinyl — the cover art as a record on a deck.

  It turns the whole time the song plays, at a rate the music sets: one
  revolution every four beats once the tempo has locked, which at ordinary
  tempos lands near a real platter's 33⅓ rpm. That is the difference between a
  record and a progress dial — it is moving because the music is, not because
  the song is a certain fraction done. The timeline along the bottom is what
  says where in the track you are.

  Parked to the left rather than centred, so the artwork mostly stays clear of
  the lyric. Only mostly: lyric lines are 80vw centred, so a long one reaches
  x≈10vw and will cross the platter's top-right. That is accepted — the artwork
  is the point of the mode, and the lyric carries its own shadow. If it ever
  reads badly, the platter's 0.82 alpha is the lever, not the radius.
*/
const VINYL_CX = 0.22;
const VINYL_CY = 0.42;
const VINYL_R = 0.26;
/** Label radius as a share of the platter. A real 7" is nearer 0.33, but the
    cover art is the subject here and at that ratio it read as a coaster. */
const VINYL_LABEL_RATIO = 0.42;
/** Fallback revolution time (ms) with no measured tempo: 33⅓ rpm. */
const VINYL_IDLE_PERIOD_MS = 1800;

/** Accumulated platter angle (radians). Kept across frames so tempo changes
    never cause a visible jump — a record does not teleport. */
let vinylAngle = 0;

/** @type {{platter: HTMLCanvasElement, sheen: HTMLCanvasElement, key: string}|null} */
let vinylSprites = null;

/**
 * Pre-rendered platter (body + grooves) and sheen, both square and centred so
 * the caller can rotate the sheen about the middle.
 *
 * Rebuilt only when the radius or the quantised colour changes — the hue drifts
 * continuously, so an exact-colour key would cache nothing.
 *
 * @param {number} R platter radius (px)
 * @returns {{platter: HTMLCanvasElement, sheen: HTMLCanvasElement}}
 */
function vinylBitmaps(R) {
  const size = Math.max(2, Math.ceil(R * 2));
  const q = quantisedColours();
  const key = `${size}|${q.key}`;
  if (vinylSprites && vinylSprites.key === key) return vinylSprites;
  const { accent, tint } = q;

  const make = () => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  };
  const platter = (vinylSprites && vinylSprites.platter) || make();
  const sheen = (vinylSprites && vinylSprites.sheen) || make();
  for (const c of [platter, sheen]) { c.width = size; c.height = size; }

  const mid = size / 2;
  const r = size / 2;

  // Body: near-black rather than black, so it reads as an object on a
  // transparent overlay instead of a hole punched in the desktop.
  const pg = platter.getContext('2d');
  pg.fillStyle = '#0a0a0e';
  pg.beginPath();
  pg.arc(mid, mid, r, 0, Math.PI * 2);
  pg.fill();
  // Grooves: concentric, so rotating them would be invisible anyway.
  pg.strokeStyle = hexA(tint, 0.20);
  pg.lineWidth = 1;
  pg.globalAlpha = 0.5;
  for (let gr = r * 0.42; gr < r * 0.97; gr += Math.max(3, r * 0.055)) {
    pg.beginPath();
    pg.arc(mid, mid, gr, 0, Math.PI * 2);
    pg.stroke();
  }

  // Sheen: the light catching the disc, baked along one axis. Rotating this
  // bitmap is what reads as the platter turning.
  const sg = sheen.getContext('2d');
  const grad = sg.createLinearGradient(size, mid, 0, mid);
  grad.addColorStop(0, hexA(tint, 0.28));
  grad.addColorStop(0.5, hexA(accent, 0.04));
  grad.addColorStop(1, hexA(tint, 0));
  sg.fillStyle = grad;
  sg.beginPath();
  sg.arc(mid, mid, r * 0.98, 0, Math.PI * 2);
  sg.fill();

  vinylSprites = { platter, sheen, key };
  return vinylSprites;
}

/**
 * Draw the spinning record.
 * @param {number} w @param {number} h @param {number} dt frame delta (ms)
 * @param {string} accent @param {string} tint
 */
function drawVinyl(w, h, dt, accent, tint) {
  const cx = w * VINYL_CX;
  const cy = h * VINYL_CY;
  const R = Math.min(w, h) * VINYL_R;

  /*
    Four beats per revolution while the tempo is locked, clamped so a half- or
    double-time reading cannot spin the platter absurdly. A drop nudges it
    forward — the scratch a DJ puts in by hand.
  */
  const revMs = tempoLocked
    ? Math.max(1200, Math.min(2600, beatPeriodMs * 4))
    : VINYL_IDLE_PERIOD_MS;
  vinylAngle += (dt / revMs) * Math.PI * 2 * (1 + dropFlash * 0.9);

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  /*
    Body, grooves and sheen come from two pre-rendered bitmaps.

    Drawn live they cost ~11 arc strokes and a fresh linear gradient every
    frame — measured at 31 arcs per frame in Vinyl against Liquid's 16 — for a
    disc whose only moving parts are the sheen's angle and the label. The sheen
    is baked flat and ROTATED at blit time, which is the same picture for one
    drawImage instead of building a gradient sixty times a second.
  */
  const disc = vinylBitmaps(R);

  ctx.globalAlpha = 0.82;
  ctx.drawImage(disc.platter, cx - R, cy - R, R * 2, R * 2);

  ctx.globalAlpha = 0.5 + beatFlash * 0.3;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(vinylAngle);
  ctx.drawImage(disc.sheen, -R, -R, R * 2, R * 2);
  ctx.restore();

  // The label: cover art if we have it, the palette if we do not. This is the
  // part that visibly turns.
  const labelR = R * VINYL_LABEL_RATIO;
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(vinylAngle);
  ctx.beginPath();
  ctx.arc(0, 0, labelR, 0, Math.PI * 2);
  ctx.clip();
  if (artReady && artImage) {
    ctx.drawImage(artImage, -labelR, -labelR, labelR * 2, labelR * 2);
  } else {
    ctx.fillStyle = accent;
    ctx.fillRect(-labelR, -labelR, labelR * 2, labelR * 2);
  }
  /*
    A cue mark turning with the label, so the rotation is unmistakable even on a
    cover with no strong features — or none at all, which is the case until the
    artwork lands.

    A shadow wedge was tried first and rejected: at the opacity needed to read
    against real artwork it turned the flat fallback label into a pie chart. A
    single radial line says the same thing and cannot be misread as data.
  */
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, R * 0.012);
  ctx.beginPath();
  ctx.moveTo(labelR * 0.34, 0);
  ctx.lineTo(labelR * 0.94, 0);
  ctx.stroke();
  ctx.restore();

  // Spindle.
  ctx.fillStyle = '#e9e9ef';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, R * 0.022), 0, Math.PI * 2);
  ctx.fill();

  // Tonearm, resting on the record and creeping inward as the song plays —
  // the one part of the deck that legitimately tracks progress.
  const played = durationMs > 0 ? Math.max(0, Math.min(1, estimatePosition() / durationMs)) : 0;
  const pivotX = cx + R * 1.06;
  const pivotY = cy - R * 0.92;
  const armAngle = 2.36 + played * 0.34;              // sweeps toward the spindle
  const armLen = R * 1.28;
  ctx.strokeStyle = hexA(tint, 0.75);
  ctx.lineWidth = Math.max(2, R * 0.028);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(pivotX + Math.cos(armAngle) * armLen, pivotY + Math.sin(armAngle) * armLen);
  ctx.stroke();
  ctx.fillStyle = hexA(accent, 0.9);
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, Math.max(3, R * 0.05), 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'butt';

  ctx.restore();
}

/*
  Stage — the dancers as the subject.

  Everywhere else the troupe is decoration at the bottom of a backdrop. Here
  they get a lit floor and spotlights that punch on the kick, and the renderer
  pulls them forward and enlarges them (see the sprite block in drawBackdrop).
*/
const STAGE_FLOOR_Y = 0.90;

/* Brightest a beam / the floor ever gets. The cached gradients are built at
   these levels and scaled down with globalAlpha, so the stops never change. */
const STAGE_BEAM_MAX = 0.16 + 0.34 + 0.28 + 0.14;
const STAGE_FLOOR_MAX = 0.20 + 0.12;

/** @type {{key: string, beamAccent: CanvasGradient, beamTint: CanvasGradient, floor: CanvasGradient}|null} */
let stageGrads = null;

/**
 * Cached stage gradients, rebuilt only on a resize or a colour change.
 *
 * Built live they were four fresh `createLinearGradient` calls per frame — the
 * highest gradient churn of any preset — for stops that are constant apart from
 * a brightness the caller can apply with globalAlpha instead.
 *
 * @param {number} w @param {number} h @param {number} floorY
 */
function stageGradients(w, h, floorY) {
  const q = quantisedColours();
  const key = `${w}|${h}|${q.key}`;
  if (stageGrads && stageGrads.key === key) return stageGrads;
  const { accent, tint } = q;

  const beam = (colour) => {
    const g = ctx.createLinearGradient(0, -h * 0.05, 0, floorY);
    g.addColorStop(0, hexA(colour, STAGE_BEAM_MAX));
    g.addColorStop(1, hexA(colour, 0));
    return g;
  };
  const floor = ctx.createLinearGradient(0, floorY - h * 0.01, 0, h);
  floor.addColorStop(0, hexA(accent, STAGE_FLOOR_MAX));
  // The mid stop used to be a flat 0.10 while only the lit edge pulsed. It now
  // rides the same globalAlpha as the rest, so the whole floor brightens
  // together — a smaller change than it sounds, and more coherent than a lit
  // edge floating over a fall-off that ignored the beat.
  floor.addColorStop(0.25, hexA(tint, 0.10));
  floor.addColorStop(1, 'rgba(0,0,0,0)');

  stageGrads = { key, beamAccent: beam(accent), beamTint: beam(tint), floor };
  return stageGrads;
}

/**
 * Draw the floor and the spotlights. Called before the sprites so they stand in
 * front of it.
 * @param {number} w @param {number} h @param {number} now
 * @param {string} accent @param {string} tint
 */
function drawStage(w, h, now, accent, tint) {
  const floorY = h * STAGE_FLOOR_Y;
  const grads = stageGradients(w, h, floorY);

  // Three beams from above the top edge onto the floor. They sway slowly, and
  // each brightens on its own beat subdivision so the rig reads as lit BY the
  // music rather than merely near it.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i += 1) {
    const sway = Math.sin(now / (2600 + i * 700) + i * 2.1);
    const originX = w * (0.22 + i * 0.28);
    const targetX = w * (0.22 + i * 0.28) + sway * w * 0.14;
    const beat = i === 1 ? beatFlash : beatFlash * (i === 0 ? 0.7 : 0.55);
    // A rig that only shows itself on the kick is a rig you cannot see between
    // kicks, so the beams carry a standing level and the beat adds on top.
    const power = 0.16 + beat * 0.34 + dropFlash * 0.28 + buildup * 0.14;
    const width = w * (0.055 + beat * 0.02);

    /*
      The beam's fade is vertical, and its brightness is applied with
      globalAlpha rather than baked into the colour stops — so one cached
      gradient per colour serves every beam at every power, instead of three
      fresh gradients a frame that differed only in alpha and in a horizontal
      skew nobody can see across a soft fade.
    */
    ctx.globalAlpha = Math.min(1, power / STAGE_BEAM_MAX);
    ctx.fillStyle = i === 1 ? grads.beamAccent : grads.beamTint;
    ctx.beginPath();
    ctx.moveTo(originX - width * 0.16, -h * 0.05);
    ctx.lineTo(originX + width * 0.16, -h * 0.05);
    ctx.lineTo(targetX + width, floorY);
    ctx.lineTo(targetX - width, floorY);
    ctx.closePath();
    ctx.fill();

    // The pool of light where the beam lands.
    ctx.globalAlpha = Math.min(0.7, power * 2.2);
    ctx.fillStyle = hexA(i === 1 ? accent : tint, 0.5);
    ctx.beginPath();
    ctx.ellipse(targetX, floorY, width * 1.5, h * 0.018, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // The floor itself: a lit edge with the light falling away below it. Same
  // trick as the beams — cached stops, brightness through globalAlpha.
  ctx.save();
  ctx.globalAlpha = Math.min(1, (0.20 + beatFlash * 0.12) / STAGE_FLOOR_MAX);
  ctx.fillStyle = grads.floor;
  ctx.fillRect(0, floorY - h * 0.01, w, h - floorY + h * 0.01);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = hexA(accent, 0.45 + beatFlash * 0.35);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(w, floorY);
  ctx.stroke();
  ctx.restore();
}

function drawBackdrop(now) {
  // Set once the frame is actually being drawn (i.e. past the throttle), so the
  // `finally` below can price every exit path — including the `bare` shortcut —
  // without repeating itself.
  let startedAt = 0;
  try {
    // Hidden overlay: draw nothing at all. This is the single largest saving
    // available while hidden — the swirl shader, the galaxy and the sprites all
    // hang off this function. Placed above the cadence sampler so the parked
    // frames are not mistaken for a stalling compositor.
    if (!overlayVisible) return;

    // Compact modes have no backdrop: there is no room for one, and the point
    // of them is to composite fewer pixels. Everything below this line draws.
    if (isCompact()) return;

    // Presented-frame cadence, sampled before the throttle so it measures the
    // compositor rather than our own frame-skipping. Gaps over 100ms are the
    // window being occluded or the machine sleeping, not render load.
    if (lastFrameAt) {
      const gap = now - lastFrameAt;
      if (gap < 100) frameIntervalMs += (gap - frameIntervalMs) * 0.05;
    }
    lastFrameAt = now;

    // Adaptive frame-skip: cap the effective redraw rate when GPU-bound — and
    // always in Lite mode — so we draw fewer, cheaper frames instead of
    // stuttering at the display's full refresh rate. rAF still fires every vsync
    // via the finally block; we just return early until enough time has elapsed.
    // The dt-normalised decays below keep motion speed correct at any frame rate.
    const throttleMs = liteMode ? 33 : (drawCostMs > 26 ? 32 : drawCostMs > 17 ? 20 : 0);
    if (throttleMs && lastDrawnAt && (now - lastDrawnAt) < throttleMs) return;
    lastDrawnAt = now;
    startedAt = performance.now();

    const w = window.innerWidth;
    const h = window.innerHeight;
    const ambient = 0.12 + 0.05 * Math.sin(now / 4200);
    // Sentiment energy raises the constant floor of motion, so high-energy songs
    // stay visibly more alive than mellow ones even between lyric lines. Build-up
    // and drop add a temporary surge on top.
    /*
      The mood profile shapes the CHARACTER of the motion on top of energy — a
      calm song churns less and a driving one more, even at the same energy.
      Applied as a gentle multiplier (clamped 0.4..2 in mood.js) so it colours
      the feel without ever stalling the field or running it away. Build-up and
      drop surges are left un-multiplied: a drop should hit hard regardless of
      the song's baseline mood.
    */
    const life = Math.min(1, (intensity + ambient + baseEnergy * 0.45) * moodProfile.motion + buildup * 0.5);
    const motion = 1 + (baseEnergy * 1.4) * moodProfile.motion + buildup * 1.6 + dropFlash * 1.2;
    const accent = (palette && palette[3]) || '#e94560';

    // Per-frame dt (backdrop loop is independent of the lyric frame loop).
    const rawDt = lastBackNow ? now - lastBackNow : 16;
    const dt = Math.min(60, rawDt);
    lastBackNow = now;

    // Real-audio envelope (null when capture is off). When present it becomes the
    // source of truth for kicks/build-ups/drops below.
    audioEnv = (audioEnabled && window.AudioReactive) ? window.AudioReactive.sample(now) : null;
    updateMeters(audioEnv);
    if (window.HeatMap && audioEnv && audioEnv.active && playbackStatus === 'Playing') {
      window.HeatMap.note(estimatePosition(), audioEnv);
    }
    const audioActive = Boolean(audioEnv && audioEnv.active);

    // Adaptive quality: track FPS and ease `quality` so heavy layers back off when
    // frames run long, keeping motion near 60fps. Uses the true (unclamped) dt.
    const instFps = 1000 / Math.max(1, rawDt);
    fpsEMA += (instFps - fpsEMA) * 0.05;
    // Quality follows the COST of a frame, not the rate we chose to draw at —
    // see drawCostMs. Budget is one 60Hz frame (16.7ms); past that we are
    // genuinely behind and the heavy layers should back off.
    const qTarget = drawCostMs < 9 ? 1 : drawCostMs < 14 ? 0.8 : drawCostMs < 22 ? 0.6 : 0.45;
    quality += (qTarget - quality) * 0.02;

    // Live FPS readout (throttled to ~3/s to avoid needless DOM writes).
    if (els.fps && now - lastFpsShownAt > 350) {
      lastFpsShownAt = now;
      els.fps.textContent = `${Math.round(fpsEMA)} fps`;
      updateBpmChip();
    }

    /*
      Slowly drift the global hue (faster when intense), and jump it on drops —
      this shifts the whole wash + live layers so the background never settles.

      Brightness now steers it as well. A bright, open mix pushes the hue
      forward; a filtered breakdown lets it fall back, so the colour of the room
      tracks the character of the sound and not merely its volume. Bounded to
      ±40% of the base rate: the drift is a signature of the app, not something
      the spectrum should be able to run away with.
    */
    const tone = 0.6 + (brightness - 0.3) * 1.3;
    bgHue = (bgHue
      + dt * 0.01 * (0.6 + intensity + baseEnergy) * Math.max(0.6, Math.min(1.4, tone))
      + dropFlash * 0.6) % 360;

    /*
      Beat clock: advance the phase, fire a flash + micro-flicker on each
      downbeat. This is the "timing" spine every reactive layer reads from.

      Two modes. When the kick onsets have yielded a confident tempo the clock
      runs in REAL time and is phase-locked to the measured beat, so the visuals
      land on the music. Without that — no audio capture, or a passage with no
      usable percussion — it falls back to the old behaviour, where the period
      comes from lyric cadence and is stretched by energy. That stretch has to
      be dropped when locked: multiplying real time by an energy factor is
      exactly what would pull a correct tempo back off the beat.
    */
    if (tempoLocked) {
      beatClockMs += dt;
    } else {
      beatClockMs += dt * (0.85 + baseEnergy * 0.6 + intensity * 0.8);
    }
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

    /*
      Re-measure the tempo about once a second. Re-running it every frame would
      be pure waste — the estimate sweeps ~470 candidate periods — and the
      answer cannot meaningfully change between frames anyway.

      The lock is deliberately sticky: it engages only on a confident estimate
      and is released only when confidence falls well below that, so a quiet bar
      or a breakdown does not drop the clock in and out of lock mid-song.
    */
    if (window.Tempo && now - lastTempoCheckAt > 1000) {
      lastTempoCheckAt = now;

      /*
        A tempo measured across the whole song is not up for re-litigation.

        The offline analysis on the local-playback path measures the entire
        track in ~100ms and gets it right; this block then re-derived a tempo
        from a rolling 12-second window every second and OVERWROTE it. Watched
        against a real 138 BPM track, that dragged the clock — and the HUD chip
        — from 138 to 174 over the course of one play, and the platter and the
        dancers run on that number.

        So when the tempo is known, only the PHASE is tracked live. That is the
        part which genuinely has to follow the music; the period does not.
      */
      const known = window.Tempo.prior();
      const t = known ? null : window.Tempo.current();

      if (known) {
        const period = 60000 / known;
        const ph = window.Tempo.phaseFor(period);
        tempoLocked = true;
        tempoBpm = known;
        beatPeriodMs = period;
        if (ph && ph.confidence >= TEMPO_LOCK_OUT) {
          beatClockMs = ((now - ph.phaseMs) % period + period) % period;
        }
      } else {
      /*
        Two consecutive confident estimates that AGREE are required before the
        clock is handed over, and the value is refreshed on every such pair
        rather than latched once.

        Measured on a real house track, a single confident reading was not
        enough: the kick train carries occasional false onsets, one noisy window
        crossed the threshold at 60BPM — the very bottom of the search range —
        and the clock held that obviously-wrong value for the rest of the song,
        because confidence then hovered above the release threshold. Agreement
        rejects that: noise does not repeat the same wrong answer twice.
      */
      const agrees = t && lastTempoBpm
        && Math.abs(t.bpm - lastTempoBpm) / lastTempoBpm < 0.04;
      lastTempoBpm = t && t.confidence >= TEMPO_LOCK_IN ? t.bpm : 0;

      /*
        Enough onsets to be worth believing. Eight is plenty to FORM an estimate
        but nowhere near enough to bet the clock on one: measured on a real
        track, the first few seconds repeatedly produced a confident-looking
        60BPM — the very bottom of the search range — which then held. Waiting
        for a couple of bars of evidence removes that entirely.
      */
      const enough = window.Tempo.count() >= TEMPO_LOCK_ONSETS;

      if (t && t.confidence >= TEMPO_LOCK_IN && agrees && enough) {
        tempoLocked = true;
        beatPeriodMs = t.periodMs;
        tempoBpm = t.bpm;
        // Align the clock so the next wrap lands on a real beat. `phaseMs` is
        // on the same clock as `now`, so this is just the distance past the
        // most recent beat.
        beatClockMs = ((now - t.phaseMs) % t.periodMs + t.periodMs) % t.periodMs;
      } else if (!t || t.confidence < TEMPO_LOCK_OUT) {
        tempoLocked = false;
        tempoBpm = 0;
      }
      }
    }

    /*
      Brightness drives the palette's live hue.

      The spectral centroid is the one measure that separates a filtered
      breakdown from a full-range drop when both are equally loud, which is
      exactly the moment the visuals most need to change character and the
      moment a level-only reading cannot see. Eased hard, because the centroid
      is jumpy frame to frame and the hue is a slow, global thing.
    */
    if (audioActive && typeof audioEnv.centroid === 'number') {
      brightness += (audioEnv.centroid - brightness) * 0.04;
    } else {
      brightness += (0.3 - brightness) * 0.02;
    }

    // Real audio overrides the synthetic envelope: kicks punch the pulse/flash,
    // build-ups drive the flicker + centre bloom, and a detected drop fires the
    // full drop moment (flash, confetti, hue jump, dancer multiplication).
    if (audioActive) {
      intensity = Math.max(intensity, Math.min(1, audioEnv.level * 1.6));
      if (audioEnv.kick > 0.10) {
        // Snap to a solid flash even on a modest kick, so every thump lands
        // visibly instead of scaling faintly with a hot-mastered bass band.
        beatFlash = Math.max(beatFlash, Math.min(1.15, 0.55 + audioEnv.kick * 0.6));
        pulse = Math.max(pulse, 0.7 + audioEnv.kick * 1.2);   // harder body punch
        if (audioEnv.kick > 0.4) spawnRipple(audioEnv.kick * 1.15);
        if (window.Tempo) window.Tempo.note(now);   // feed the tempo estimator
      }
      buildup = Math.max(buildup, audioEnv.build);
      if (audioEnv.build > 0.3) flicker = Math.max(flicker, audioEnv.build * (0.35 + Math.random() * 0.5));
      if (audioEnv.drop) triggerDrop();
    }

    /*
      Anticipation — the one thing here that knows what has not happened yet.

      Every other input describes the sample being held. A stored heat map has
      already heard the rest of the song, so a rise can be played INTO rather
      than discovered a frame late: the field tightens and the dancers crouch
      while the build-up is still climbing, and the drop lands on a screen that
      was already leaning toward it.

      It feeds the existing `buildup` rather than adding a parallel channel,
      because "something is coming" is exactly what buildup already means to
      every layer downstream. Strongest source wins, as with live audio and the
      beat map: a learned map should not talk over a real build it can hear.

      Eased, never snapped. Bin boundaries are ~2s apart on a 3-minute track, so
      reading the raw value straight out would step visibly at every crossing.
    */
    if (window.HeatMap && durationMs > 0) {
      const ahead = window.HeatMap.lookahead(estimatePosition(), ANTICIPATION_WINDOW_MS);
      const want = Math.min(1, ahead.rise * 1.35) * ahead.imminence;
      anticipation += (want - anticipation) * Math.min(1, dt / 260);
      anticipationToPeakMs = ahead.toPeakMs;
      if (anticipation > buildup) buildup = anticipation;
    } else {
      anticipation = 0;
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
    // Layers come from the chosen preset, not a coin flip. `affordable()` may
    // substitute a cheaper preset when frames run long — a different coherent
    // look, rather than the old behaviour of switching individual layers off
    // and producing a composition nobody designed.
    // Judge affordability by the rate the machine COULD sustain (frame cost),
    // not the rate we are currently choosing to draw at — a deliberately
    // throttled 31fps is not the same as a machine that cannot do better.
    const achievableFps = 1000 / Math.max(1, drawCostMs);
    const activePreset = window.VisualPresets.affordable(
      window.VisualPresets.byId(presetId), achievableFps, liteMode
    );
    // Copy rather than alias: the overrides below would otherwise mutate the
    // preset definition itself and corrupt it for the rest of the session.
    // Copying key-by-key also avoids a per-frame allocation.
    for (const key of window.VisualPresets.LAYER_KEYS) scene[key] = activePreset.layers[key];
    if (activePreset.id !== renderedPresetId) {
      renderedPresetId = activePreset.id;
      presetFadeAt = now;
      applyPresetLabel();   // reflect any governor substitution on the chip
    }

    // Lite mode and the FPS governor are handled by affordable() above, which
    // substitutes a cheaper preset wholesale instead of gutting this one.
    // With real audio the bottom equalizer reads as a live spectrum, so it is
    // worth having wherever the preset can afford it.
    // The equalizer bars used to be force-enabled whenever audio was live.
    // The band meters at the top edge now carry that information in a fraction
    // of the screen, so the full-width bars are no longer switched on here.

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
    /*
      --beat drives the active line's glow, whose text-shadow blur radius is
      calc(12px + var(--beat) * 30px). Writing it every frame invalidated that
      shadow every frame, and a large animated text-shadow is an expensive
      repaint. Quantising to 0.05 keeps the throb visually identical while
      cutting the number of repaints by roughly an order of magnitude.
    */
    const beatNow = Math.round((beatFlash + dropFlash) * 20) / 20;
    if (beatNow !== lastBeatVar) {
      lastBeatVar = beatNow;
      document.documentElement.style.setProperty('--beat', beatNow.toFixed(2));
    }

    /*
      Ghost mode: the GPU cloud and the DOM lyrics, nothing else.

      Skipping the 2D drawing is only half of it — an untouched full-screen
      canvas is still a compositor layer that gets blended into every frame.
      Taking the element out of the page with `display:none` is what actually
      removes that cost, so the toggle is done on the element, once, when the
      mode changes rather than every frame.
    */
    // Per-track wash + album-art levels share the chosen backdrop opacity, so the
    // whole overlay stays as see-through (faint) or solid as the user picked.
    const level = BACKDROP_LEVELS[backdropLevel] || BACKDROP_LEVELS[2];

    // Engine selection, before anything draws. See `activeEngine`.
    applyEngine(activePreset, now, dt, w, h);

    const bare = Boolean(activePreset.bare);
    if (bare !== canvasHidden) {
      canvasHidden = bare;
      els.canvas.style.display = bare ? 'none' : '';
      if (!bare) resizeCanvas(); // the backing store is stale after being hidden
    }

    /*
      Transparent background.

      `soloLayer` already suppresses the wash and the cover photo, but the GPU
      field is not a layer flag — it renders underneath every preset — so a solo
      look still laid a translucent colour film over the desktop. A preset that
      asks for `transparentBg` gets nothing behind its layer at all: the desktop
      is the background.

      Taken out of the page rather than rendered at alpha 0, for the same reason
      `bare` does it: an untouched full-screen canvas is still composited every
      frame, and compositing is this app's dominant cost.
    */
    const clearBg = Boolean(activePreset.transparentBg);
    if (clearBg !== swirlHidden) {
      swirlHidden = clearBg;
      els.swirl.style.display = clearBg ? 'none' : '';
      // Coming back: clear the remembered rung so the ladder re-issues a resize
      // with the current window size on the next rendered frame. Without this it
      // early-returns on `next === swirlScale` and the buffer keeps whatever
      // dimensions it had when the look changed.
      if (!clearBg) swirlScale = 0;
    }

    if (bare) {
      // No cover photo is painted in this mode, so the field is never thinned.
      renderSwirl(now, dt, life, Math.min(1, level.alpha), activePreset.swirl,
        audioActive ? audioEnv.bass : 0, tintLive, accentLive);
      return;   // `finally` still prices the frame and re-arms the loop
    }

    // Shed or reclaim backdrop pixels when the compositor is struggling. Only
    // in the non-bare path: Ghost has no 2D canvas in the page to resize.
    applyCanvasScale(now);

    ctx.clearRect(0, 0, w, h);

    // Album-art backdrop photo (pre-blurred + darkened), painted behind the wash.
    // Fades in over ~0.9s when a new cover arrives; capped by the backdrop level
    // so a "faint" overlay still lets the desktop show through.
    /*
      Solo: this preset's layer and the words, nothing else.

      Ghost's `bare` cannot serve a mode that has to draw something — it takes
      the canvas out of the page. Solo is the weaker version: the canvas stays,
      the named layers draw, and every always-on extra below is suppressed —
      cover photo, wash, vignette, glows, stars, shooting stars, ripples, the
      build-up bloom, flicker, the timeline, the dancers and confetti.
    */
    const solo = Boolean(activePreset.soloLayer);

    let artAlpha = 0;
    if (!solo && artReady && artBlurred) {
      artFadeIn = Math.min(1, artFadeIn + dt / 900);
      artAlpha = artFadeIn * level.alpha;
      drawArtCover(w, h, artAlpha);
    }

    /*
      Matches the wash's own art-thinning so a cover photo still reads.

      A solo look also thins the field hard. In Ghost the field IS the picture,
      so it runs at full strength; here the tunnel is, and at full strength the
      shader simply swallowed it — the rings were technically drawn and
      practically invisible.

      0.42 was not nearly hard enough, which only became visible against real
      music: at the default "vivid" level that still leaves the field at 0.35,
      and a screenshot of the wormhole over a real track showed the shader and
      no tunnel at all. The brief experiment with removing the field entirely
      (`transparentBg`) fixed the tunnel and lost the depth — smoke needs
      something to be smoke *in*. 0.14 keeps a background that reads as one
      without competing with the layer it is supposed to sit behind.
    */
    const fieldAlpha = level.alpha * (1 - artAlpha * 0.7) * (solo ? 0.14 : 1);
    if (!clearBg) {
      renderSwirl(now, dt, life, Math.min(1, fieldAlpha),
        activePreset.swirl, audioActive ? audioEnv.bass : 0, tintLive, accentLive);
    }

    // Wash opacity follows the level and swells with build-up/drop so colour
    // change reads even through a transparent overlay. When a cover photo is
    // present the wash is thinned so the photo stays visible beneath the colour.
    // With the GPU field active it supplies the colour base, so the flat wash
    // drops to a thin unifying tint instead of hiding the shader behind it.
    const washBase = swirlOn ? level.alpha * 0.16 : level.alpha;
    const washAlpha = Math.min(1, washBase * (1 - artAlpha * 0.85) + buildup * 0.12 + dropFlash * 0.15);
    if (!solo) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = washAlpha;
      ctx.fillStyle = tintLive;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // Reactive background layers (each self-limits by scene flags + energy).
    if (scene.aurora) drawAurora(now, w, h, life);
    if (scene.bokeh) drawBokeh(now, w, h, motion, life);
    if (scene.rays && (life > 0.4 || dropFlash > 0.1)) drawRays(now, w, h, life);
    if (scene.eq) drawEqualizer(now, w, h, life);
    // Complex-maths layers: the phyllotaxis galaxy sits behind, the parametric
    // figure + constellation web ride on top — all beat-reactive "moments".
    // The 260-point galaxy is the single most expensive always-on layer, so Lite
    // mode drops it entirely.
    // The 260-point galaxy is the heaviest always-on layer; auto-drop it when the
    // frame rate sags (in addition to Lite mode) so weak GPUs recover toward 60.
    // The galaxy runs on the GPU inside the swirl shader when that path is
    // available (see swirl.js); only fall back to the CPU fillRect version when
    // it is not, so the two never draw at once.
    const gpuGalaxy = swirlOn && window.SwirlField
      && window.SwirlField.hasGalaxy && window.SwirlField.hasGalaxy();
    if (scene.galaxy && !gpuGalaxy) drawGalaxy(now, w, h, life);
    // Behind the curves and the web, so anything else in the look sits inside
    // the tunnel rather than being swallowed by it.
    if (scene.wormhole) drawWormhole(w, h, dt, life);
    if (scene.math) drawMathCurves(now, w, h, life, motion);
    if (scene.web) drawConstellation(now, w, h, life);
    // The stage floor goes down before anything that stands on it.
    if (scene.stage) drawStage(w, h, now, accentLive, tintLive);

    // Solo looks stop here: the layer above IS the picture. `finally` still
    // prices the frame and re-arms the loop, as it does for the bare path.
    if (solo) return;
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
      // fillRect is cheaper than beginPath+arc+fill for tiny dots, and there are
      // dozens per frame — a real saving at no visible cost at this size.
      const d = s.r * (1 + intensity * 0.5) * 2;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(s.x - d / 2, s.y - d / 2, d, d);
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

    // The deck. After the glows and stars so the platter reads as a solid
    // object in front of the field rather than something lit through.
    if (scene.vinyl) drawVinyl(w, h, dt, accentLive, tintLive);

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
      // Mood shapes how hard the screen strobes: a calm song barely flickers, a
      // dark or driving one leans in. Applied at the point of use so the flicker
      // state still decays normally.
      const strobe = flicker * moodProfile.flicker * (0.5 + Math.random() * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, strobe * 0.5);
      ctx.fillStyle = Math.random() < 0.5 ? '#ffffff' : accentLive;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // The learned song, along the bottom edge. Drawn before the dancers so they
    // stand in front of it — the skyline reads as the floor they are on.
    ctx.globalCompositeOperation = 'source-over';
    if (scene.heatmap) drawHeatmap(w, h, accentLive, tintLive);

    // Pixel-art artist dancers roaming the whole screen (they steer around the
    // central lyric zone); each names + positions itself and reacts to the same
    // energy envelope as the backdrop.
    ctx.globalCompositeOperation = 'source-over';
    if (spritesEnabled && window.ArtistSprites && (spriteActors.length > 0 || spriteClones.length > 0)) {
      /*
        The envelope every dancer reads.

        `beat` and `beatPhase` come from the same clock the rest of the app runs
        on, so a move can land ON the beat instead of near it — the dancers used
        to run on their own free tempo, which meant the one element people watch
        most closely was the one least connected to the music.

        `anticipation` is what the stored heat map knows is coming. It is kept
        separate from `buildup` here (which already absorbs it) so a dancer can
        tell "the music is getting louder right now" from "something big is
        about to happen", and crouch for the second.
      */
      const env = {
        intensity,
        pulse,
        drop: dropFlash,
        buildup,
        anticipation,
        beat: beatFlash,
        beatPhase,
        beatPeriodMs,
        tempoLocked,
      };
      /*
        Stage mode makes the dancers the subject: they are enlarged and their
        roaming band is compressed onto the lit floor so the troupe reads as a
        group performing, rather than as scattered decoration. Every other look
        keeps the small unit that guarantees even the tallest dancer's head
        stays clear of the centred lyric.
      */
      const onStage = Boolean(scene.stage);
      const unit = Math.max(3, Math.round(h * (onStage ? 0.0145 : 0.010)));
      // On stage the band is a shallow strip sitting ON the floor line, not a
      // region above it: dancers roaming a tall band read as floating, which is
      // the one thing a lit floor makes obvious.
      window.ArtistSprites.setBand(
        onStage ? STAGE_FLOOR_Y - 0.045 : 0.60,
        onStage ? STAGE_FLOOR_Y + 0.010 : 0.96
      );
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
    // Cost of the frame we just issued. Smoothed hard (0.1) because a single
    // long frame — a GC pause, a track change — must not swing the governor.
    if (startedAt) drawCostMs += (performance.now() - startedAt - drawCostMs) * 0.1;
    requestAnimationFrame(drawBackdrop);
  }
}

/* ----------------------------------------------------------------- helpers */

function setStatus(text) {
  els.status.textContent = text;
}

/*
  Background work, made visible.

  The app does a lot off-screen — finding lyrics, listening, downloading a
  speech model, transcribing, aligning words, translating — and all of it used
  to report through the single status line, where each message overwrote the
  last and the mood label wiped whatever was there. So work that takes minutes
  looked like nothing happening at all.

  Jobs are tracked by name and rendered together, so two things running at once
  both stay visible, and a job that ends removes only its own entry.
*/
const jobs = new Map();

/**
 * Declare (or clear) a piece of background work.
 * @param {string} name stable job key, e.g. 'whisper'
 * @param {string|null} label what to show; null/'' ends the job
 */
/**
 * What to say when a job finishes, for the few that notify.
 * @param {string} name @returns {string}
 */
function jobDoneLabel(name) {
  const song = currentTrack ? `${currentTrack.title}` : 'the last song';
  if (name === 'transcribe') return `Finished transcribing ${song} — it will be word-synced from now on`;
  return `${name} finished`;
}

function setJob(name, label) {
  const wasRunning = jobs.has(name);
  if (label) jobs.set(name, label);
  else jobs.delete(name);

  /*
    Mirror the job map to the tray. The HUD chip is inside a bar that stays
    invisible until the cursor moves, so work taking minutes could finish with
    nothing on screen having said it started. The tray tooltip always shows it,
    and the few jobs worth interrupting for raise a notification (see
    NOTIFY_ON_DONE in src/main/tray.js).
  */
  if (window.player.reportJobs) {
    const finished = wasRunning && !label ? { id: name, label: jobDoneLabel(name) } : null;
    // Never let a tray that failed to start (it is a convenience) surface as an
    // unhandled rejection in the renderer.
    window.player.reportJobs({
      jobs: [...jobs.entries()].map(([id, text]) => ({ id, label: text })),
      finished,
    }).catch(() => { /* tray unavailable */ });
  }

  if (!els.work) return;
  if (jobs.size === 0) {
    els.work.hidden = true;
    els.work.textContent = '';
    return;
  }
  els.work.hidden = false;
  els.work.textContent = `⟳ ${[...jobs.values()].join(' · ')}`;
  els.work.title = `Background work in progress:\n${[...jobs.values()].join('\n')}`;
}

/* Band meters. Cached element handles and last-written values, because this
   runs every frame and the DOM should only be touched when a number actually
   changes — the same reason paintWords caches its spans. */
let meterEls = null;
const meterLast = { bass: -999, mid: -999, treble: -999 };

/**
 * Linear band level (0..1) to decibels, floored at -60.
 *
 * The envelope is an average of the analyser's byte magnitudes, so it is a
 * linear amplitude ratio and 20·log10 is the right conversion. Anything below
 * -60dB is inaudible against music and reads as silence.
 *
 * @param {number} v 0..1
 * @returns {number} dB, -60..0
 */
function toDb(v) {
  if (!(v > 0)) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(v)));
}

/**
 * Update the three band readouts from the live envelope.
 * @param {{bass: number, mid: number, treble: number}|null} env
 */
function updateMeters(env) {
  if (!els.meters) return;

  const active = Boolean(env && env.active);
  if (els.meters.hidden === active) els.meters.hidden = !active;
  if (!active) return;

  if (!meterEls) {
    meterEls = {};
    for (const band of ['bass', 'mid', 'treble']) {
      const row = els.meters.querySelector(`[data-band="${band}"]`);
      meterEls[band] = {
        row,
        fill: row.querySelector('.meter__bar > i'),
        db: row.querySelector('.meter__db'),
      };
    }
  }

  for (const band of ['bass', 'mid', 'treble']) {
    const db = toDb(env[band]);
    // Whole decibels: finer than that is noise on a 44px bar and would rewrite
    // the DOM on every single frame.
    const rounded = Math.round(db);
    if (rounded === meterLast[band]) continue;
    meterLast[band] = rounded;
    const el = meterEls[band];
    // 0..1 up the scale. Published as a CSS variable so the label brightness,
    // the glow and the number's opacity all follow the level from one write,
    // rather than needing a style change each.
    const lv = Math.max(0, Math.min(1, (rounded + 60) / 60));
    el.row.style.setProperty('--lv', lv.toFixed(2));
    el.db.textContent = rounded <= -60 ? '−∞' : `${rounded} dB`;
    el.fill.style.top = `${Math.round((1 - lv) * 100)}%`;   // fills from the bottom
  }
}

/** Show the measured tempo, or hide the chip when nothing is locked. */
function updateBpmChip() {
  if (!els.bpm) return;
  if (tempoLocked && tempoBpm > 0) {
    els.bpm.hidden = false;
    els.bpm.textContent = `♩ ${Math.round(tempoBpm)}`;
  } else {
    els.bpm.hidden = true;
  }
}

/**
 * Whether an async payload (lyrics, artwork, mood, …) belongs to the track that
 * is playing right now.
 *
 * These arrive well after the track that triggered them, so a stale one must be
 * dropped rather than applied to whatever is playing. Title alone is not an
 * identity — covers, remixes and the "Intro"/"Interlude" tracks every rap album
 * ships collide constantly — so the artist is compared too.
 *
 * @param {{title?: string, artist?: string}|undefined} track payload's track
 * @returns {boolean}
 */
function isForCurrentTrack(track) {
  if (!currentTrack || !track) return true; // nothing to contradict it
  return track.title === currentTrack.title && track.artist === currentTrack.artist;
}

function clearColumn() {
  els.column.textContent = '';
  lineEls = [];
  activeIndex = -1;
  activeWords = [];
  styledFrom = 0; styledTo = -1;
  els.column.style.transform = `translateY(${targetCenterPx}px)`;
  els.translation.classList.remove('is-visible');
  els.translation.textContent = '';
}

function applyScript() {
  const useDeva = script === 'devanagari' && cuesDevanagari;
  cues = useDeva ? cuesDevanagari : cuesLatin;
  document.body.classList.toggle('lang-devanagari', Boolean(useDeva));
  els.scriptBtn.setAttribute('aria-pressed', String(script === 'devanagari'));
  if (els.ttScript) els.ttScript.setAttribute('aria-pressed', String(script === 'devanagari'));
  buildColumn();
}

function refreshButtons() {
  els.scriptBtn.disabled = cuesLatin.length === 0 || (!cuesDevanagari && !transliterationAvailable);
  els.translateBtn.setAttribute('aria-pressed', String(showTranslation && Boolean(cuesEnglish)));
  els.translateBtn.disabled = cuesLatin.length === 0 || (!cuesEnglish && !translationAvailable);

  // Mirror onto the always-visible top-right toggles.
  if (els.ttScript) els.ttScript.disabled = els.scriptBtn.disabled;
  if (els.ttTranslate) {
    els.ttTranslate.disabled = els.translateBtn.disabled;
    els.ttTranslate.setAttribute('aria-pressed', els.translateBtn.getAttribute('aria-pressed') || 'false');
  }

  /*
    Say why, when there is a why. A translation that exists but cannot be lined
    up with the current cue list is hidden deliberately — captioning a line with
    its neighbour's translation is worse than showing nothing — but silence made
    that indistinguishable from a broken feature.
  */
  const blocked = translationBlockedReason();
  els.translateBtn.title = blocked
    ? `Translation unavailable — ${blocked}`
    : (cuesEnglish ? 'Show / hide the English line' : 'English translation');
  els.translateBtn.classList.toggle('chip--warn', Boolean(blocked));
  if (blocked && showTranslation) setStatus(`no translation — ${blocked}`);
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
    /* The cast changed, so every actor index in the mapping is stale. Re-derive
       it from the names, which is why the raw payload is kept around. */
    lineSingers = mapAttributionToActors(attributionPayload);
  }
}

/* Hero animation variations. While the song-name hero lingers (instrumentals,
   slow/Deadmau5-style sections), we rotate a variant class every few seconds so it
   never looks static for minutes: v-1 is the base glow/pulse, v-2..v-4 reshape the
   motion (sway + letter-spacing, wobble, hue drift). */
const HERO_VARIANTS = 4;
const HERO_VARIANT_MS = 6500;
let heroVariant = 1;
let heroVariantTimer = null;

function applyHeroVariant() {
  for (let i = 2; i <= HERO_VARIANTS; i += 1) {
    els.hero.classList.toggle(`v-${i}`, i === heroVariant);
  }
}

function startHeroVariants() {
  if (heroVariantTimer) return;
  applyHeroVariant();
  heroVariantTimer = setInterval(() => {
    heroVariant = (heroVariant % HERO_VARIANTS) + 1;
    applyHeroVariant();
  }, HERO_VARIANT_MS);
}

function stopHeroVariants() {
  if (!heroVariantTimer) return;
  clearInterval(heroVariantTimer);
  heroVariantTimer = null;
}

/**
 * Show a big glowing title + artist when there is no lyric line to show — an
 * instrumental track, a track with no synced lyrics, the intro before the first
 * line, OR when the user has toggled lyrics off (no-lyric mode). While visible it
 * cycles animation variations so long slow sections stay alive.
 */
function updateHero() {
  const noActiveLine = cues.length === 0 || activeIndex < 0 || instrumentalGap;
  const show = Boolean(currentTrack) && (!lyricsVisible || noActiveLine);
  if (show) {
    els.heroTitle.textContent = currentTrack.title || '';
    els.heroArtist.textContent = artistLabel || currentTrack.artist || '';
    startHeroVariants();
  } else {
    stopHeroVariants();
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
    buildBlurredArt();          // the visible backdrop — needed this frame
    artReady = Boolean(artBlurred);
    artFadeIn = 0;
    /*
      Defer the palette extraction off the track-start frame.

      `extractArtPalette` ends in a `getImageData` call, which forces a
      synchronous GPU→CPU readback and stalls the frame. Landing it here, in
      the same frame that just blurred a 512² cover — and while the main
      process is mid-decode/analysis/lyric-fetch — is part of the measured
      first-few-seconds frame dip. The palette only recolours the procedural
      dancers, a secondary effect nobody misses for a frame or two, so it waits
      for an idle slot. The `artImage === img` guard drops the work if a newer
      cover (or track) has replaced this one before the idle callback runs.
    */
    scheduleIdle(() => {
      if (artImage !== img) return;
      artPalette = extractArtPalette(img);
      applyArtPalette();
    });
  };
  img.onerror = () => { /* keep the previous backdrop */ };
  img.src = dataUri;
}

/**
 * Run `fn` when the main thread is next idle, so heavy one-off work does not
 * pile onto a busy frame. Uses requestIdleCallback where available (a real
 * idle-time slot) and falls back to a short timeout otherwise.
 * @param {() => void} fn
 */
function scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 400 });
  } else {
    setTimeout(fn, 120);
  }
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

/** Cached legibility scrim (rebuilt on viewport-height change). */
let artScrim = null;
let artScrimH = 0;

/** Bake a light blur + gentle darken into a small offscreen canvas once. A softer
    treatment than before so the cover is actually recognisable in the backdrop. */
function buildBlurredArt() {
  if (!artImage) return;
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return;
  g.filter = 'blur(9px) brightness(0.9) saturate(1.2)';
  // Overscan slightly so the blur doesn't reveal transparent edges.
  g.drawImage(artImage, -size * 0.08, -size * 0.08, size * 1.16, size * 1.16);
  g.filter = 'none';
  artBlurred = c;
}

/**
 * Paint the pre-blurred album art as a full-screen cover behind the wash. Instead
 * of a flat blackout (which hid the cover), a vertical scrim darkens only the
 * centre band where the lyric sits, so the poster stays visible top and bottom.
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

  // Legibility scrim: darkest through the middle (behind the centred lyric),
  // fading toward the top/bottom edges so the cover reads there.
  if (!artScrim || artScrimH !== h) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0.12)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.62)');
    grad.addColorStop(1, 'rgba(0,0,0,0.28)');
    artScrim = grad;
    artScrimH = h;
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = artScrim;
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
  // Finding the chip unprompted answers the question as well as the prompt
  // does, so the nudge should never appear afterwards.
  if (ok) closeCaptureNudge();
  /* Starting capture replaces the whole audio graph. A MilkDrop visualizer
     built against the old context would keep reading zeros forever — silently,
     because a preset with no audio still animates. */
  if (window.MilkDrop) window.MilkDrop.reconnect();
  return ok;
}

/* ------------------------------------------------------- capture discovery */

/*
  The `♫` gap.

  Almost everything the app LEARNS needs loopback capture: the energy arc behind
  the Heatmap and Vinyl timelines, the measured tempo the platter and the
  dancers run on, and the anticipation that reads a stored map forwards. With
  capture off none of it happens — and nothing on screen said so, so a user who
  never found one chip in a row that is hidden until the cursor moves silently
  got none of the features. That is a discovery problem, not a preference.

  Deliberately not auto-enabled: starting a recording of system audio without
  being asked is not ours to decide. So: asked once, honoured either way, and
  never raised again.
*/

/* ------------------------------------------------------------- first run */
/*
  One card, once per install. A new user otherwise gets a transparent overlay
  and a row of single-glyph chips with no explanation of what अ, ◐, ♫ or ⚡ do —
  and that row is invisible until the cursor moves, so many never find it.

  Shown immediately rather than waiting for a track: the question it answers is
  "what is this and what do I do now", which is at its most urgent before
  anything is playing. That is the opposite of the capture nudge below, which
  waits 20s into a song precisely because it is interrupting something that is
  already going well.
*/
const WELCOME_KEY = 'welcomeSeen';

function closeWelcome() {
  if (els.welcome) els.welcome.hidden = true;
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* ignore */ }
}

function maybeShowWelcome() {
  if (!els.welcome) return;
  try {
    if (localStorage.getItem(WELCOME_KEY) === '1') return;
  } catch {
    // Storage unavailable — show it. A card shown twice is a far smaller
    // failure than a first-time user who never learns what the chips do.
  }
  els.welcome.hidden = false;
}

if (els.welcomeClose) els.welcomeClose.addEventListener('click', closeWelcome);

/*
  What's new, after an update.

  A returning user does not need the chips explained again — they want to know
  what changed. So the first-run welcome and this are separate: welcome shows
  once ever, this shows once per new version. Kept warm and short on purpose;
  a changelog nobody reads is worse than a sentence they do.

  Highlights are per version. Add the newest at the top; anything without an
  entry simply shows a friendly generic line rather than nothing.
*/
const SEEN_VERSION_KEY = 'seenVersion';

/** App version, filled from main once get-prefs resolves. */
let appVersion = null;

const WHATS_NEW = {
  '0.26.0': [
    '<b>The app is a fraction of the size</b> — rebuilt on Tauri, so the download went from ~116 MB to ~30 MB. Same visuals, same overlay.',
    '<b>Everything still works</b> — lyrics, cover art, wallpaper mode, translation, the dancers — all reimplemented natively.',
    '<b>Auto-transcription runs in-app now</b> — the speech model downloads once on first use, no separate runtime.',
    '<b>Lighter on your machine</b> — no bundled browser; it uses the Windows WebView that is already there.',
  ],
  '0.25.0': [
    '<b>More songs get synced lyrics</b> — when only plain words exist, the app finds them and times them to the music from audio, instead of showing nothing.',
    '<b>Smoother preset changes</b> — drops cross-fade across the beat now, landing the new look with the music.',
    '<b>Faster track starts</b> — the cover-art work no longer stutters the first second of a new song.',
    '<b>The visuals tell you when they work</b> — "singers identified" and "word-sync active" confirm the clever bits fired.',
  ],
  '0.24.0': [
    '<b>Language toggles are top-right now</b> — script (अ) and translation (EN) are always visible, no more reaching into the bottom bar.',
    '<b>A display-size menu</b> — click the size chip to pick fullscreen, a bar, a strip, or desktop, instead of cycling.',
    '<b>Fixed the coloured rectangles</b> some screens showed, and updates now install without a wizard.',
    '<b>Clearer local-AI picker</b> — the tool that actually works is marked, when the cloud is unavailable.',
  ],
  '0.23.0': [
    '<b>Karaoke word fill</b> — the word being sung now lights up left-to-right in time, instead of all at once.',
    '<b>The visuals match the mood</b> — a calm song moves gently, a driving one harder, not just a different colour.',
    '<b>A deep-space starfield</b> drifts behind the field now, rendered on the GPU.',
    '<b>MilkDrop presets stick</b> — a preset you pick no longer snaps back to the default.',
  ],
  '0.22.0': [
    '<b>Desktop mode is one toggle now</b> — the size chip (or Ctrl+Alt+M) flips between the overlay and living on your desktop, behind your icons.',
    '<b>Switching keeps your song playing</b> — no more restart when you flip modes.',
    '<b>Desktop mode is fully usable</b> — open the library or preset browser and it comes to the front so you can scroll and click; it settles back when you close it.',
    '<b>MilkDrop opens on a good preset</b> now, not a random dud — and you can still browse all 1754.',
  ],
};

function friendlyHighlights(version) {
  return WHATS_NEW[version] || ['A handful of fixes and polish. Thanks for updating!'];
}

function closeWhatsNew(version) {
  if (els.whatsnew) els.whatsnew.hidden = true;
  try { localStorage.setItem(SEEN_VERSION_KEY, version || ''); } catch { /* ignore */ }
}

/**
 * Decide between the first-run welcome and the what's-new card, and show the
 * right one. First-ever run gets the welcome; a version bump gets what's new;
 * an unchanged version gets neither.
 *
 * @param {string} version app version from main
 */
function showWelcomeOrWhatsNew(version) {
  let seenWelcome = false;
  let seenVersion = null;
  try {
    seenWelcome = localStorage.getItem(WELCOME_KEY) === '1';
    seenVersion = localStorage.getItem(SEEN_VERSION_KEY);
  } catch { /* storage unavailable — fall through to the welcome */ }

  if (!seenWelcome) {
    // Brand new install: the chips need naming before anything else.
    maybeShowWelcome();
    try { localStorage.setItem(SEEN_VERSION_KEY, version || ''); } catch { /* ignore */ }
    return;
  }

  if (version && seenVersion !== version && els.whatsnew && els.whatsnewList) {
    if (els.whatsnewVersion) els.whatsnewVersion.textContent = `in ${version}`;
    els.whatsnewList.replaceChildren(...friendlyHighlights(version).map((html) => {
      const li = document.createElement('li');
      li.innerHTML = html; // trusted, in-app copy — never network content
      return li;
    }));
    els.whatsnew.hidden = false;
  }
}

if (els.whatsnewClose) {
  els.whatsnewClose.addEventListener('click', () => closeWhatsNew(appVersion));
}

/* Esc also dismisses it. Scoped to "while the card is up" so this does not
   become a global key handler competing with the panels' own Esc bindings. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (els.welcome && !els.welcome.hidden) closeWelcome();
  else if (els.whatsnew && !els.whatsnew.hidden) closeWhatsNew(appVersion);
  else if (els.mdPanel && !els.mdPanel.hidden) closeMilkdropPanel();
  else if (els.poster && !els.poster.hidden) closePoster();
});

/** Playback needed before asking, so the prompt does not land during startup. */
const CAPTURE_NUDGE_AFTER_MS = 20000;
const CAPTURE_NUDGE_KEY = 'captureNudgeAnswered';

let captureNudgeVisible = false;

/** Whether this install has already answered the prompt, either way. */
function captureNudgeAnswered() {
  try {
    return localStorage.getItem(CAPTURE_NUDGE_KEY) === '1';
  } catch {
    return true;   // no storage means we cannot remember a "no" — so never ask
  }
}

/** Record that it was answered and take it off screen. */
function closeCaptureNudge() {
  captureNudgeVisible = false;
  if (els.captureNudge) els.captureNudge.hidden = true;
  try { localStorage.setItem(CAPTURE_NUDGE_KEY, '1'); } catch { /* ignore */ }
}

/**
 * Show the prompt once a song has been playing long enough, if capture is off
 * and this install has never answered.
 * @param {number} positionMs
 */
function maybeShowCaptureNudge(positionMs) {
  if (captureNudgeVisible || audioEnabled || !els.captureNudge) return;
  // Never stack the two cards. A first-time user who has not dismissed the
  // welcome yet is not ready for a second thing to read.
  if (els.welcome && !els.welcome.hidden) return;
  if (els.whatsnew && !els.whatsnew.hidden) return;
  if (!currentTrack || positionMs < CAPTURE_NUDGE_AFTER_MS) return;
  if (captureNudgeAnswered()) return;
  captureNudgeVisible = true;
  els.captureNudge.hidden = false;
}

if (els.nudgeEnable) {
  els.nudgeEnable.addEventListener('click', async () => {
    closeCaptureNudge();
    await enableAudio();
    refreshButtons();
  });
}
if (els.nudgeDismiss) {
  els.nudgeDismiss.addEventListener('click', closeCaptureNudge);
}

/* ------------------------------------------------------------------ updating */
/*
  Auto-update, made visible.

  0.19.0 shipped auto-update, 0.20.0 made it actually reach GitHub, and both
  reported it into the tray menu alone. On an app whose whole surface is a
  full-screen overlay, a state that only exists inside a right-click menu is a
  state nobody sees: the update downloaded, waited, and the only way to learn
  that was to go looking for it.

  Main decides whether to prompt (see `updateStateForRenderer`), because the
  dismissal has to outlive this renderer — changing display mode reloads it.
*/

/** @param {{phase: string, version?: string, percent?: number, prompt: boolean}} s */
function applyUpdateState(state) {
  if (!state) return;

  if (els.updateCard) {
    els.updateCard.hidden = !state.prompt;
    if (state.prompt && els.updateVersion) {
      els.updateVersion.textContent = state.version ? `Version ${state.version}` : 'A new version';
    }
  }

  if (els.updatePill) {
    // Only while it is arriving. Once ready the card says it better, and two
    // things saying the same thing at once reads as a bug.
    const busy = state.phase === 'downloading' || state.phase === 'available';
    els.updatePill.hidden = !busy;
    if (busy) {
      const pct = Math.max(0, Math.min(99, Math.floor(state.percent || 0)));
      els.updatePill.textContent = state.phase === 'available'
        ? `Downloading ${state.version || 'update'}…`
        : `Downloading ${state.version || 'update'}… ${pct}%`;
    }
  }
}

if (els.updateInstall) {
  els.updateInstall.addEventListener('click', () => {
    // The app quits from under us if this succeeds, so nothing follows it.
    window.player.updateAction('install');
  });
}
if (els.updateLater) {
  els.updateLater.addEventListener('click', async () => {
    if (els.updateCard) els.updateCard.hidden = true;
    await window.player.updateAction('dismiss');
  });
}
if (window.player.onUpdateState) window.player.onUpdateState(applyUpdateState);

/* Ask once at startup: a cold start can settle on 'ready' before this file has
   run, and the push-only path would then never fire. */
if (window.player.getUpdateState) {
  window.player.getUpdateState().then(applyUpdateState).catch(() => { /* not packaged */ });
}

/* ------------------------------------------------------- local-CLI fallback */
/*
  When every cloud AI provider has failed, main sends `localcli-offer` with the
  CLIs it detected. This turns that into a card: one button per installed CLI to
  turn it on, an install hint for the rest, and a dismiss that is remembered so
  it does not ask again. Nothing runs a CLI until a button here is clicked —
  consent is the whole point.
*/
function closeLocalcliCard() {
  if (els.localcliCard) els.localcliCard.hidden = true;
}

function showLocalcliOffer(detected) {
  if (!els.localcliCard || !els.localcliOptions) return;
  const clis = Array.isArray(detected) ? detected : [];
  const installed = clis.filter((c) => c.installed);

  els.localcliOptions.replaceChildren();

  if (installed.length > 0) {
    if (els.localcliText) {
      els.localcliText.textContent = 'Cloud AI is unavailable. Pick a tool you have installed to use instead:';
    }
    // Verified first, so the one that definitely works is the obvious choice.
    const ordered = [...installed].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
    for (const c of ordered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      // A clear badge on each: what works vs what is best-effort.
      const badge = c.verified ? ' ✓' : (c.unverified ? ' · experimental' : ' · best-effort');
      btn.textContent = `${c.label}${badge}`;
      btn.title = c.verified
        ? `${c.label} is verified working — recommended`
        : c.unverified
          ? `${c.label}'s non-interactive mode is unverified — may not work`
          : `${c.label} should work but is not fully verified`;
      if (c.verified) btn.classList.add('chip--recommended');
      btn.addEventListener('click', async () => {
        await window.player.localcliConsent(c.id);
        closeLocalcliCard();
        setStatus(`AI features will use ${c.label} from now on`);
      });
      els.localcliOptions.appendChild(btn);
    }
  } else {
    // None installed: offer install hints for the ones worth getting.
    if (els.localcliText) {
      els.localcliText.textContent = 'Cloud AI is unavailable. Install a local AI CLI to keep these features working:';
    }
    for (const c of clis.slice(0, 3)) {
      const hint = document.createElement('span');
      hint.className = 'localcli__hint';
      hint.textContent = `${c.label}: ${c.install}`;
      els.localcliOptions.appendChild(hint);
    }
  }

  els.localcliCard.hidden = false;
}

if (els.localcliDismiss) {
  els.localcliDismiss.addEventListener('click', async () => {
    closeLocalcliCard();
    // Remembered as a decision so it does not ask again.
    await window.player.localcliConsent('declined');
  });
}
if (window.player.onLocalcliOffer) {
  window.player.onLocalcliOffer(({ detected }) => showLocalcliOffer(detected));
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

/**
 * Save the heat map learned for the CURRENT track. Called at the same points as
 * the beat map — before switching away, on idle, and on window close.
 *
 * Skipped when nothing new was heard this play, so replaying a song already
 * fully learned costs no disk writes. The map itself peak-holds across plays,
 * so writing it back can only ever add detail, never blunt what is stored.
 */
function flushHeatmap() {
  if (!currentTrack || !window.HeatMap) return;
  if (!window.HeatMap.isDirty()) return;
  const heatmap = window.HeatMap.takeForSave();
  if (!heatmap) return;
  window.player.saveHeatmap({
    track: {
      title: currentTrack.title,
      artist: currentTrack.artist,
      durationMs: currentTrack.durationMs || durationMs,
    },
    heatmap,
  });
}

/* ------------------------------------------- Whisper transcription (learn) */

/**
 * The track whose audio PcmCapture is currently recording, or null. Held so
 * the recording is submitted under the song it actually belongs to, even
 * though the flush happens after the *next* track has already started.
 */
let listeningTrack = null;

/** Whether transcription is enabled + which language/model to use. */
let transcribeCfg = { enabled: true, language: '', model: '' };

/**
 * Whether the current track has *plain* lyrics available (real words with no
 * timing). Set from the `lyrics` payload. When true, a transcription pass
 * aligns those correct words to the audio's timing rather than guessing them,
 * so the messaging can promise properly-worded sync instead of a best-effort
 * transcription.
 */
let plainLyricsAvailable = false;

/**
 * Start recording the current song so it can be transcribed once it ends.
 * Requires live loopback capture (the ♫ chip) — without real audio there is
 * nothing to transcribe.
 */
function beginTranscriptionListen() {
  if (!transcribeCfg.enabled || !window.PcmCapture || !currentTrack) return;
  if (listeningTrack) return;                       // already recording this song
  if (!window.AudioReactive || !window.AudioReactive.isActive()) {
    // Loopback is off; say so rather than silently doing nothing, since the
    // fix (turn on ♫) is one click away. When the real words are already known,
    // say that too — enabling ♫ times them to the music rather than guessing.
    setStatus(plainLyricsAvailable
      ? 'lyrics found — enable ♫ to sync them to the music'
      : 'no synced lyrics — enable ♫ to auto-transcribe');
    return;
  }
  if (window.PcmCapture.start()) {
    listeningTrack = currentTrack;
    setStatus(plainLyricsAvailable
      ? 'lyrics found — timing them to the music…'
      : 'no synced lyrics — listening to learn this song…');
  }
}

/** Abandon the in-progress recording (real lyrics turned up, or user skipped). */
function stopTranscriptionListen() {
  if (!listeningTrack || !window.PcmCapture) return;
  window.PcmCapture.reset();
  listeningTrack = null;
}

/**
 * Hand whatever was recorded to the main process for transcription. Called as
 * the track changes, which is the point we know the song is over.
 */
function flushTranscription() {
  if (!listeningTrack || !window.PcmCapture) return;
  const track = listeningTrack;
  listeningTrack = null;

  const pcm = window.PcmCapture.take();   // null when too little audio to bother
  if (!pcm) return;

  window.player
    .transcribeAudio({ track, pcm, language: transcribeCfg.language || undefined })
    .catch((err) => console.warn('[transcribe] failed:', err && err.message));
}

window.player.onTranscribeProgress((data) => {
  const WORK = {
    download: 'downloading speech model', transcribing: 'transcribing',
    aligning: 'aligning words', aligned: null, 'align-weak': null,
    correcting: 'checking the words', corrected: null,
    done: null, empty: null, error: null,
  };
  if (Object.prototype.hasOwnProperty.call(WORK, data.stage)) {
    const pct = typeof data.pct === 'number' ? ` ${data.pct}%` : '';
    setJob('whisper', WORK[data.stage] ? WORK[data.stage] + pct : null);
  }
  if (!data) return;
  switch (data.stage) {
    case 'downloading':
      setStatus(`downloading speech model… ${data.pct}%`);
      break;
    case 'starting':
      setStatus('transcribing the last song…');
      break;
    case 'relanguage':
      setStatus('sounds Hindi — re-transcribing properly…');
      break;
    case 'aligned':
      // Real lyric text matched onto the transcribed timings — the good case.
      setStatus(`matched real lyrics (${data.coverage}% anchored)`);
      break;
    case 'correcting':
      // Only ever runs when there were no real lyrics to match, so this is the
      // fallback path doing its best rather than a step in the good one.
      setStatus(`checking the words… ${data.batch}/${data.batches}`);
      break;
    case 'corrected':
      setStatus(`fixed ${data.changed} misheard line${data.changed === 1 ? '' : 's'}`);
      break;
    case 'done':
      setStatus(
        data.dropped
          ? `learned ${data.lines} lines (${data.dropped} instrumental dropped) — ready next play`
          : `learned ${data.lines} lines — ready next play`
      );
      break;
    case 'empty':
      setStatus('could not make out any lyrics');
      break;
    case 'error':
      setStatus(`transcription failed: ${data.message || ''}`);
      break;
    default:
      break;
  }
});

window.player.getTranscribeConfig().then((cfg) => {
  if (cfg) transcribeCfg = cfg;
}).catch(() => { /* keep defaults */ });

window.player.onTrack((track) => {
  flushBeatmap();                 // persist what we learned for the previous song
  flushHeatmap();                 // ...including the shape of it
  flushTranscription();           // and send the previous song's audio to Whisper
  currentTrack = track;
  durationMs = track.durationMs || 0;
  lastProgressPct = -1;           // force the bar to redraw for the new song
  // The previous song's cover choice says nothing about this one, and a stale
  // selection would mark the wrong tile in the picker.
  artworkChosen = false;
  artworkChosenUrl = null;
  closePoster();
  // The browser lists the same catalogue, but its "pinned" state and current
  // row belong to the song that just ended. A session choice ends with it too;
  // a pin is per song and is re-read for the new one.
  closeMilkdropPanel();
  milkdropChosen = null;
  milkdropSeededFor = null;
  cuesLatin = [];
  cuesDevanagari = null;
  cuesEnglish = null;
  cues = [];
  plainLyricsAvailable = false;   // re-learned from this track's lyrics payload
  /* Belongs to the song that just ended. Carrying it into the next one would
     name that song's artists against these lyrics. */
  setAttribution(null);
  activeMicActor = -1;
  clearColumn();
  els.title.textContent = track.title || '';
  els.artist.textContent = track.artist || '';
  applyLookForTrack(track);   // each song carries its own remembered look
  if (els.source) els.source.hidden = true; // cleared until this track's lyrics land

  // Reset mood/energy; the sentiment analysis (if available) upgrades this soon.
  baseEnergy = typeof track.energy === 'number' ? track.energy : 0.35;
  currentMood = null;
  applyMoodProfile(); // back to neutral until this track's mood lands
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
  if (window.Tempo) window.Tempo.reset();   // a new song has its own tempo
  // An empty map for this track; the stored one (if any) arrives via `heatmap`
  // right after and replaces it, provided the track lengths agree.
  if (window.HeatMap) window.HeatMap.start(track.durationMs || 0);
  anticipation = 0;                         // nothing is known about this song yet
  anticipationToPeakMs = 0;
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
  if (!isForCurrentTrack(data.track)) return;
  window.BeatMap.load(data.beatmap || null);
});

/*
  The learned energy arc for the current song, restored from disk.

  Without this the heat map was rebuilt from nothing on every track change and
  discarded on exit, so the mode could only ever show the play you were in the
  middle of — the whole premise ("play it again and the shape is already known")
  silently did not hold, and neither did anything reading the map forwards.

  `start` has already made an empty map for the track that is actually playing,
  so `load` rejecting a mismatch (a different edit of the same song) leaves the
  song learning itself rather than drawing a confident, wrong arc.
*/
window.player.onHeatmap((data) => {
  if (!window.HeatMap) return;
  if (!isForCurrentTrack(data.track)) return;
  /*
    A null payload means "nothing stored for this song", which is NOT the same
    as "forget the map" — `load(null)` clears, and clearing here would wipe the
    empty map `start` just made and leave the track unable to learn anything at
    all. That is the exact failure this whole change exists to fix, so the first
    listen of every song must fall through untouched.

    Idle still clears deliberately, by calling load(null) itself.
  */
  if (!data.heatmap) return;
  window.HeatMap.load(data.heatmap);
});

/* Cover art + richer artist credit fetched in the main process. */
window.player.onArtwork((data) => {
  if (!isForCurrentTrack(data.track)) return;
  if (data.artwork) loadArtImage(data.artwork);
  maybeEnrichArtists(data.artistName);
  // Whether this cover was hand-picked, so the ▣ chip can say so and the
  // picker can mark the right tile.
  artworkChosen = Boolean(data.chosen);
  if (els.posterBtn) {
    els.posterBtn.setAttribute('aria-pressed', String(artworkChosen && !els.poster.hidden));
    els.posterBtn.title = artworkChosen
      ? 'Cover art — using your pick'
      : 'Cover art — pick a different one';
  }
  updateHero();
});

window.player.onTick((state) => {
  // Drives the now-playing indicator's animation. Toggled through a class on
  // the body rather than inline styles so the CSS owns the whole look, and
  // written only on a real change to avoid a style recalc every tick.
  if (state.status !== playbackStatus) {
    document.body.classList.toggle('is-playing', state.status === 'Playing');
  }
  playbackStatus = state.status;
  anchorPositionMs = state.positionMs ?? 0;
  anchorAt = performance.now();
  if (state.durationMs) durationMs = state.durationMs;
  maybeShowCaptureNudge(anchorPositionMs);
});

/* Sentiment-driven graphics: recolour + re-pace the visuals to the song's mood. */
/* Arrives after the lyrics, because it is an LLM pass and the words must not
   wait for it. The dancers rotate until it lands, then stop rotating. */
window.player.onAttribution((payload) => {
  if (!isForCurrentTrack(payload.track)) return;
  setAttribution({ artists: payload.artists, singers: payload.singers });
  /*
    Announce a successful multi-singer attribution once, briefly. This is the
    only feature that runs off a live model and it otherwise lands invisibly —
    the dancer on the mic just starts being right — so a single play could never
    confirm it fired. Naming the singers the model actually assigned turns that
    play into proof. Silent for a one-name credit (nothing was disambiguated).
  */
  const names = Array.isArray(payload.artists) ? payload.artists.filter(Boolean) : [];
  const assigned = Array.isArray(payload.singers)
    ? new Set(payload.singers.filter((i) => Number.isInteger(i) && i >= 0)).size
    : 0;
  if (names.length >= 2 && assigned >= 2) {
    setStatus(`singers identified — ${names.slice(0, 3).join(', ')}`);
  }
});

window.player.onMood((data) => {
  if (!isForCurrentTrack(data.track)) return;
  if (Array.isArray(data.palette) && data.palette.length >= 4) {
    palette = data.palette;
    baseTint = palette[0];
    seedGlows([palette[1], palette[2], palette[1]]);
    document.documentElement.style.setProperty('--accent', palette[3]);
  }
  if (typeof data.energy === 'number') baseEnergy = data.energy;
  currentMood = data.mood || null;
  applyMoodProfile();
  if (currentMood) setStatus(currentMood);
});

/**
 * Derive the visual profile from the current mood + energy and expose its key
 * to CSS. The renderer folds `moodProfile.motion` / `.flicker` into the motion
 * it already computes each frame; the `data-mood` attribute lets the stylesheet
 * tune anything CSS owns (glow weight, wash) per character.
 */
function applyMoodProfile() {
  moodProfile = window.MoodProfile
    ? window.MoodProfile.profileFor(currentMood, baseEnergy)
    : moodProfile;
  document.body.dataset.mood = moodProfile.key;
}

window.player.onLyrics((payload) => {
  if (!isForCurrentTrack(payload.track)) return;
  cuesLatin = payload.cues || [];
  cuesDevanagari = payload.cuesDevanagari || null;
  transliterationAvailable = Boolean(payload.transliterationAvailable);
  translationAvailable = Boolean(payload.translationAvailable);
  plainLyricsAvailable = Boolean(payload.plainAvailable);

  // LRCLIB often reports the full artist credit even when SMTC gave just the
  // primary — fold any extra collaborators in so each gets a dancer.
  if (payload.source && payload.source.artistName) maybeEnrichArtists(payload.source.artistName);

  /* Applied after the enrichment above, which can add dancers: the mapping is
     from credited names to actors, so it has to see the final cast. */
  setAttribution(payload.attribution || null);

  switch (payload.status) {
    case 'searching': setJob('lyrics', 'finding lyrics'); setStatus('finding lyrics…'); break;
    case 'not-found':
      setJob('lyrics', null);
      setStatus(payload.plainAvailable ? 'lyrics found — timing needed' : 'no synced lyrics found');
      clearColumn();
      // Nothing to show this play — start listening so Whisper can transcribe
      // the song at the end and have it ready for every play after.
      beginTranscriptionListen();
      break;
    case 'error': setJob('lyrics', null); setStatus('lyric lookup failed'); clearColumn(); break;
    default:
      setStatus('');
      /*
        Lyrics arrived. Keep listening anyway when they have no word timings
        yet: the audio is what turns correct line-level lyrics into word-level
        sync (see src/main/wordalign.js), and it can only be captured while the
        song is actually playing. Main decides at the end whether to spend a
        Whisper pass on it; this side just makes sure the audio exists.

        Costs nothing when the user has not enabled audio capture — the
        recorder taps that same stream and simply declines to start without it.
        Once a song has word timings, they are cached, so this happens once per
        song rather than on every play.
      */
      if (payload.status === 'ok' && !payload.hasWordTimings) beginTranscriptionListen();
      else stopTranscriptionListen();
      // Confirm measured word-level sync once, so a live play proves the
      // record→align→cache→replay cycle completed rather than leaving it
      // ambiguous against the estimate the wipe also runs on.
      if (payload.status === 'ok' && payload.hasWordTimings
          && cuesLatin.some((c) => Array.isArray(c.words) && c.words.length > 0)) {
        setStatus('word-sync active');
      }
  }
  if (payload.status !== 'searching') setJob('lyrics', null);
  if (payload.status === 'ok') showSourceBadge(payload.origin);
  applyScript();
  refreshButtons();
  updateHero();
});

/**
 * Badge where the current lyrics loaded from, so a preloaded (offline/instant)
 * hit is visible proof the pre-sync/cache paid off.
 * @param {'memory'|'disk'|'network'|undefined} origin
 */
function showSourceBadge(origin) {
  if (!els.source) return;
  const map = {
    disk: { text: '⚡ preloaded', title: 'Loaded instantly from the on-disk cache (offline)' },
    memory: { text: '⚡ cached', title: 'Reused from this session — no re-fetch' },
    network: { text: '↓ fetched', title: 'Fetched from the network just now' },
  };
  const info = map[origin];
  if (!info) { els.source.hidden = true; return; }
  els.source.textContent = info.text;
  els.source.title = info.title;
  els.source.hidden = false;
}

window.player.onTranslation((payload) => {
  if (!isForCurrentTrack(payload.track)) return;
  // Structural, not per-case: any state other than the in-flight one ends the
  // job, so a status we forget to handle can never leave a stale spinner up.
  if (payload.status !== 'translating') setJob('translate', null);
  switch (payload.status) {
    case 'translating': setJob('translate', 'translating'); setStatus('translating…'); break;
    case 'ok':
      cuesEnglish = payload.cues || null;
      setStatus('');
      updateTranslation(activeIndex);
      break;
    case 'skipped': setJob('translate', null); cuesEnglish = null; break;
    case 'error': setJob('translate', null); setStatus('translation failed'); break;
    default: break;
  }
  refreshButtons();
});

/*
  Overlay visibility. Main sends this on every show/hide (Ctrl+Alt+H, the tray,
  or anything added later). Because `backgroundThrottling` is off — required so
  the visuals keep moving while another app has focus — Chromium will not park
  us on its own, so hiding the window without this kept the entire visual stack
  drawing into a surface nobody could see. The loops keep their rAF alive and
  simply draw nothing, so resuming is instant and no state drifts.
*/
/*
  Display mode. Main owns the window geometry and tells us what it just became;
  the renderer's job is to look right at that size and to stop paying for what
  is no longer visible.
*/
/*
  The size chip opens a menu instead of cycling. Cycling four modes with one
  chip meant you could not jump to the one you wanted and could land on a
  half-finished one by accident; a menu is predictable — every mode is a
  labelled click and the current one is marked. The chip label reflects the
  current mode so the corner still says what you are in.
*/
const DISPLAY_MODE_LABELS = {
  full: '▭ Size', bar: '▬ Bar', strip: '▁ Strip', wallpaper: '▨ Desktop',
};
const modeMenu = document.getElementById('mode-menu');

function markModeMenu() {
  if (!modeMenu) return;
  for (const item of modeMenu.querySelectorAll('.mode-menu__item')) {
    item.setAttribute('aria-checked', String(item.dataset.mode === displayMode));
  }
}

function openModeMenu() {
  if (!modeMenu) return;
  markModeMenu();
  modeMenu.hidden = false;
  document.body.classList.add('show-cursor');
  if (els.modeBtn) els.modeBtn.setAttribute('aria-expanded', 'true');
}

function closeModeMenu() {
  if (!modeMenu) return;
  modeMenu.hidden = true;
  if (els.modeBtn) els.modeBtn.setAttribute('aria-expanded', 'false');
}

if (els.modeBtn) {
  els.modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modeMenu && modeMenu.hidden) openModeMenu(); else closeModeMenu();
  });
}

if (modeMenu) {
  for (const item of modeMenu.querySelectorAll('.mode-menu__item')) {
    item.addEventListener('click', () => {
      window.player.setDisplayMode(item.dataset.mode);
      closeModeMenu();
    });
  }
  // Click anywhere else, or Esc, closes it.
  document.addEventListener('click', (e) => {
    if (!modeMenu.hidden && !modeMenu.contains(e.target) && e.target !== els.modeBtn) closeModeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modeMenu.hidden) closeModeMenu();
  });
}

/*
  The compact-mode controls. They delegate to the same handlers the HUD chips
  use rather than duplicating the logic — a second implementation of "nudge the
  sync" is a second thing to keep in step with the offset store.
*/
if (els.ccEarlier) els.ccEarlier.addEventListener('click', () => els.syncEarlierBtn.click());
if (els.ccLater) els.ccLater.addEventListener('click', () => els.syncLaterBtn.click());
if (els.ccTranslate) els.ccTranslate.addEventListener('click', () => els.translateBtn.click());

// The always-visible top-right toggles drive the same handlers as the HUD chips.
if (els.ttScript) els.ttScript.addEventListener('click', () => els.scriptBtn.click());
if (els.ttTranslate) els.ttTranslate.addEventListener('click', () => els.translateBtn.click());

/* --------------------------------------------- wallpaper pointer forwarding */
/*
  In wallpaper mode this window is a child of the desktop, and Windows sends
  clicks in that region to Progman's icon view rather than to us. Without this,
  wallpaper mode would be visuals and nothing else: no chips, no library, no
  preset browser.

  Main polls the cursor and the button (see startPointerForwarding) and sends
  coordinates; here they become real events on whatever element is under them.
  `elementFromPoint` is what makes this honest — the same element the user is
  pointing at gets the same event it would have got, so nothing downstream
  needs to know the input arrived by a different road.
*/
let wallpaperHover = null;

if (window.player.onWallpaperPointer) {
  window.player.onWallpaperPointer(({ x, y, clicked }) => {
    if (displayMode !== 'wallpaper') return;

    /* The HUD hides itself until the mouse moves, and that listener is on
       document — so this has to be a real event, not a flag. */
    document.dispatchEvent(new MouseEvent('mousemove', {
      clientX: x, clientY: y, bubbles: true,
    }));

    const el = document.elementFromPoint(x, y);
    if (el !== wallpaperHover) {
      // Hover state drives the preset cards' mark buttons and every chip's
      // highlight; without enter/leave they would all stay lit at once.
      if (wallpaperHover) {
        wallpaperHover.dispatchEvent(new MouseEvent('mouseleave', { clientX: x, clientY: y }));
      }
      if (el) el.dispatchEvent(new MouseEvent('mouseenter', { clientX: x, clientY: y }));
      wallpaperHover = el;
    }
    if (el) {
      el.dispatchEvent(new MouseEvent('mousemove', {
        clientX: x, clientY: y, bubbles: true,
      }));
    }

    if (clicked && el) {
      /* Focus first, because several controls read document.activeElement —
         the preset browser's key handling in particular. */
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new MouseEvent('click', {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
    }
  });
}

/*
  Surface the wallpaper window while a scrollable panel is open.

  Forwarded input covers clicks and hover but not the wheel, so the preset
  browser and the library — which scroll — could be opened in wallpaper mode
  but not used. Rather than forward yet more event types (wheel needs a global
  hook the main process deliberately avoids), the window briefly lifts to the
  foreground while a panel is open and settles back behind the desktop when it
  closes. Main does the lifting; this just tells it when a panel is up.

  A MutationObserver on the panels' `hidden` attribute keeps it in step no
  matter which of the many open/close paths fired, without hooking each one.
*/
const WALLPAPER_PANELS = [els.mdPanel, els.library, els.poster, els.keybox, els.presync]
  .filter(Boolean);

function anyPanelOpen() {
  return WALLPAPER_PANELS.some((el) => !el.hidden);
}

function syncWallpaperInteract() {
  if (!window.player.wallpaperInteract) return;
  window.player.wallpaperInteract(displayMode === 'wallpaper' && anyPanelOpen());
}

if (WALLPAPER_PANELS.length) {
  const panelObserver = new MutationObserver(syncWallpaperInteract);
  for (const el of WALLPAPER_PANELS) {
    panelObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
}

window.player.onDisplayMode(({ mode, insets }) => {
  displayMode = mode || 'full';

  /*
    In wallpaper mode the window fills the whole display so the visuals run edge
    to edge — which put the HUD, which lives along the bottom, underneath the
    taskbar. Invisible, and unclickable too: a cursor over the taskbar is not
    over the desktop, so forwarded input correctly refuses to fire there.

    The window keeps its full-bleed bounds and the CONTROLS move instead.
  */
  const inset = (insets && displayMode === 'wallpaper') ? insets : { top: 0, right: 0, bottom: 0, left: 0 };
  const root = document.documentElement.style;
  root.setProperty('--shell-bottom', `${inset.bottom || 0}px`);
  root.setProperty('--shell-top', `${inset.top || 0}px`);
  root.setProperty('--shell-left', `${inset.left || 0}px`);
  root.setProperty('--shell-right', `${inset.right || 0}px`);

  if (els.modeBtn) els.modeBtn.textContent = DISPLAY_MODE_LABELS[displayMode] || '▭ Size';
  markModeMenu();
  document.body.classList.toggle('mode-bar', displayMode === 'bar');
  document.body.classList.toggle('mode-strip', displayMode === 'strip');
  /* Wallpaper draws the full layout — it IS the desktop, so there is as much
     room as fullscreen. It is not compact, and must not take the compact path
     that tears the GPU surfaces out of the page. */
  document.body.classList.toggle('mode-wallpaper', displayMode === 'wallpaper');
  document.body.classList.toggle('mode-compact', isCompact());

  /* Leaving wallpaper with a panel still open must not leave the window stuck
     surfaced; re-evaluate against the new mode. */
  syncWallpaperInteract();

  if (isCompact()) {
    /*
      Take both GPU surfaces and the 2D canvas out of the page.

      Hiding them is not enough and never was: an untouched full-screen canvas
      is still a compositor layer blended into every frame, and the MilkDrop
      frame keeps its WebGL2 context, render targets and compiled preset
      resident until it is actually reloaded. In a 54px window that is the
      entire cost of fullscreen for none of the picture.
    */
    if (window.MilkDrop) window.MilkDrop.destroy();
    if (els.milkdrop) els.milkdrop.hidden = true;
    activeEngine = 'swirl';
    els.swirl.style.display = 'none';
    els.canvas.style.display = 'none';
    swirlHidden = true;
    canvasHidden = true;
  } else {
    els.swirl.style.display = '';
    els.canvas.style.display = '';
    swirlHidden = false;
    canvasHidden = false;
    swirlScale = 0;          // re-issue a resize at the new window size
    resizeCanvas();
  }
});

window.player.onVisibility(({ visible }) => {
  overlayVisible = visible !== false;
  // Resuming: forget the timestamps from before the pause so the first frame
  // back does not see a multi-minute dt and jump every animation forward.
  if (overlayVisible) {
    lastBackNow = 0;
    lastFrameAt = 0;
    lastDrawnAt = 0;
  }
});

window.player.onIdle(() => {
  flushBeatmap();                 // persist the last song's learned beats
  flushHeatmap();                 // ...and its energy arc
  flushTranscription();           // playback stopped — the song is over, so learn it
  if (window.Tempo) window.Tempo.reset();
  if (window.BeatMap) window.BeatMap.load(null);
  if (window.HeatMap) window.HeatMap.load(null);
  anticipation = 0;
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
  document.body.classList.remove('is-playing');
  els.progressFill.style.width = '0%';
  lastProgressPct = -1;
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

// On-screen timing nudge: the ⏪/⏩ chips step by 100ms; the offset chip itself is
// DRAGGABLE — drag left/right to scrub the sync live — and a plain click resets it.
els.syncEarlierBtn.addEventListener('click', () => setSyncOffset(currentOffsetMs - OFFSET_STEP_MS));
els.syncLaterBtn.addEventListener('click', () => setSyncOffset(currentOffsetMs + OFFSET_STEP_MS));

/* Drag-to-scrub the sync offset on the offset chip. 4ms per pixel, snapped to
   10ms; committed live (throttled) so the lyrics move as you drag. A drag that
   actually moved suppresses the trailing click so it doesn't reset to zero. */
const DRAG_MS_PER_PX = 4;
let offsetDragging = false;
let dragStartX = 0;
let dragStartOffset = 0;
let dragMoved = false;
let lastDragCommitAt = 0;

els.offset.addEventListener('pointerdown', (e) => {
  offsetDragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  dragStartOffset = currentOffsetMs;
  try { els.offset.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  els.offset.classList.add('is-dragging');
});

els.offset.addEventListener('pointermove', (e) => {
  if (!offsetDragging) return;
  const dx = e.clientX - dragStartX;
  if (Math.abs(dx) > 3) dragMoved = true;
  const next = Math.round((dragStartOffset + dx * DRAG_MS_PER_PX) / 10) * 10;
  applyOffsetLabel(next); // live label + local mirror
  const now = performance.now();
  if (now - lastDragCommitAt > 80) { // throttle the IPC while dragging
    lastDragCommitAt = now;
    window.player.setOffset(next);
  }
});

function endOffsetDrag() {
  if (!offsetDragging) return;
  offsetDragging = false;
  els.offset.classList.remove('is-dragging');
  setSyncOffset(currentOffsetMs); // final commit + reflect the stored value
}
els.offset.addEventListener('pointerup', endOffsetDrag);
els.offset.addEventListener('pointercancel', endOffsetDrag);

els.offset.addEventListener('click', () => {
  if (dragMoved) { dragMoved = false; return; } // ignore the click that ends a drag
  setSyncOffset(0);
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

/* Backdrop opacity cycle: faint → tinted → vivid → solid. Persisted locally so
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
  updateHero(); // no-lyric mode shows the animated song-name hero instead
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

/* ---------------------------------------------- per-song visual look */

/** Stable identity for a track, matching the main process's cache key. */
function trackLookKey(track) {
  return `${(track.artist || '').trim()}|${(track.title || '').trim()}`.toLowerCase();
}

/** User overrides, keyed by track. Songs without one get an automatic look. */
function readLookOverrides() {
  try { return JSON.parse(localStorage.getItem('visualLooks') || '{}') || {}; }
  catch { return {}; }
}

/**
 * Choose the look for a track: an explicit override if the user set one,
 * otherwise a look derived from the track identity — random across songs,
 * identical every time you replay the same one.
 * @param {object|null} track
 */
function applyLookForTrack(track) {
  if (!track) return;
  const override = readLookOverrides()[trackLookKey(track)];
  presetId = override
    ? window.VisualPresets.byId(override).id
    : window.VisualPresets.forTrack(trackLookKey(track)).id;
  applyPresetLabel();
}

/* Visual preset chip: cycles the named looks and persists the choice. The
   label always shows the preset the USER picked, even when the FPS governor is
   temporarily rendering a cheaper one — otherwise the chip would appear to
   change by itself. */
function applyPresetLabel() {
  const preset = window.VisualPresets.byId(presetId);
  // When the governor has stepped in, say so. Silently rendering a different
  // look than the chip claims is worse than the dropped frames it prevents.
  const substituted = renderedPresetId && renderedPresetId !== presetId;
  els.presetBtn.textContent = substituted ? `◈ ${preset.name} ⚡` : `◈ ${preset.name}`;
  els.presetBtn.title = substituted
    ? `${preset.name} — running "Minimal" to hold the frame rate`
    : `Visual preset — ${preset.name} (click to cycle)`;
}

/* Clicking the chip re-rolls the look for the CURRENT song and remembers that
   choice for it. Songs otherwise pick their own look automatically, so this is
   an override rather than a global mode switch. */
els.presetBtn.addEventListener('click', () => {
  presetId = window.VisualPresets.next(presetId).id;
  if (currentTrack) {
    const overrides = readLookOverrides();
    overrides[trackLookKey(currentTrack)] = presetId;
    try { localStorage.setItem('visualLooks', JSON.stringify(overrides)); } catch { /* ignore */ }
  }
  applyPresetLabel();
});

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
    populateLocalCliPicker();
    els.keyInput.focus();
  } else {
    closeKeybox();
  }
});

/**
 * Fill the key panel's "Local AI" picker with the installed CLIs, on demand —
 * so a CLI can be chosen any time, not only after a cloud request has failed.
 * The current choice is marked, and picking one (or "off") is saved immediately.
 */
async function populateLocalCliPicker() {
  const box = document.getElementById('keybox-cli');
  if (!box || !window.player.localcliDetect) return;
  box.textContent = 'checking…';
  let detected = [];
  let chosen = null;
  try {
    detected = await window.player.localcliDetect();
    const status = await window.player.localcliStatus();
    chosen = status && status.consented ? status.id : null;
  } catch { /* leave empty */ }

  const installed = (detected || []).filter((c) => c.installed);
  box.textContent = '';

  if (installed.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'localcli__hint';
    hint.textContent = 'No local AI CLI found. Install Claude, Gemini or Ollama to use one.';
    box.appendChild(hint);
    return;
  }

  const ordered = [...installed].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
  // An explicit "off" so the cloud-only user can turn a prior choice back off.
  const options = [{ id: null, label: 'Off (cloud only)' }, ...ordered];
  for (const c of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    const badge = c.id === null ? '' : (c.verified ? ' ✓' : (c.unverified ? ' · experimental' : ' · best-effort'));
    btn.textContent = `${c.label}${badge}`;
    btn.setAttribute('aria-pressed', String((c.id || null) === (chosen || null)));
    if (c.verified) btn.classList.add('chip--recommended');
    btn.addEventListener('click', async () => {
      await window.player.localcliConsent(c.id);
      populateLocalCliPicker();
      els.keyStatus.textContent = c.id ? `local AI: ${c.label}` : 'local AI off';
    });
    box.appendChild(btn);
  }
}

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

/* ----------------------------------------------------------------- library */

/*
  The library.

  This replaces a `<ul>` capped at 30vh inside the pre-sync panel, inside a HUD
  that is invisible until the cursor moves. Songs are what this app is about;
  they were three lines of small text behind two disclosures.

  Every song the app has ever seen is here — cached lyrics, learned beat maps
  and heat maps — alongside anything added from disk, and a card is now
  clickable because the app can play files itself.
*/

/** Everything known, before the search filter. */
let libraryItems = [];
/** Local files added this session, keyed by cache key so they merge with it. */
const localFiles = new Map();

function libraryKey(artist, title) {
  return `${(artist || '').toLowerCase().trim()}|${(title || '').toLowerCase().trim()}`;
}

/** Fetch the cached library from main and merge in locally-added files. */
async function refreshSyncedList() {
  if (!els.libraryGrid || !window.player.listSynced) return;
  let cached = [];
  try {
    cached = await window.player.listSynced();
  } catch { /* show whatever we already have */ }

  const merged = new Map();
  for (const it of cached) {
    merged.set(libraryKey(it.artist, it.title), {
      title: it.title || it.key,
      artist: it.artist || '',
      hasCues: Boolean(it.hasCues),
      hasBeatmap: Boolean(it.hasBeatmap),
      hasHeatmap: Boolean(it.hasHeatmap),
      localPath: null,
    });
  }
  // A local file for a song we already know about should light up that card
  // rather than appearing twice.
  for (const [key, file] of localFiles) {
    const existing = merged.get(key);
    if (existing) existing.localPath = file.localPath;
    else {
      merged.set(key, {
        title: file.title, artist: file.artist,
        hasCues: false, hasBeatmap: false, hasHeatmap: false,
        localPath: file.localPath,
      });
    }
  }

  libraryItems = [...merged.values()];
  renderLibrary();
}

/** Draw the cards for the current search term. */
function renderLibrary() {
  if (!els.libraryGrid) return;
  const term = (els.librarySearch && els.librarySearch.value || '').toLowerCase().trim();
  const items = term
    ? libraryItems.filter((it) => `${it.title} ${it.artist}`.toLowerCase().includes(term))
    : libraryItems;

  els.libraryGrid.textContent = '';
  if (els.libraryCount) {
    els.libraryCount.textContent = term
      ? `${items.length} of ${libraryItems.length}`
      : `${libraryItems.length} song${libraryItems.length === 1 ? '' : 's'}`;
  }

  if (els.libraryEmpty) {
    const empty = items.length === 0;
    els.libraryEmpty.hidden = !empty;
    els.libraryEmpty.textContent = libraryItems.length === 0
      ? 'Nothing here yet — add songs from disk, or play something and it will appear.'
      : 'No songs match that search.';
  }

  const frag = document.createDocumentFragment();
  for (const it of items) {
    frag.appendChild(libraryCard(it));
  }
  els.libraryGrid.appendChild(frag);
}

/**
 * One card. Playable only when we have the file — a cached song we can merely
 * describe is shown but disabled, which is honest about what clicking would do.
 * @param {object} it
 * @returns {HTMLElement}
 */
function libraryCard(it) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'library__card';
  if (!it.localPath) {
    card.disabled = true;
    card.title = 'Known from an earlier play — add the file to play it here';
  } else {
    card.title = `Play ${it.title}`;
    card.addEventListener('click', () => {
      closeLibrary();
      window.LocalPlayer.enqueue([{
        localPath: it.localPath, title: it.title, artist: it.artist,
      }]);
    });
  }

  const art = document.createElement('div');
  art.className = 'library__art';
  art.textContent = it.localPath ? '▶' : '♪';

  const meta = document.createElement('div');
  meta.className = 'library__meta';
  const song = document.createElement('div');
  song.className = 'library__song';
  song.textContent = it.title;
  const artist = document.createElement('div');
  artist.className = 'library__artist';
  artist.textContent = it.artist || 'Unknown artist';

  // What the app already knows about this song, at a glance.
  const badges = document.createElement('div');
  badges.className = 'library__badges';
  for (const [on, label, hint] of [
    [it.hasCues, 'lyrics', 'lyrics cached — plays offline'],
    [it.hasBeatmap, 'beats', 'beat map learned'],
    [it.hasHeatmap, 'shape', 'energy arc learned — anticipation works'],
  ]) {
    const b = document.createElement('span');
    b.className = `library__badge${on ? ' library__badge--on' : ''}`;
    b.textContent = label;
    b.title = on ? hint : `no ${label} yet`;
    badges.appendChild(b);
  }

  meta.append(song, artist, badges);
  card.append(art, meta);
  return card;
}

/* ------------------------------------------------------- cover art picker */
/*
  The artwork search returns one winner and is right most of the time. When it
  is wrong — the long-standing "wrong cover" complaint — there was nothing the
  user could do. This panel shows what the three sources actually found.

  It deliberately includes the near-misses the automatic pick rejects. That
  threshold exists to stop the app *asserting* a wrong cover; a person looking
  at a grid can see at a glance which one is their album, and those rejected
  rows are precisely what they need when the automatic answer failed.

  Choosing recolours the whole app, because the cover has always driven
  `extractArtPalette()`. That is deliberate: a poster that disagrees with the
  colours around it looks like a bug.
*/

/** Whether the cover currently showing was hand-picked rather than found. */
let artworkChosen = false;

/** The URL of the chosen cover, so its tile can show as selected. */
let artworkChosenUrl = null;

function closePoster() {
  if (els.poster) els.poster.hidden = true;
  if (els.posterBtn) els.posterBtn.setAttribute('aria-pressed', 'false');
}

async function openPoster() {
  if (!els.poster) return;
  els.poster.hidden = false;
  document.body.classList.add('show-cursor');
  if (els.posterBtn) els.posterBtn.setAttribute('aria-pressed', 'true');

  if (!currentTrack) {
    els.posterGrid.replaceChildren();
    els.posterStatus.textContent = 'nothing playing';
    return;
  }

  els.posterGrid.replaceChildren();
  els.posterStatus.textContent = 'searching…';

  // Captured so a track change while the search is in flight cannot paint one
  // song's covers over another's.
  const asked = currentTrack;
  let res;
  try {
    res = await window.player.artworkCandidates(asked);
  } catch (err) {
    els.posterStatus.textContent = err.message || 'search failed';
    return;
  }
  if (currentTrack !== asked || els.poster.hidden) return;

  const list = (res && res.candidates) || [];
  if (list.length === 0) {
    els.posterStatus.textContent = res && res.message
      ? res.message
      : 'no covers found for this track';
    return;
  }

  els.posterStatus.textContent = artworkChosen
    ? `${list.length} found · using your pick`
    : `${list.length} found · click one to use it`;
  els.posterGrid.replaceChildren(...list.map((c) => posterCard(c, asked)));
}

/**
 * One candidate tile.
 * @param {{thumb: string, fullUrl: string, source: string, title: string, artist: string}} c
 * @param {object} track the track this list was fetched for
 * @returns {HTMLButtonElement}
 */
function posterCard(c, track) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'poster__card';
  card.title = `${c.title || 'Unknown'} — ${c.artist || 'Unknown'} (${c.source})`;
  card.setAttribute('aria-pressed', String(c.fullUrl === artworkChosenUrl));

  const img = document.createElement('img');
  img.className = 'poster__img';
  img.src = c.thumb;
  img.alt = '';

  const meta = document.createElement('div');
  meta.className = 'poster__meta';
  const song = document.createElement('div');
  song.className = 'poster__song';
  song.textContent = c.title || 'Unknown';
  const src = document.createElement('div');
  src.className = 'poster__source';
  src.textContent = `${c.artist || 'Unknown'} · ${c.source}`;
  meta.append(song, src);

  card.append(img, meta);
  card.addEventListener('click', async () => {
    els.posterStatus.textContent = 'fetching full size…';
    const out = await window.player.chooseArtwork({
      track,
      url: c.fullUrl,
      artistName: c.artist,
      trackName: c.title,
    });
    if (out && out.status === 'ok') {
      artworkChosenUrl = c.fullUrl;
      for (const el of els.posterGrid.children) el.setAttribute('aria-pressed', 'false');
      card.setAttribute('aria-pressed', 'true');
      els.posterStatus.textContent = 'using your pick';
    } else {
      els.posterStatus.textContent = (out && out.message) || 'could not use that cover';
    }
  });
  return card;
}

if (els.posterBtn) {
  els.posterBtn.addEventListener('click', () => {
    if (els.poster && els.poster.hidden) openPoster();
    else closePoster();
  });
}
if (els.posterClose) els.posterClose.addEventListener('click', closePoster);
if (els.posterAuto) {
  els.posterAuto.addEventListener('click', async () => {
    if (!currentTrack) return;
    await window.player.clearArtworkChoice(currentTrack);
    artworkChosen = false;
    artworkChosenUrl = null;
    for (const el of els.posterGrid.children) el.setAttribute('aria-pressed', 'false');
    els.posterStatus.textContent = 'back to the automatic pick';
  });
}

/* -------------------------------------------------- MilkDrop preset browser */
/*
  0.19.0 shipped 395 presets and no way to reach them: two named entry points,
  and everything else only by waiting for a drop on a 42-second cooldown. A
  catalogue you cannot open is not a catalogue.

  0.20.0 gave it a search box and a list of names. That was better and still
  wrong, because a preset is a picture and its name is not: these are titles
  written by strangers in 2003 — `$$$ Royal - Mashup (160)`, `!!!---flexi +
  amandio c - organic12-3d-2` — and no amount of searching them tells you what
  any of them looks like. Choosing meant loading one and looking, 1754 times.

  So 0.21.0 shows the pictures. Three things follow from that, and all three are
  what actually make a catalogue this size usable:

    - **Previews.** Rendered by the engine frame at 192x108 with synthetic
      audio, cached to disk, and only ever generated for cards you have actually
      scrolled to. A background pass over all 1754 would cost minutes of GPU
      time for previews of presets nobody asked to see.

    - **Liking and hiding.** With 100 presets a search box is enough. With 1754
      you need to keep the handful you love and never see the ones you hate
      again — and a hidden preset is excluded from the dice and the beat-synced
      cycle too, or hiding it would mean nothing.

    - **Stepping.** The arrow keys move through the filtered set and load each
      one instantly, so browsing is watching rather than reading. This is the
      part the old list could not do at all.

  Pinning uses the same per-track shape as the visual-look override, so a
  preset you liked on a song comes back next play. It is stored separately from
  `visualLooks` because it answers a different question — that one picks the
  LOOK (which may not even be a MilkDrop look), this one picks the preset
  within it.
*/

/** How many cards to render at once; more arrive as the grid is scrolled. */
const MDP_PAGE = 60;

/** Storage keys. Sets rather than maps: membership is the whole question. */
const MDP_FAV_KEY = 'milkdropFavourites';
const MDP_HIDDEN_KEY = 'milkdropHidden';
const MDP_SEEN_KEY = 'milkdropSeen';

/** @param {string} key @returns {Set<string>} */
function readNameSet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

/** @param {string} key @param {Set<string>} set */
function writeNameSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

let mdpFavourites = readNameSet(MDP_FAV_KEY);
let mdpHidden = readNameSet(MDP_HIDDEN_KEY);
let mdpSeen = readNameSet(MDP_SEEN_KEY);

/** 'all' | 'fav' | 'unseen' — which slice of the catalogue the grid shows. */
let mdpFilter = 'all';
/** How many of the current match set are rendered. */
let mdpShown = MDP_PAGE;
/** The filtered names as last rendered; the arrow keys step through this. */
let mdpMatches = [];
/** Previews already in hand this session, so re-filtering repaints instantly. */
const mdpThumbCache = new Map();
/** Names queued for rendering, oldest first, one at a time. */
const mdpThumbQueue = [];
let mdpThumbBusy = false;
/** @type {IntersectionObserver|null} watches cards and the "more" sentinel */
let mdpObserver = null;

/**
 * Record that a preset has actually been watched.
 *
 * Drives the "Unseen" filter, which is the only practical way to work through
 * a catalogue of 1754 over many sessions — a search box cannot tell you where
 * you got to.
 *
 * @param {string} name
 */
function markMilkdropSeen(name) {
  if (!name || mdpSeen.has(name)) return;
  mdpSeen.add(name);
  writeNameSet(MDP_SEEN_KEY, mdpSeen);
}

/**
 * Names the automatic paths are allowed to choose from.
 *
 * Hiding a preset has to mean it stops appearing, or it is a bookmark rather
 * than a veto — the beat-synced cycle and the dice are where an unwanted preset
 * actually shows up.
 *
 * @returns {string[]}
 */
function milkdropAllowed() {
  const all = window.MilkDrop.names();
  if (mdpHidden.size === 0) return all;
  const kept = all.filter((n) => !mdpHidden.has(n));
  // Never hand back nothing: someone who hides everything gets the catalogue
  // back rather than a frozen visual.
  return kept.length > 0 ? kept : all;
}

/*
  A hand-picked shortlist of presets that reliably look good.

  The catalogue is 1754 presets contributed over twenty years, and a large
  share of them are dim, broken on this renderer, or just ugly — so opening
  MilkDrop on a *random* one, or cycling the whole set on the beat, lands on a
  dud more often than not. That is what "the default MilkDrop sucks" was.

  These are verified present in the shipped corpus (see the curated check in
  scripts) and chosen for being bright, legible under lyrics, and stable. They
  are the pool the automatic paths draw from until the user has liked some of
  their own; the browser still offers all 1754.
*/
const MILKDROP_CURATED = [
  'Cope - Cartune (extrusion machine) [fixed]',
  'Geiss - Artifact Plasma',
  'Flexi - Julia fractal',
  'Rovastar - VooV′s Organic Light',
  'Flexi + fiShbRaiN - operation fatcap II',
  'Aderrasi - Kevlar Tunnel',
  'Geiss - Artifact Plasma 2',
  '$$$ Royal - Mashup (169)',
  'martin - mandelbox explorer - high speed demo version',
  'Flexi - alien fish pond',
];

/**
 * The pool the dice and the beat-synced cycle draw from.
 *
 * Favourites first, once there are enough to cycle. Otherwise the curated
 * shortlist (minus anything hidden), so the automatic look is a good one rather
 * than a roll of the 1754-sided die. Falls through to the whole allowed set
 * only if the curated names somehow are not in this corpus.
 *
 * @returns {string[]}
 */
function milkdropCyclePool() {
  const allowed = milkdropAllowed();
  const liked = allowed.filter((n) => mdpFavourites.has(n));
  if (liked.length > 1) return liked;

  const allowedSet = new Set(allowed);
  const curated = MILKDROP_CURATED.filter((n) => allowedSet.has(n));
  return curated.length > 0 ? curated : allowed;
}

/** The preset to open MilkDrop on when nothing is pinned or chosen. */
function milkdropDefault() {
  const pool = milkdropCyclePool();
  return pool.length ? pool[0] : null;
}

/** Per-track MilkDrop preset pins, keyed like every other per-track override. */
function readMilkdropPins() {
  try { return JSON.parse(localStorage.getItem('milkdropPins') || '{}') || {}; }
  catch { return {}; }
}

function writeMilkdropPin(name) {
  if (!currentTrack) return;
  const pins = readMilkdropPins();
  const key = trackLookKey(currentTrack);
  if (name) pins[key] = name;
  else delete pins[key];
  try { localStorage.setItem('milkdropPins', JSON.stringify(pins)); } catch { /* ignore */ }
}

/** The pinned preset for the current track, if any. */
function pinnedMilkdrop() {
  if (!currentTrack) return null;
  return readMilkdropPins()[trackLookKey(currentTrack)] || null;
}

function closeMilkdropPanel() {
  if (els.mdPanel) els.mdPanel.hidden = true;
  if (els.mdBtn) els.mdBtn.setAttribute('aria-pressed', 'false');
  if (mdpObserver) { mdpObserver.disconnect(); mdpObserver = null; }
  // Stop the preview pipeline and let its WebGL context go. Nothing queued is
  // worth holding a second context open for once the panel is shut.
  mdpThumbQueue.length = 0;
  if (window.MilkDrop.endThumbnails) window.MilkDrop.endThumbnails();
}

function openMilkdropPanel() {
  if (!els.mdPanel || !window.MilkDrop) return;
  els.mdPanel.hidden = false;
  document.body.classList.add('show-cursor');
  els.mdBtn.setAttribute('aria-pressed', 'true');
  mdpShown = MDP_PAGE;
  renderMilkdropList();
  if (els.mdSearch) els.mdSearch.focus();
}

/**
 * Switch to a preset from the browser.
 *
 * Recorded as the session choice, not merely loaded — `applyEngine` owns what
 * should be showing and would revert a bare load on the next frame. Cut rather
 * than blend: someone browsing wants the preset they picked, not a three-second
 * cross-fade into it.
 *
 * @param {string} name
 */
function chooseMilkdrop(name) {
  milkdropChosen = name;
  milkdropName = window.MilkDrop.loadPreset(name, 0);
  lastMilkdropSwitchAt = performance.now();
  markMilkdropSeen(name);
  for (const el of els.mdList.querySelectorAll('[aria-current="true"]')) {
    el.removeAttribute('aria-current');
  }
  const card = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"]`);
  if (card) card.setAttribute('aria-current', 'true');
  updateMilkdropPinChip();
}

/** Preset names contain quotes and brackets; a selector needs them escaped. */
function cssEscape(value) {
  return window.CSS && window.CSS.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** The names matching the current search and filter. */
function milkdropMatches() {
  const all = window.MilkDrop.names();
  const q = ((els.mdSearch && els.mdSearch.value) || '').trim().toLowerCase();
  return all.filter((name) => {
    if (q && !name.toLowerCase().includes(q)) return false;
    if (mdpFilter === 'fav') return mdpFavourites.has(name);
    // Hidden presets stay reachable through search and the ♥ filter — hiding
    // is "stop showing me this", not "delete it", and un-hiding needs a route.
    if (mdpHidden.has(name) && !q) return false;
    if (mdpFilter === 'unseen') return !mdpSeen.has(name);
    return true;
  });
}

/** Redraw the grid against the current search, filter and page size. */
function renderMilkdropList() {
  if (!els.mdList) return;
  mdpMatches = milkdropMatches();
  const shown = mdpMatches.slice(0, mdpShown);
  const current = window.MilkDrop.current();

  const total = mdpMatches.length;
  renderMilkdropStatus();

  const cards = shown.map((name) => buildMilkdropCard(name, name === current));

  if (shown.length < total) {
    const more = document.createElement('p');
    more.className = 'mdp__more';
    more.dataset.more = '1';
    more.textContent = `${total - shown.length} more…`;
    cards.push(more);
  }
  els.mdList.replaceChildren(...cards);
  observeMilkdropCards();
}

/**
 * One card: a picture, a name, and the two marks.
 * @param {string} name
 * @param {boolean} isCurrent
 */
function buildMilkdropCard(name, isCurrent) {
  /*
    A div, not a button. As a <button> the card measured 2px tall around a
    90px image: Chromium lays a button's children out in a special content box
    that did not take its height from an aspect-ratio-sized child, so every
    card collapsed and the grid's pager then ran away filling a viewport that
    could never be filled. The role and tabindex keep it a button to anything
    that cares; only the layout changes.
  */
  const card = document.createElement('div');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.className = 'mdp__card';
  card.dataset.preset = name;
  card.title = name;
  if (mdpFavourites.has(name)) card.classList.add('is-fav');
  if (isCurrent) card.setAttribute('aria-current', 'true');

  const shot = document.createElement('img');
  shot.className = 'mdp__shot';
  shot.alt = '';
  const cached = mdpThumbCache.get(name);
  if (cached) shot.src = cached;
  card.appendChild(shot);

  const label = document.createElement('span');
  label.className = 'mdp__name';
  label.textContent = name;
  card.appendChild(label);

  const marks = document.createElement('span');
  marks.className = 'mdp__marks';

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'mdp__mark';
  fav.textContent = '♥';
  fav.title = 'Like this preset (F)';
  fav.setAttribute('aria-pressed', String(mdpFavourites.has(name)));
  fav.addEventListener('click', (e) => { e.stopPropagation(); toggleMilkdropFavourite(name); });
  marks.appendChild(fav);

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'mdp__mark';
  hide.textContent = '🚫';
  hide.title = 'Never show this one again (X)';
  hide.setAttribute('aria-pressed', String(mdpHidden.has(name)));
  hide.addEventListener('click', (e) => { e.stopPropagation(); toggleMilkdropHidden(name); });
  marks.appendChild(hide);

  card.appendChild(marks);
  card.addEventListener('click', () => chooseMilkdrop(name));
  // A div with role=button is not activated by the keyboard for free.
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); chooseMilkdrop(name); }
  });
  return card;
}

/** @param {string} name */
function toggleMilkdropFavourite(name) {
  if (mdpFavourites.has(name)) mdpFavourites.delete(name);
  else {
    mdpFavourites.add(name);
    // Liking something you have hidden is a change of mind, not a conflict.
    mdpHidden.delete(name);
    writeNameSet(MDP_HIDDEN_KEY, mdpHidden);
  }
  writeNameSet(MDP_FAV_KEY, mdpFavourites);
  renderMilkdropList();
}

/** @param {string} name */
function toggleMilkdropHidden(name) {
  if (mdpHidden.has(name)) mdpHidden.delete(name);
  else {
    mdpHidden.add(name);
    mdpFavourites.delete(name);
    writeNameSet(MDP_FAV_KEY, mdpFavourites);
    /* Hiding the preset that is on screen should take it off screen, or the
       veto does not appear to have worked. */
    if (window.MilkDrop.current() === name) {
      const allowed = milkdropAllowed();
      if (allowed.length) chooseMilkdrop(allowed[Math.floor(Math.random() * allowed.length)]);
    }
  }
  writeNameSet(MDP_HIDDEN_KEY, mdpHidden);
  renderMilkdropList();
}

/* ------------------------------------------------------ preview generation */

/**
 * Watch the cards on screen. Previews are generated for what is visible and
 * nothing else: a background pass over 1754 presets is minutes of GPU time
 * spent on images nobody asked to see, and it competes with the visuals.
 */
function observeMilkdropCards() {
  if (mdpObserver) mdpObserver.disconnect();
  if (!els.mdList) return;

  mdpObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target.dataset.more) {
        /*
          Extend only if the grid can actually be scrolled, or if it is not yet
          full. A collapsed layout leaves this sentinel permanently on screen,
          and without the guard the pager walks the whole catalogue into the DOM
          before anyone has touched the scrollbar — which is precisely what
          happened when the card height measured 2px.
        */
        const grid = els.mdList;
        const scrollable = grid.scrollHeight > grid.clientHeight + 4;
        if (!scrollable && mdpShown > MDP_PAGE * 3) return;
        mdpShown += MDP_PAGE;
        renderMilkdropList();
        return;
      }
      const name = entry.target.dataset.preset;
      if (name && !mdpThumbCache.has(name)) queueMilkdropThumb(name);
    }
  }, { root: els.mdList, rootMargin: '160px' });

  for (const child of els.mdList.children) mdpObserver.observe(child);
  loadCachedThumbs();
}

/** Paint whatever previews are already on disk, in one round trip. */
function loadCachedThumbs() {
  const wanted = [...els.mdList.querySelectorAll('[data-preset]')]
    .map((el) => el.dataset.preset)
    .filter((name) => !mdpThumbCache.has(name));
  if (wanted.length === 0 || !window.player.milkdropThumbs) return;

  window.player.milkdropThumbs(wanted).then((found) => {
    let painted = 0;
    for (const [name, url] of Object.entries(found || {})) {
      mdpThumbCache.set(name, url);
      const img = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"] .mdp__shot`);
      if (img) { img.src = url; painted += 1; }
    }
    if (painted) renderMilkdropStatus();
  }).catch(() => { /* previews are a nicety; the names still work */ });
}

/**
 * Just the count line.
 *
 * Separate from the grid because previews arrive one at a time: rebuilding
 * 60 cards to update a number would replace the card under the cursor sixty
 * times while someone is trying to click it.
 */
function renderMilkdropStatus() {
  if (!els.mdStatus) return;
  const total = mdpMatches.length;
  if (total === 0) {
    els.mdStatus.textContent = mdpFilter === 'fav'
      ? 'nothing liked yet — press ♥ on one you want to keep'
      : 'nothing matches';
    return;
  }
  const shown = mdpMatches.slice(0, mdpShown);
  const pending = shown.filter((n) => !mdpThumbCache.has(n)).length;
  els.mdStatus.textContent = `${total} preset${total === 1 ? '' : 's'}`
    + (total > shown.length ? ` · showing ${shown.length}` : '')
    + (mdpHidden.size ? ` · ${mdpHidden.size} hidden` : '')
    + (pending ? ` · ${pending} preview${pending === 1 ? '' : 's'} to render` : '');
}

/** @param {string} name */
function queueMilkdropThumb(name) {
  if (mdpThumbQueue.includes(name)) return;
  mdpThumbQueue.push(name);
  drainMilkdropThumbs();
}

/**
 * Render queued previews one at a time.
 *
 * Serialised on purpose. Each one is a preset compile plus 34 frames on the
 * same GPU that is drawing the live visual, and firing a dozen at once is how
 * the panel would stutter the thing it is a browser for.
 */
function drainMilkdropThumbs() {
  if (mdpThumbBusy || mdpThumbQueue.length === 0) return;
  if (!els.mdPanel || els.mdPanel.hidden) { mdpThumbQueue.length = 0; return; }

  const name = mdpThumbQueue.shift();
  if (mdpThumbCache.has(name)) { drainMilkdropThumbs(); return; }

  mdpThumbBusy = true;
  window.MilkDrop.thumbnail(name).then((url) => {
    if (url) {
      mdpThumbCache.set(name, url);
      const img = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"] .mdp__shot`);
      if (img) img.src = url;
      if (window.player.milkdropThumbSave) {
        window.player.milkdropThumbSave(name, url).catch(() => { /* cache only */ });
      }
      renderMilkdropStatus();
    }
  }).finally(() => {
    mdpThumbBusy = false;
    /* One frame between previews so the live visual and the panel both get a
       turn. Without it a long queue holds the main thread for seconds. */
    requestAnimationFrame(() => drainMilkdropThumbs());
  });
}

/** The pin chip reflects whether the preset on screen is the pinned one. */
function updateMilkdropPinChip() {
  if (!els.mdPin) return;
  const pinned = pinnedMilkdrop();
  const on = Boolean(pinned && pinned === window.MilkDrop.current());
  els.mdPin.setAttribute('aria-pressed', String(on));
  els.mdPin.title = on
    ? 'Pinned to this song — click to unpin'
    : 'Keep this preset for this song';
}

if (els.mdBtn) {
  els.mdBtn.addEventListener('click', () => {
    if (els.mdPanel && els.mdPanel.hidden) openMilkdropPanel();
    else closeMilkdropPanel();
  });
}
if (els.mdClose) els.mdClose.addEventListener('click', closeMilkdropPanel);
if (els.mdSearch) {
  els.mdSearch.addEventListener('input', () => {
    mdpShown = MDP_PAGE;
    renderMilkdropList();
  });
}

for (const chip of document.querySelectorAll('.mdp__filter')) {
  chip.addEventListener('click', () => {
    mdpFilter = chip.dataset.filter;
    for (const other of document.querySelectorAll('.mdp__filter')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    mdpShown = MDP_PAGE;
    renderMilkdropList();
  });
}

if (els.mdRandom) {
  els.mdRandom.addEventListener('click', () => {
    const allowed = milkdropAllowed();
    if (allowed.length === 0) return;
    chooseMilkdrop(allowed[Math.floor(Math.random() * allowed.length)]);
  });
}

/*
  Step through the filtered set with the arrow keys, loading each one as it is
  reached. This is the part a list of names could not do: browsing 1754 presets
  is watching, not reading, and a preview is a still of something that moves.

  Scoped to the panel and skipped while the search box has focus, where the
  left/right keys belong to the text cursor.
*/
if (els.mdPanel) {
  /* On the document rather than the panel: re-rendering the grid replaces every
     card, which drops focus to the body — and a key handler bound to the panel
     would then stop firing exactly when someone is stepping through it. */
  document.addEventListener('keydown', (e) => {
    if (els.mdPanel.hidden) return;

    /*
      The panel focuses its search box on open, which is right — narrowing 1754
      presets by typing is the first thing anyone does. But it made the arrow
      keys belong to the text caret, and stepping through previews is the whole
      point of the rebuild, so it was dead on arrival: measured in the harness,
      the arrow key moved nothing.

      The rule that keeps both: arrows always step, and the letter keys act only
      when there is no query being typed. Nobody navigates a caret through a
      search box they can retype in a second; everybody expects `f` in a focused
      text field to write an f.
    */
    const query = ((els.mdSearch && els.mdSearch.value) || '').length > 0;
    const typing = document.activeElement === els.mdSearch && query;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];

    if (step) {
      if (mdpMatches.length === 0) return;
      e.preventDefault();
      const at = mdpMatches.indexOf(window.MilkDrop.current());
      const next = (at + step + mdpMatches.length) % mdpMatches.length;
      const name = mdpMatches[next];
      // Extend the page if stepping walked past what is rendered, so the
      // selected card can be scrolled to and marked.
      if (next >= mdpShown) { mdpShown = next + MDP_PAGE; renderMilkdropList(); }
      chooseMilkdrop(name);
      const card = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"]`);
      if (card) card.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (typing) return;
    const showing = window.MilkDrop.current();
    if (!showing) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleMilkdropFavourite(showing); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); toggleMilkdropHidden(showing); }
    else if (e.key === 'Enter' && els.mdPin) { e.preventDefault(); els.mdPin.click(); }
  });
}
if (els.mdPin) {
  els.mdPin.addEventListener('click', () => {
    if (!currentTrack) return;
    const showing = window.MilkDrop.current();
    const already = pinnedMilkdrop() === showing;
    writeMilkdropPin(already ? null : showing);
    updateMilkdropPinChip();
    els.mdStatus.textContent = already ? 'unpinned' : `pinned to ${currentTrack.title || 'this song'}`;
  });
}

function openLibrary() {
  if (!els.library) return;
  els.library.hidden = false;
  document.body.classList.add('show-cursor');
  refreshSyncedList();
  if (els.librarySearch) els.librarySearch.focus();
}

function closeLibrary() {
  if (els.library) els.library.hidden = true;
}

/** Add files from disk to the library, and start playing them. */
async function addLocalFiles(fromFolder) {
  const picked = fromFolder
    ? await window.player.openLocalFolder()
    : await window.player.openLocalFiles();
  if (!picked || picked.length === 0) return;
  for (const f of picked) localFiles.set(libraryKey(f.artist, f.title), f);
  refreshSyncedList();
  window.LocalPlayer.enqueue(picked);
}

if (els.libraryBtn) els.libraryBtn.addEventListener('click', openLibrary);
if (els.libraryClose) els.libraryClose.addEventListener('click', closeLibrary);
if (els.librarySearch) els.librarySearch.addEventListener('input', renderLibrary);
if (els.libraryAdd) els.libraryAdd.addEventListener('click', () => addLocalFiles(false));
if (els.libraryAddFolder) els.libraryAddFolder.addEventListener('click', () => addLocalFiles(true));

/* ------------------------------------------------------- local playback UI */

/*
  The transport only exists while a local file is loaded. When the overlay is
  watching Spotify, drawing play/pause buttons that cannot control it would be
  a lie about what this app can do.
*/
function updateTransport() {
  if (!els.transport || !window.LocalPlayer) return;
  const active = window.LocalPlayer.isActive();
  els.transport.hidden = !active;
  if (!active) return;
  const el = window.LocalPlayer.audioElement();
  if (els.trPlay) els.trPlay.textContent = el && el.paused ? '▶' : '⏸';
  if (els.trNow) {
    const q = window.LocalPlayer.queue;
    const i = window.LocalPlayer.index;
    els.trNow.textContent = q.length > 1 ? `${i + 1} / ${q.length}` : '';
  }
}

if (window.LocalPlayer) {
  /*
    A local file drives the whole app: position comes from `audio.currentTime`
    (exact, where SMTC is a 250ms poll), and the element is tapped directly for
    the reactive envelope — so the visuals react with no loopback capture and no
    permission prompt at all.
  */
  window.LocalPlayer.on('track', (track) => {
    durationMs = track.durationMs || 0;
    updateTransport();
    const el = window.LocalPlayer.audioElement();
    if (el && !audioEnabled && window.AudioReactive) {
      audioEnabled = window.AudioReactive.startFromElement(el);
      els.audioBtn.setAttribute('aria-pressed', String(audioEnabled));
      // Playing our own file answers the capture question for good.
      closeCaptureNudge();
      // Same reason as enableAudio(): this replaced the audio graph.
      if (window.MilkDrop) window.MilkDrop.reconnect();
    }
  });

  window.LocalPlayer.on('tick', (state) => {
    playbackStatus = state.status;
    anchorPositionMs = state.positionMs;
    anchorAt = performance.now();
    if (state.durationMs) durationMs = state.durationMs;
    document.body.classList.toggle('is-playing', state.status === 'Playing');
    updateTransport();
  });

  /* The whole song measured before the first chorus: the timeline is full, the
     tempo is known and a drop can be anticipated — on play one. */
  window.LocalPlayer.on('analysed', (track, summary) => {
    const bpm = summary.bpm ? ` · ${summary.bpm.toFixed(0)} BPM` : '';
    setStatus(`analysed ${track.title} in ${Math.round(summary.ms)}ms${bpm}`);
    if (summary.bpm && window.Tempo) {
      tempoLocked = true;
      tempoBpm = summary.bpm;
      beatPeriodMs = 60000 / summary.bpm;
      /*
        Hand it to the estimator as a prior, not just to the clock.

        Setting the clock alone was the bug: the live estimator carried on
        re-deriving a tempo from a rolling 12-second window and overwrote this
        within seconds. The prior makes the measurement stick, and makes the
        live path track the phase of a known tempo rather than argue about what
        the tempo is.
      */
      window.Tempo.setPrior(summary.bpm);
    }
    updateBpmChip();
  });

  if (els.trPlay) els.trPlay.addEventListener('click', () => { window.LocalPlayer.togglePlay(); updateTransport(); });
  if (els.trNext) els.trNext.addEventListener('click', () => window.LocalPlayer.next());
  if (els.trPrev) els.trPrev.addEventListener('click', () => window.LocalPlayer.previous());
  if (els.trStop) els.trStop.addEventListener('click', () => { window.LocalPlayer.stop(); updateTransport(); });
}

els.presyncBtn.addEventListener('click', () => {
  const willShow = els.presync.hasAttribute('hidden');
  if (willShow) {
    els.presync.removeAttribute('hidden');
    document.body.classList.add('keybox-open'); // pin the HUD open while typing
    els.presyncInput.focus();
    refreshSyncedList(); // show the current library each time the panel opens
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
    refreshSyncedList(); // reflect the newly-cached songs
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
// Save everything learned about the current song on close.
window.addEventListener('beforeunload', () => {
  flushBeatmap();
  flushHeatmap();
});

/* Bootstrap. */
try {
  const bl = parseInt(localStorage.getItem('backdropLevel'), 10);
  if (!Number.isNaN(bl) && bl >= 0 && bl < BACKDROP_LEVELS.length) backdropLevel = bl;
  const se = localStorage.getItem('spritesEnabled');
  if (se !== null) spritesEnabled = se === '1';
  const lv = localStorage.getItem('lyricsVisible');
  if (lv !== null) lyricsVisible = lv === '1';
  liteMode = localStorage.getItem('liteMode') === '1';
  // No global preset any more — each song carries its own look (see
  // applyLookForTrack). Only explicit per-song overrides are stored.
} catch { /* ignore */ }
applyBackdropLabel();
applyPresetLabel();
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
  // Once the version is known, show the first-run welcome OR the what's-new
  // card — over a running backdrop rather than a blank window mid-boot.
  appVersion = prefs.appVersion || null;
  showWelcomeOrWhatsNew(appVersion);
});
window.player.getOffset().then((data) => {
  applyOffsetLabel((data && data.offsetMs) || 0);
});
setStatus('waiting for playback…');
applyMoodProfile(); // sets body[data-mood="neutral"] so CSS always has a value
