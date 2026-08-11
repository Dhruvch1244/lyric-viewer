'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { identify } = require('./tags');
const { AppTray } = require('./tray');
const { AppUpdater, describeUpdate, isUpdateActionable } = require('./updater');

// GPU / performance: the overlay is a full-screen, always-animating Canvas 2D
// surface, so hardware acceleration matters. These switches force the GPU path
// on even when Chromium's blocklist would fall back to software, and enable
// zero-copy + accelerated raster for smoother compositing. Must be set before
// app 'ready'. (We never call app.disableHardwareAcceleration().)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('canvas-oop-rasterization');

const { SmtcWatcher } = require('./smtc');
const { fetchSyncedLyrics, fetchPlainLyrics, detectIndic, cleanArtist, normaliseCues } = require('./lyrics');
const { fetchNeteaseSynced } = require('./netease');
const { alignLyrics, splitPlainLyrics } = require('./align');
const { attachWordTimings } = require('./wordalign');
const { correctTranscript, isCorrectionAvailable } = require('./correct');
const { toDevanagari, isTransliterationAvailable } = require('./transliterate');
const { toEnglish, isTranslationAvailable } = require('./translate');
const { toEnglishOffline, canTranslateOffline, canTranslate: canTranslateLocally } = require('./localtranslate');
const { analyzeSentiment, isSentimentAvailable } = require('./sentiment');
const { Settings } = require('./settings');
const { LlmCache } = require('./cache');
const { fetchArtwork, fetchArtworkCandidates, downloadImage } = require('./artwork');
const { activeProvider } = require('./llm');
const { transcribePcm, DEFAULT_MODEL, MODELS } = require('./transcribe');
const { setKey } = require('./keys');

/** @type {BrowserWindow|null} */
let win = null;

/** Persisted user settings (offsets, script preference). */
const settings = new Settings();

/**
 * Disk-backed cache of LLM-derived data (translation / transliteration / mood).
 * Survives restarts so each song is sent to the provider at most once, ever —
 * this is what keeps a limited free-tier quota from being burned on replays.
 */
const llmCache = new LlmCache();

/** In-memory lyric cache keyed by "artist|title". */
const lyricCache = new Map();

/**
 * Persist the LLM-derived fields of an in-memory entry to the disk cache.
 * @param {string} key trackKey
 * @param {object} entry the lyricCache value
 */
function persistLlm(key, entry) {
  if (!entry) return;
  llmCache.merge(key, {
    cuesEnglish: entry.cuesEnglish,
    language: entry.language,
    cuesDevanagari: entry.cuesDevanagari,
    mood: entry.mood,
  });
}

/** Guards against overlapping lookups when tracks change quickly. */
let lookupToken = 0;

/** Guards against overlapping artwork lookups when tracks change quickly. */
let artworkToken = 0;

/** Guards a bulk pre-sync run so a newer request supersedes an in-flight one. */
let presyncToken = 0;

/** The track currently playing, used to key per-track sync offsets. */
let currentTrack = null;

/* True while the renderer is playing a local file. Suppresses SMTC so a paused
   Spotify in the background cannot take the app's current track away. */
let localPlaybackActive = false;

/** @type {import('./tray').AppTray|null} */
let appTray = null;

/** @type {import('./updater').AppUpdater|null} */
let appUpdater = null;

/** Current display size: fullscreen overlay, floating bar, or taskbar strip. */
let displayMode = 'full';

/**
 * Identify a local audio file without reading all of it.
 *
 * Only the opening bytes are read: an ID3v2 tag lives at the very start, and a
 * library scan of a few hundred files should not pull hundreds of megabytes
 * through memory to find two strings.
 *
 * @param {string} filePath
 * @returns {{localPath: string, title: string, artist: string}}
 */
function describeLocalFile(filePath) {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      head = head.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable: identify() falls back to the filename, which is enough.
  }
  const { title, artist } = identify(filePath, head);
  return { localPath: filePath, title, artist };
}

/**
 * True while a Whisper pass is running. Transcription is CPU-bound and holds
 * a large model in memory, so passes are serialised rather than queued —
 * two at once would just fight for the same cores.
 */
let transcribeBusy = false;

/**
 * HSL → #rrggbb. `s` and `l` are percentages (0–100), `h` is degrees.
 * @param {number} h @param {number} s @param {number} l
 * @returns {string}
 */
function hslHex(h, s, l) {
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
 * Deterministic, vibrant palette per track so each song visibly recolours the
 * whole background. Returns a dark tint for the base wash plus bright glow and
 * accent colours. A full audio-reactive palette arrives with the WASAPI layer;
 * this reacts to the track identity we already have.
 *
 * @param {{artist: string, title: string}} track
 * @returns {{palette: string[], hue: number}}  palette = [baseTint, glowA, glowB, accent]
 */
function paletteForTrack(track) {
  const seed = `${track.artist || ''}|${track.title || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const hue2 = (hue + 45 + (hash % 60)) % 360; // second, related hue

  const palette = [
    hslHex(hue, 55, 9),    // baseTint — dark, colours the whole screen
    hslHex(hue, 80, 52),   // glowA — vibrant
    hslHex(hue2, 78, 55),  // glowB — vibrant, secondary hue
    hslHex(hue, 88, 62),   // accent — bright, for word focus
  ];
  return { palette, hue, energy: 0.5, mood: null };
}

/**
 * Build a palette + motion profile from an analyzed sentiment.
 * @param {{hue: number, saturation: number, energy: number, mood: string}} s
 * @returns {{palette: string[], hue: number, energy: number, mood: string}}
 */
function paletteFromSentiment(s) {
  const hue = s.hue;
  const hue2 = (hue + 40) % 360;
  const sat = s.saturation;
  const palette = [
    hslHex(hue, Math.round(sat * 0.7), 9),
    hslHex(hue, sat, 52),
    hslHex(hue2, sat, 55),
    hslHex(hue, Math.min(100, sat + 8), 62),
  ];
  return { palette, hue, energy: s.energy, mood: s.mood };
}

/**
 * Stable cache/settings key for a track.
 * @param {{artist: string, title: string}} track
 * @returns {string}
 */
/**
 * Whether a cue list already carries measured word timings.
 *
 * Drives whether the renderer keeps recording audio for a song: alignment is a
 * one-off cost per song, so once the words are timed there is nothing left to
 * listen for.
 *
 * @param {Array<{words?: Array}>} cues
 * @returns {boolean}
 */
function hasWords(cues) {
  return Array.isArray(cues) && cues.some((c) => c && Array.isArray(c.words) && c.words.length > 0);
}

function trackKey(track) {
  return `${(track.artist || '').trim()}|${(track.title || '').trim()}`.toLowerCase();
}

/**
 * Effective sync offset for the current track.
 * @returns {number} ms
 */
function activeOffsetMs() {
  if (!currentTrack) return settings.get('globalOffsetMs', 0);
  const perTrack = settings.get('trackOffsets', {})[trackKey(currentTrack)];
  return typeof perTrack === 'number' ? perTrack : settings.get('globalOffsetMs', 0);
}

/**
 * Persist a sync offset for the current track.
 * @param {number} valueMs
 */
function setOffsetMs(valueMs) {
  if (currentTrack) {
    const offsets = { ...settings.get('trackOffsets', {}) };
    offsets[trackKey(currentTrack)] = valueMs;
    settings.set('trackOffsets', offsets);
  } else {
    settings.set('globalOffsetMs', valueMs);
  }
  send('offset', { offsetMs: valueMs, perTrack: Boolean(currentTrack) });
}

/**
 * Create the transparent, borderless, full-screen-bounds player window.
 *
 * We size to the display bounds and go borderless rather than using
 * `fullscreen: true`, because transparent + true-fullscreen is unreliable on
 * Windows (transparency is lost). This gives a fullscreen-sized transparent
 * surface that floats over the desktop.
 *
 * @returns {BrowserWindow}
 */
function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();

  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Critical: keep the render loop at full speed even when the window is
      // not focused/occluded (e.g. while Spotify is in front). Without this,
      // Chromium throttles requestAnimationFrame and the background goes static.
      backgroundThrottling: false,
    },
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once('ready-to-show', () => window.show());

  // Hung off the window's own events rather than the toggle, so every path that
  // hides the overlay — hotkey, tray, or anything added later — parks the render
  // loop. See sendVisibility for why this is not free.
  window.on('show', () => sendVisibility(true));
  window.on('hide', () => sendVisibility(false));

  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

/**
 * Send a payload to the renderer if it is alive.
 * @param {string} channel
 * @param {unknown} payload
 */
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * The updater state as the overlay needs it: the raw phase plus the one
 * decision the renderer must not make for itself.
 *
 * `prompt` is computed here because dismissal lives on the updater — a renderer
 * that decided for itself would forget every reload, and reloading is exactly
 * what happens when the display mode changes.
 *
 * @returns {{phase: string, version?: string, percent?: number, prompt: boolean}}
 */
function updateStateForRenderer() {
  if (!appUpdater) return { phase: 'idle', prompt: false };
  const { phase, version, percent } = appUpdater.state;
  return { phase, version, percent, prompt: appUpdater.shouldPrompt() };
}

/**
 * Fetch cover art + full artist credit for a track and push it to the renderer.
 * Best-effort: on any failure the visuals simply keep their hash palette and the
 * SMTC-reported artist. Guarded by `artworkToken` so a rapid track change wins.
 * @param {{title: string, artist: string, durationMs: number}} track
 */
async function loadArtworkFor(track) {
  const token = ++artworkToken;
  try {
    /*
      A cover the user picked by hand outranks anything the search would find,
      and it must not cost a network round trip on every replay — the whole
      point of choosing was that the automatic answer was wrong. Stored as the
      URL rather than the image: data URIs of 1000px covers would bloat the
      cache file, which is the same reason pre-sync does not persist artwork.
    */
    const key = trackKey(track);
    const chosen = llmCache.get(key);
    if (chosen && chosen.artworkUrl) {
      const artwork = await downloadImage(chosen.artworkUrl);
      if (token !== artworkToken) return;
      if (artwork) {
        send('artwork', {
          track,
          artwork,
          artistName: chosen.artworkArtist || null,
          trackName: chosen.artworkTitle || null,
          chosen: true,
        });
        return;
      }
      // The URL died (a store pulled the release). Fall through to a fresh
      // search rather than leaving the song with no cover at all.
    }

    const art = await fetchArtwork(track);
    if (token !== artworkToken || !art) return;
    send('artwork', { track, ...art });
  } catch (err) {
    console.error('[artwork]', err.message);
  }
}

/**
 * Parse one pasted playlist line into a track. Accepts "Artist - Title" (with
 * hyphen or en/em dash); a line without a separator is treated as a bare title.
 * @param {string} line
 * @returns {{title:string, artist:string, durationMs:number}|null}
 */
function parseTrackLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), durationMs: 0 };
  }
  return { artist: '', title: s, durationMs: 0 };
}

/**
 * Fetch + cache synced lyrics for a single track without touching the renderer.
 * Skips tracks whose cues are already on disk. Used by the bulk pre-sync run.
 * @param {{title:string, artist:string, durationMs:number}} track
 * @returns {Promise<'ok'|'cached'|'not-found'|'error'>}
 */
async function presyncOne(track) {
  const key = trackKey(track);
  const existing = llmCache.get(key);
  if (existing && Array.isArray(existing.cues) && existing.cues.length > 0) return 'cached';

  let result;
  try {
    result = await fetchSyncedLyrics(track);
  } catch {
    return 'error';
  }
  if (!result || !Array.isArray(result.cues) || result.cues.length === 0) return 'not-found';

  const indic = detectIndic(result.cues).indic || Boolean(result.cuesDevanagari);
  llmCache.merge(key, {
    title: track.title || null,
    artist: track.artist || null,
    cues: result.cues,
    cuesDevanagari: result.cuesDevanagari || null,
    source: result.source,
    indic,
  });
  return 'ok';
}

/**
 * Resolve lyrics for a track and kick off translation when it looks Indic.
 * @param {{title: string, artist: string, durationMs: number}} track
 */
async function loadLyricsFor(track) {
  const key = trackKey(track);
  const token = ++lookupToken;

  if (lyricCache.has(key)) {
    const cached = lyricCache.get(key);
    // `origin` tells the renderer where the lyrics came from so it can badge a
    // preloaded/offline hit: 'memory' (this session), 'disk' (preloaded from a
    // previous session or pre-sync), or 'network' (fetched now).
    send('lyrics', { track, ...cached, origin: 'memory' });
    maybeAutoTranslate(key, track, token);
    maybeAnalyzeSentiment(key, track, token);
    return;
  }

  // Disk cache: a song heard in a previous session replays instantly + offline,
  // with any prior translation/transliteration/mood already attached.
  const disk = llmCache.get(key);
  if (disk && Array.isArray(disk.cues) && disk.cues.length > 0) {
    /*
      Repair on read. Versions up to 0.10.0 stored the LRC gap markers (stamped
      lines with no text) as ordinary cues, and every song has some — see
      normaliseCues. Folding them into `endMs` here fixes an existing library
      in place, so nobody has to re-fetch or lose cached LLM work.

      A cached English translation was produced against the un-normalised list,
      so it is filtered through the same `kept` mask to stay index-aligned; if
      it does not line up it is dropped and re-derived rather than shown against
      the wrong lines.
    */
    const normalised = normaliseCues(disk.cues);
    let cuesEnglish = Array.isArray(disk.cuesEnglish) ? disk.cuesEnglish : null;
    if (cuesEnglish && cuesEnglish.length !== normalised.cues.length) {
      cuesEnglish = cuesEnglish.length === disk.cues.length
        ? normalised.kept.map((i) => cuesEnglish[i])
        : null;
    }

    const payload = {
      cues: normalised.cues,
      cuesDevanagari: disk.cuesDevanagari ? normaliseCues(disk.cuesDevanagari).cues : null,
      cuesEnglish,
      language: disk.language,
      mood: disk.mood || null,
      source: disk.source || null,
      status: 'ok',
      hasWordTimings: hasWords(normalised.cues) || Boolean(disk.wordAlignFailed),
      indic: Boolean(disk.indic),
      transliterationAvailable: isTransliterationAvailable(),
      translationAvailable: isTranslationAvailable() || canTranslateLocally(normalised.cues),
    };
    lyricCache.set(key, payload);
    send('lyrics', { track, ...payload, origin: 'disk' });
    maybeAutoTranslate(key, track, token);
    maybeAnalyzeSentiment(key, track, token);
    return;
  }

  send('lyrics', { track, cues: [], status: 'searching' });

  let result;
  try {
    result = await fetchSyncedLyrics(track);
  } catch (err) {
    if (token !== lookupToken) return;
    send('lyrics', { track, cues: [], status: 'error', message: err.message });
    return;
  }
  if (token !== lookupToken) return;

  /*
    Second synced source. Runs only when LRCLIB missed, because LRCLIB is the
    better-matched source for this library and there is no reason to pay for a
    second lookup when the first one succeeded.

    A second SYNCED source is worth more than a second plain one: a plain source
    still has to be aligned by Whisper (minutes of CPU, and only on the next
    play), whereas this scrolls immediately and offline. NetEase is strongest
    exactly where LRCLIB is weakest — Mandarin, Cantonese, K-pop and the Asian
    long tail — and often carries a human-written translation with it.

    Best-effort throughout: any failure returns null and the code below treats
    it exactly as "not found", which is what it was already doing.
  */
  if (!result) {
    try {
      result = await fetchNeteaseSynced(track);
    } catch (err) {
      console.warn('[netease]', err.message);
    }
    if (token !== lookupToken) return;
  }

  if (!result) {
    const payload = {
      cues: [], cuesDevanagari: null, cuesEnglish: null,
      source: null, status: 'not-found', indic: false,
    };
    lyricCache.set(key, payload);
    send('lyrics', { track, ...payload, origin: 'network' });
    return;
  }

  const indic = detectIndic(result.cues).indic || Boolean(result.cuesDevanagari);

  // Rehydrate any LLM work done for this track in a previous session, so we
  // never re-send it to the provider. The `maybe*` helpers below see these
  // fields already populated and short-circuit without a network call.
  const saved = llmCache.get(key) || {};

  const payload = {
    cues: result.cues,
    cuesDevanagari: saved.cuesDevanagari || result.cuesDevanagari,
    /*
      A source-supplied translation outranks anything cached from the LLM: a
      human wrote it for this specific song, which no general translator will
      match. NetEase supplies one for a lot of its catalogue.
    */
    cuesEnglish: result.cuesEnglish || saved.cuesEnglish || null,
    language: saved.language,
    mood: saved.mood || null,
    source: result.source,
    status: 'ok',
    indic,
    transliterationAvailable: isTransliterationAvailable(),
    translationAvailable: isTranslationAvailable() || canTranslateLocally(result.cues),
  };

  lyricCache.set(key, payload);
  send('lyrics', { track, ...payload, origin: 'network' });

  // Persist the raw synced cues (+ display title/artist) so the next play of this
  // song is instant/offline and it shows in the synced-songs library.
  llmCache.merge(key, {
    title: track.title || null,
    artist: track.artist || null,
    cues: result.cues,
    cuesDevanagari: payload.cuesDevanagari,
    // Persisted so a source-supplied translation survives a restart, and so
    // maybeAutoTranslate below short-circuits instead of paying an LLM to
    // redo work a human already did.
    cuesEnglish: payload.cuesEnglish,
    language: payload.language,
    source: result.source,
    indic,
  });

  maybeAutoTranslate(key, track, token);
  maybeAnalyzeSentiment(key, track, token);
}

/**
 * Analyze song sentiment and push a mood-driven palette to the renderer.
 * The renderer already has an instant hash palette from the `track` event; this
 * upgrades it to reflect the song's actual mood once analysis completes.
 *
 * @param {string} key
 * @param {{title: string}} track
 * @param {number} token
 */
async function maybeAnalyzeSentiment(key, track, token) {
  const entry = lyricCache.get(key);
  if (!entry || entry.cues.length === 0) return;

  if (entry.mood) {
    send('mood', { track, ...entry.mood });
    return;
  }
  if (!isSentimentAvailable()) return;

  try {
    const sentiment = await analyzeSentiment(entry.cues);
    if (token !== lookupToken) return;
    const mood = paletteFromSentiment(sentiment);
    const updated = { ...entry, mood };
    lyricCache.set(key, updated);
    persistLlm(key, updated);
    send('mood', { track, ...mood });
  } catch (err) {
    // Sentiment is a visual nicety; the hash palette remains in place on failure.
    console.error('[sentiment]', err.message);
  }
}

/**
 * Auto-translate to English when the track is Indic and credentials exist.
 * The English cues are pushed to the renderer as a separate `translation` event
 * so lyrics render immediately and the translation appears when ready.
 *
 * @param {string} key
 * @param {{title: string}} track
 * @param {number} token
 */
async function maybeAutoTranslate(key, track, token) {
  const entry = lyricCache.get(key);
  if (!entry || entry.cues.length === 0) return;
  if (entry.cuesEnglish) {
    send('translation', { track, status: 'ok', cues: entry.cuesEnglish, language: entry.language });
    return;
  }
  // Already analysed and judged already-English in a prior session — don't spend
  // another request re-confirming it.
  if (entry.language === 'english') {
    send('translation', { track, status: 'skipped', language: 'english' });
    return;
  }
  /*
    Local first, when it is genuinely good. The offline Marian model needs no
    key and no network, but it only reads Devanagari — canTranslate() gates on
    that, because on romanized or English text it returns confident nonsense
    rather than failing (see localtranslate.js). Everything it declines falls
    through to the LLM providers exactly as before.
  */
  const useLocal = canTranslateOffline(entry.cues, entry.indic);
  if (!entry.indic || (!useLocal && !isTranslationAvailable())) return;

  send('translation', { track, status: 'translating' });
  try {
    const { cues, language } = useLocal
      ? await toEnglishOffline(entry.cues)
      : await toEnglish(entry.cues);
    if (token !== lookupToken) return;
    // Skip showing a translation the model judged already-English.
    if (language === 'english') {
      const skipped = { ...entry, cuesEnglish: null, language };
      lyricCache.set(key, skipped);
      persistLlm(key, skipped);
      send('translation', { track, status: 'skipped', language });
      return;
    }
    const updated = { ...entry, cuesEnglish: cues, language };
    lyricCache.set(key, updated);
    persistLlm(key, updated);
    send('translation', { track, status: 'ok', cues, language });
  } catch (err) {
    if (token !== lookupToken) return;
    send('translation', { track, status: 'error', message: err.message });
  }
}

/**
 * Transliterate cached cues to Devanagari on demand.
 * @param {string} key
 * @returns {Promise<{status: string, cues?: Array, message?: string}>}
 */
async function ensureDevanagari(key) {
  const entry = lyricCache.get(key);
  if (!entry || entry.cues.length === 0) {
    return { status: 'unavailable', message: 'No lyrics loaded for this track.' };
  }
  if (entry.cuesDevanagari) return { status: 'ok', cues: entry.cuesDevanagari };
  if (!isTransliterationAvailable()) {
    return { status: 'unavailable', message: 'Set ANTHROPIC_API_KEY for Devanagari.' };
  }
  try {
    const cues = await toDevanagari(entry.cues);
    const updated = { ...entry, cuesDevanagari: cues };
    lyricCache.set(key, updated);
    persistLlm(key, updated);
    return { status: 'ok', cues };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/* ------------------------------------------------------------ display modes */
/*
  Three sizes of the same app.

  This is the single biggest adoption problem the app has — it takes over the
  screen or it does nothing, and every competitor offers a small always-on mode,
  so people try it once and stop. It is also, unexpectedly, the largest
  performance change available: profiling puts `(program)` at ~850 ms/s against
  ~45 ms/s for all app JavaScript combined, and that is native compositing of a
  full-screen transparent always-on-top window. The only lever big enough to
  matter is compositing fewer pixels, and a taskbar strip composites a few
  percent of what fullscreen does.

  So the modes are a feature and a fix at the same time. The visualiser stays in
  `full`; the compact modes are a lyric line, and the renderer drops both WebGL
  contexts and the 2D canvas when it is in one.
*/

/** @type {ReadonlyArray<'full'|'bar'|'strip'>} */
const DISPLAY_MODES = ['full', 'bar', 'strip'];

/** Height of the taskbar strip, in CSS pixels. */
const STRIP_HEIGHT = 54;

/**
 * Window geometry for a display mode.
 *
 * Uses `workArea`, not `bounds`, for the compact modes: `bounds` includes the
 * space behind the taskbar, so a strip positioned against the bottom of it
 * would sit underneath the taskbar and be invisible. Fullscreen deliberately
 * still uses `bounds`, because covering the taskbar is the point there.
 *
 * @param {'full'|'bar'|'strip'} mode
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function boundsForMode(mode) {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;

  if (mode === 'strip') {
    return {
      x: workArea.x,
      y: workArea.y + workArea.height - STRIP_HEIGHT,
      width: workArea.width,
      height: STRIP_HEIGHT,
    };
  }
  if (mode === 'bar') {
    const width = Math.min(880, Math.round(workArea.width * 0.62));
    const height = 132;
    return {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + workArea.height - height - Math.round(workArea.height * 0.06),
      width,
      height,
    };
  }
  return display.bounds;
}

/**
 * Resize the overlay into a display mode and tell the renderer to match.
 * @param {'full'|'bar'|'strip'} mode
 */
function applyDisplayMode(mode) {
  const next = DISPLAY_MODES.includes(mode) ? mode : 'full';
  displayMode = next;
  settings.set('displayMode', next);
  if (!win || win.isDestroyed()) return;

  win.setBounds(boundsForMode(next));

  /*
    The strip is click-through, the others are not.

    A thin bar pinned along the bottom edge sits exactly where taskbar buttons
    and window edges are, so an opaque one would eat clicks meant for other
    apps all day — which is the difference between something you leave on and
    something you close. `forward: true` keeps hover working so the app can
    still react to the pointer without consuming the click.
  */
  win.setIgnoreMouseEvents(next === 'strip', { forward: true });

  send('display-mode', { mode: next });
}

/**
 * Tell the renderer whether it is on screen.
 *
 * This matters more than it looks. `backgroundThrottling` is deliberately off
 * (see createWindow) so the visuals keep running while another app has focus —
 * which also means Chromium will NOT throttle us when the window is hidden.
 * Without this signal, Ctrl+Alt+H leaves the swirl, the galaxy, the sprites and
 * the beat clock drawing at full rate into a window nobody can see, for as long
 * as the overlay stays hidden.
 *
 * @param {boolean} visible Whether the overlay window is now on screen.
 */
function sendVisibility(visible) {
  if (win && !win.isDestroyed()) win.webContents.send('overlay-visibility', { visible });
}

/** Show or hide the overlay. Shared by the hotkey and the tray. */
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

/** Register global hotkeys. */

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+Left', () => setOffsetMs(activeOffsetMs() - 100));
  globalShortcut.register('CommandOrControl+Alt+Right', () => setOffsetMs(activeOffsetMs() + 100));
  globalShortcut.register('CommandOrControl+Alt+0', () => setOffsetMs(0));
  globalShortcut.register('CommandOrControl+Alt+H', toggleWindow);
  // Cycle fullscreen → floating bar → taskbar strip. A hotkey as well as a chip
  // because the strip is click-through and the bar has no room for the HUD, so
  // in two of the three modes the chip is not reachable.
  globalShortcut.register('CommandOrControl+Alt+M', () => {
    const i = DISPLAY_MODES.indexOf(displayMode);
    applyDisplayMode(DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length]);
  });
}

app.whenReady().then(() => {
  // Route the renderer's getDisplayMedia() request to the primary screen with
  // system-audio loopback, so the audio-reactive engine can analyse whatever is
  // actually playing. Auto-approved (no picker) because the handler is set.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });

  win = createWindow();
  registerShortcuts();

  /* The overlay has no window chrome and hides on a hotkey, so once it is
     running nothing on screen says it exists. The tray fixes that and gives
     background work somewhere to report that is not inside a hidden HUD. */
  /* Auto-update. Constructed before the tray so the tray's update row can read
     its state on the very first render; started after, so the first status
     change has somewhere to redraw into. */
  appUpdater = new AppUpdater({
    onChange: () => {
      if (appTray) appTray.refresh();
      /* The tray menu was the only place this surfaced, which meant an update
         could arrive, sit downloaded and ready, and never be mentioned to
         someone watching a full-screen overlay. Push it to the renderer too. */
      send('update-state', updateStateForRenderer());
    },
  });

  appTray = new AppTray({
    onToggleWindow: toggleWindow,
    onQuit: () => app.quit(),
    /* One row that changes meaning with the state: it checks when idle, shows
       progress while working, and restarts when something is waiting. */
    updateItem: () => ({
      label: describeUpdate(appUpdater.state),
      enabled: isUpdateActionable(appUpdater.state),
    }),
    onUpdateClick: () => {
      if (!appUpdater.installNow()) appUpdater.checkNow();
    },
  });
  appTray.start();
  appUpdater.start(app.isPackaged);

  /* Restore the last display mode once the window exists. Applied here rather
     than in createWindow so the renderer is listening for the event. */
  win.webContents.once('did-finish-load', () => {
    applyDisplayMode(settings.get('displayMode') || 'full');
  });

  /* The overlay asks on load, because the updater may have settled before the
     renderer was listening — a cold start that finds an update ready reaches
     'ready' well before the first frame. */
  ipcMain.handle('get-update-state', () => updateStateForRenderer());

  ipcMain.handle('update-action', (_e, action) => {
    if (!appUpdater) return { status: 'unavailable' };
    if (action === 'install') {
      return { status: appUpdater.installNow() ? 'installing' : 'nothing-ready' };
    }
    if (action === 'dismiss') {
      appUpdater.dismiss();
      return { status: 'dismissed' };
    }
    appUpdater.checkNow();
    return { status: 'checking' };
  });

  ipcMain.handle('set-display-mode', (_e, mode) => {
    applyDisplayMode(mode);
    return { status: 'ok', mode: displayMode };
  });
  ipcMain.handle('get-display-mode', () => ({ mode: displayMode, modes: DISPLAY_MODES }));

  /* Background work, forwarded from the renderer's job map. Only the jobs in
     tray.js's NOTIFY_ON_DONE raise an OS notification when they finish. */
  ipcMain.handle('report-jobs', (_e, payload) => {
    if (!appTray) return { status: 'ignored' };
    appTray.setJobs((payload && payload.jobs) || []);
    if (payload && payload.finished) {
      appTray.jobFinished(payload.finished.id, payload.finished.label);
    }
    return { status: 'ok' };
  });

  const watcher = new SmtcWatcher({ intervalMs: 250 });

  /*
    While a local file is playing we own the "current track" and SMTC must not
    speak. Without this, Spotify or a browser tab left paused in the background
    keeps announcing its own song and the two fight over every downstream
    consumer — lyrics, artwork, the cache key, the dancers.
  */
  watcher.on('track', (rawTrack) => {
    if (localPlaybackActive) return;
    // Clean the artist credit once, here at the SMTC boundary, so every
    // consumer downstream sees the same tidy value: lyric matching, artwork
    // search, the dancer registry, the cache key and the on-screen label.
    // YouTube Music reports "Seedhe Maut - Topic" and VEVO uploads append
    // "VEVO"; both wreck matching and look wrong on screen.
    const track = { ...rawTrack, artist: cleanArtist(rawTrack.artist) };
    currentTrack = track;
    if (appTray) appTray.setTrack(track);
    send('track', { ...track, ...paletteForTrack(track) });
    send('offset', { offsetMs: activeOffsetMs(), perTrack: true });
    // Hand the renderer everything already learned about this song (null on a
    // first listen): the beat map it fires drums from when capture is off, and
    // the heat map it draws the song's shape from — and reads FORWARDS, so a
    // drop can be anticipated instead of merely reacted to.
    const saved = llmCache.get(trackKey(track));
    send('beatmap', { track, beatmap: (saved && saved.beatmap) || null });
    send('heatmap', { track, heatmap: (saved && saved.heatmap) || null });
    loadLyricsFor(track);
    loadArtworkFor(track);
  });

  watcher.on('tick', (state) => {
    if (localPlaybackActive) return;   // the renderer owns position for local files
    send('tick', { ...state, positionMs: (state.positionMs ?? 0) - activeOffsetMs() });
  });

  watcher.on('idle', () => {
    if (localPlaybackActive) return;
    currentTrack = null;
    send('idle', null);
  });

  watcher.on('error', (err) => console.error('[smtc]', err.message));
  watcher.start();

  ipcMain.handle('get-offset', () => ({ offsetMs: activeOffsetMs(), perTrack: Boolean(currentTrack) }));
  ipcMain.handle('set-offset', (_e, valueMs) => {
    setOffsetMs(Number(valueMs) || 0);
    return activeOffsetMs();
  });

  ipcMain.handle('get-prefs', () => ({
    script: settings.get('script', 'latin'),
    showTranslation: settings.get('showTranslation', true),
  }));

  ipcMain.handle('set-script', async (_e, script) => {
    settings.set('script', script === 'devanagari' ? 'devanagari' : 'latin');
    if (script === 'devanagari' && currentTrack) return ensureDevanagari(trackKey(currentTrack));
    return { status: 'ok' };
  });

  ipcMain.handle('set-show-translation', (_e, show) => {
    settings.set('showTranslation', Boolean(show));
    return Boolean(show);
  });

  // Manual trigger for English translation (e.g. on a track the heuristic missed).
  ipcMain.handle('request-translation', async () => {
    if (!currentTrack) return { status: 'unavailable', message: 'Nothing playing.' };
    const key = trackKey(currentTrack);
    const entry = lyricCache.get(key);
    if (!entry || entry.cues.length === 0) return { status: 'unavailable', message: 'No lyrics loaded.' };
    if (entry.cuesEnglish) return { status: 'ok', cues: entry.cuesEnglish, language: entry.language };

    // Devanagari lyrics can be translated on-device with no key at all.
    const useLocal = canTranslateOffline(entry.cues, entry.indic);
    if (!useLocal && !isTranslationAvailable()) {
      return { status: 'unavailable', message: 'Set GEMINI_API_KEY or ANTHROPIC_API_KEY for translation.' };
    }
    try {
      const { cues, language } = useLocal
        ? await toEnglishOffline(entry.cues)
        : await toEnglish(entry.cues);
      const updated = { ...entry, cuesEnglish: cues, language };
      lyricCache.set(key, updated);
      persistLlm(key, updated);
      return { status: 'ok', cues, language };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  });

  // Report which LLM provider is currently active, so the 🔑 panel can show
  // whether a key is wired up.
  /* Bulk pre-sync: fetch + cache synced lyrics for a pasted "Artist - Title"
     list, so those songs play instantly and offline later. Runs sequentially in
     the background and streams progress to the renderer. */
  ipcMain.handle('presync-list', async (_e, text) => {
    const tracks = String(text || '')
      .split(/\r?\n/)
      .map(parseTrackLine)
      .filter(Boolean);
    const token = ++presyncToken;
    const total = tracks.length;

    if (total === 0) {
      send('presync-progress', { done: 0, total: 0, status: 'done', summary: 'nothing to sync' });
      return { status: 'empty' };
    }

    let done = 0;
    let synced = 0;
    let cached = 0;
    let missed = 0;
    for (const track of tracks) {
      if (token !== presyncToken) return { status: 'cancelled' }; // superseded
      const label = `${track.artist ? `${track.artist} - ` : ''}${track.title}`;
      send('presync-progress', { done, total, status: 'running', current: label });
      const outcome = await presyncOne(track);
      if (outcome === 'ok') synced += 1;
      else if (outcome === 'cached') cached += 1;
      else missed += 1;
      done += 1;
      await new Promise((resolve) => setTimeout(resolve, 150)); // be polite to LRCLIB
    }

    const summary = `${synced} synced · ${cached} already cached · ${missed} not found`;
    send('presync-progress', { done, total, status: 'done', summary });
    return { status: 'ok', synced, cached, missed };
  });

  /* Persist a beat map the renderer learned from live audio, keyed by track. */
  ipcMain.handle('save-beatmap', (_e, payload) => {
    const track = payload && payload.track;
    const beatmap = payload && payload.beatmap;
    if (!track || !beatmap) return { status: 'ignored' };
    llmCache.merge(trackKey(track), { beatmap, title: track.title || null, artist: track.artist || null });
    return { status: 'ok' };
  });

  /*
    Persist the heat map the renderer learned from live audio, keyed by track.

    Separate from the beat map because they answer different questions and are
    learned at different rates: the beat map is a list of onsets, the heat map is
    the energy arc binned against position. Storing the arc is what makes it a
    property of the SONG rather than of one playthrough — without this the whole
    premise ("play it again and the shape is already known") does not hold.
  */
  ipcMain.handle('save-heatmap', (_e, payload) => {
    const track = payload && payload.track;
    const heatmap = payload && payload.heatmap;
    if (!track || !heatmap || !Array.isArray(heatmap.bins)) return { status: 'ignored' };
    llmCache.merge(trackKey(track), { heatmap, title: track.title || null, artist: track.artist || null });
    return { status: 'ok' };
  });

  /* ------------------------------------------------------- local playback */

  /*
    Opening local files turns the overlay into a player, and the payoff is
    bigger than convenience: with the decoded samples in hand the renderer can
    measure the WHOLE song before it plays (see src/renderer/analyze.js), so the
    heat map, the tempo and anticipation all work on the first play with no
    loopback capture at all. The `♫` gap simply does not exist for local files.
  */
  const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac', 'wma'];

  ipcMain.handle('open-local-files', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add songs',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (res.canceled) return [];
    return res.filePaths.map(describeLocalFile);
  });

  ipcMain.handle('open-local-folder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder of songs',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return [];
    const dir = res.filePaths[0];
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      console.error('[local] cannot read folder:', err.message);
      return [];
    }
    return names
      .filter((n) => AUDIO_EXTENSIONS.includes(path.extname(n).slice(1).toLowerCase()))
      .map((n) => describeLocalFile(path.join(dir, n)));
  });

  /*
    Hand the renderer the raw bytes. It uses them twice from this single read:
    once as a Blob URL for the <audio> element, and once through
    decodeAudioData for the offline analysis. Sending the buffer rather than a
    path also sidesteps file:// escaping and keeps the CSP surface to blob:.
  */
  ipcMain.handle('read-local-file', (_e, filePath) => {
    try {
      const data = fs.readFileSync(filePath);
      // Transfer the bytes themselves, not a Node Buffer view of a pool.
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } catch (err) {
      console.error('[local] read failed:', err.message);
      return null;
    }
  });

  /* The renderer announcing which local song is now playing. Routed through the
     same path as an SMTC track so lyrics, artwork, mood and the cache all work
     exactly as they do for any other player. */
  ipcMain.handle('set-local-track', (_e, incoming) => {
    if (!incoming || !incoming.title) return { status: 'ignored' };
    localPlaybackActive = true;
    const track = {
      title: incoming.title,
      artist: cleanArtist(incoming.artist || ''),
      durationMs: incoming.durationMs || 0,
      localPath: incoming.localPath || null,
    };
    currentTrack = track;
    if (appTray) appTray.setTrack(track);
    send('track', { ...track, ...paletteForTrack(track) });
    send('offset', { offsetMs: activeOffsetMs(), perTrack: true });
    const saved = llmCache.get(trackKey(track));
    send('beatmap', { track, beatmap: (saved && saved.beatmap) || null });
    send('heatmap', { track, heatmap: (saved && saved.heatmap) || null });
    loadLyricsFor(track);
    loadArtworkFor(track);
    return { status: 'ok' };
  });

  /* Hand control back to whatever else is playing on the machine. */
  ipcMain.handle('end-local-playback', () => {
    localPlaybackActive = false;
    currentTrack = null;
    send('idle', null);
    return { status: 'ok' };
  });

  /* Snapshot of every cached song for the synced-songs library UI. */
  ipcMain.handle('list-synced', () => llmCache.list());

  /*
    Whisper transcription for songs LRCLIB has no synced lyrics for.

    The renderer records the loopback audio for one full play (see
    src/renderer/capture.js) and hands over mono 16 kHz PCM here. We
    transcribe, cache the cues to disk, and push them to the UI — so this play
    gets nothing, but every later play of the song is instant and offline.
    Same learn-on-first-listen shape as the beat maps.

    Serialised behind `transcribeBusy`: the model is memory- and CPU-hungry,
    and two concurrent passes would simply fight for the same cores.
  */
  ipcMain.handle('transcribe-audio', async (_e, payload) => {
    const track = payload && payload.track;
    const pcm = payload && payload.pcm;
    if (!track || !pcm || !pcm.length) return { status: 'ignored' };
    if (transcribeBusy) return { status: 'busy' };

    // Don't spend minutes of CPU on a track whose lyrics arrived meanwhile
    // (e.g. fetched on a retry, or pre-synced from the 📋 panel).
    const key = trackKey(track);
    const existing = llmCache.get(key);
    if (existing && Array.isArray(existing.cues) && existing.cues.length > 0) {
      /*
        We already have the right WORDS for this song — so rather than
        transcribing it (pointless, we know the lyrics), spend the pass on the
        one thing the lyrics cannot provide: WHEN each word was sung.

        Same learn-on-first-listen shape as the beat map. The result is cached,
        so a song is aligned once and every later play is word-synced instantly
        and offline.
      */
      if (existing.cues.some((c) => Array.isArray(c.words) && c.words.length)) {
        return { status: 'already-aligned' };
      }
      transcribeBusy = true;
      try {
        send('transcribe-progress', { track, stage: 'aligning', pct: 10 });
        const heard = await transcribePcm(pcm, {
          modelId: settings.get('whisperModel') || DEFAULT_MODEL,
          language: payload.language || settings.get('whisperLanguage') || undefined,
          wordTimestamps: true,
        });
        const aligned = attachWordTimings(existing.cues, heard.words || []);
        // A weak alignment is mostly interpolation dressed up as measurement;
        // the syllable estimate in the renderer is honester than that.
        if (aligned.coverage < 0.5) {
          /*
            Remember the failure, or this repeats forever: without a marker the
            song still has no word timings, so the next play records it again,
            runs Whisper again, and fails again — minutes of CPU burned on every
            replay of a song we already know we cannot align. The transcription
            is deterministic, so a second attempt would reach the same answer.
          */
          llmCache.merge(key, { wordAlignFailed: true });
          send('transcribe-progress', { track, stage: 'align-weak', coverage: Math.round(aligned.coverage * 100) });
          return { status: 'alignment-too-weak', coverage: aligned.coverage };
        }
        llmCache.merge(key, { cues: aligned.cues });
        const entry = lyricCache.get(key);
        if (entry) lyricCache.set(key, { ...entry, cues: aligned.cues });
        send('transcribe-progress', {
          track, stage: 'aligned', pct: 100,
          coverage: Math.round(aligned.coverage * 100),
        });
        // Only push it on screen if that song is still the one playing.
        if (currentTrack && trackKey(currentTrack) === key) {
          send('lyrics', { track, ...(lyricCache.get(key) || {}), origin: 'memory' });
        }
        return { status: 'ok', aligned: true, coverage: aligned.coverage };
      } catch (err) {
        send('transcribe-progress', { track, stage: 'error', message: err.message });
        return { status: 'error', message: err.message };
      } finally {
        transcribeBusy = false;
      }
    }

    transcribeBusy = true;
    send('transcribe-progress', { track, stage: 'starting', pct: 0 });
    try {
      const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
      const modelId = settings.get('whisperModel') || DEFAULT_MODEL;
      const forcedLanguage = payload.language || settings.get('whisperLanguage') || '';
      const onProgress = (p) => {
        // Model download only happens on the very first run.
        if (p && p.status === 'progress' && typeof p.progress === 'number') {
          send('transcribe-progress', {
            track, stage: 'downloading', pct: Math.round(p.progress), file: p.file,
          });
        }
      };

      let result = await transcribePcm(samples, {
        modelId,
        language: forcedLanguage || undefined,
        onProgress,
      });

      /*
        Auto-language, without asking the user to pick one.

        Whisper does not detect language here — omitting it silently decodes as
        English, which turns Hindi/Punjabi vocals into nonsense. But that
        nonsense is itself the signal: forced to English, the model writes
        phonetic approximations of Hindi that are thick with exactly the
        function words detectIndic() already recognises ("hai", "mera",
        "tera", ...). So we let the English pass happen, test its output, and
        redo the pass properly as Hindi when it looks Indic.

        Costs a second pass only for the tracks that need one, and only when
        the user has not pinned a language.
      */
      if (!forcedLanguage && result.cues.length && detectIndic(result.cues).indic) {
        send('transcribe-progress', { track, stage: 'relanguage', pct: 50 });
        try {
          const hindi = await transcribePcm(samples, {
            modelId, language: 'hindi', onProgress,
          });
          // Only accept the retry if it actually produced something usable.
          if (hindi.cues.length) result = hindi;
        } catch (err) {
          // Keep the English pass rather than losing the whole transcription.
          console.warn('[transcribe] Hindi retry failed:', err.message);
        }
      }

      if (!result.cues.length) {
        send('transcribe-progress', { track, stage: 'empty', pct: 100 });
        return { status: 'empty' };
      }

      /*
        Second lyric source: LRCLIB's *plain* lyrics.

        Far more songs have plain lyrics than synced ones. Alone they cannot
        scroll, but Whisper is much better at knowing WHEN a line was sung than
        WHAT its words were — so aligning the real words onto the transcribed
        timings beats the transcription outright. Only adopted when enough
        lines actually anchor; a weak alignment is mostly interpolation and the
        honest transcription is the better answer then.
      */
      let usedSource = 'whisper';
      try {
        const plain = await fetchPlainLyrics(track);
        if (plain) {
          const lines = splitPlainLyrics(plain.plain);
          const aligned = alignLyrics(lines, result.cues, { durationMs: track.durationMs });
          if (aligned.coverage >= 0.35 && aligned.cues.length) {
            result = { ...result, cues: aligned.cues };
            usedSource = 'lrclib-plain+whisper';
            send('transcribe-progress', {
              track, stage: 'aligned', pct: 90,
              lines: aligned.cues.length,
              coverage: Math.round(aligned.coverage * 100),
            });
          }
        }
      } catch (err) {
        console.warn('[align] plain-lyric alignment skipped:', err.message);
      }

      /*
        LLM correction pass — the "brain" half of the ear/brain split.

        Guarded on `usedSource === 'whisper'` deliberately. If the block above
        anchored LRCLIB's real lyrics onto Whisper's timings, the words are
        already correct and asking a model to "correct" them can only make them
        wrong. This runs exactly when we have nothing but what the model heard,
        which is also when it is worth the most.

        Failure is not fatal at any level: a bad batch keeps that batch's
        original lines, and a total failure returns the transcript untouched.
      */
      if (usedSource === 'whisper' && isCorrectionAvailable()) {
        try {
          const fixed = await correctTranscript(result.cues, track, ({ batch, batches }) => {
            send('transcribe-progress', {
              track, stage: 'correcting', pct: 92, batch, batches,
            });
          });
          if (fixed.corrected) {
            result = { ...result, cues: fixed.cues };
            usedSource = 'whisper+llm';
            send('transcribe-progress', {
              track, stage: 'corrected', pct: 96, changed: fixed.changed,
            });
          }
        } catch (err) {
          console.warn('[correct] pass skipped:', err.message);
        }
      }

      const indic = detectIndic(result.cues).indic;
      const payloadOut = {
        cues: result.cues,
        cuesDevanagari: null,
        cuesEnglish: null,
        source: { name: usedSource, artistName: track.artist || null },
        status: 'ok',
        hasWordTimings: hasWords(result.cues),
        indic,
        transliterationAvailable: isTransliterationAvailable(),
        translationAvailable: isTranslationAvailable() || canTranslateLocally(result.cues),
      };
      lyricCache.set(key, payloadOut);

      // Persist so the next play is instant, and the song joins the library.
      llmCache.merge(key, {
        title: track.title || null,
        artist: track.artist || null,
        cues: result.cues,
        source: payloadOut.source,
        indic,
      });

      send('transcribe-progress', {
        track, stage: 'done', pct: 100,
        lines: result.cues.length,
        dropped: result.droppedInstrumental || 0,
      });
      // Only surface the lyrics now if that song is still the one playing.
      if (currentTrack && trackKey(currentTrack) === key) {
        send('lyrics', { track, ...payloadOut, origin: 'whisper' });
      }
      return { status: 'ok', lines: result.cues.length };
    } catch (err) {
      send('transcribe-progress', { track, stage: 'error', message: err.message });
      return { status: 'error', message: err.message };
    } finally {
      transcribeBusy = false;
    }
  });

  /*
    Cover-art alternatives for the current track.

    Not cached: the panel is opened rarely and deliberately, and a stale list is
    exactly what the user is trying to escape when they open it.
  */
  ipcMain.handle('artwork-candidates', async (_e, payload) => {
    const track = (payload && payload.track) || currentTrack;
    if (!track) return { status: 'no-track', candidates: [] };
    try {
      const candidates = await fetchArtworkCandidates(track);
      return { status: 'ok', candidates };
    } catch (err) {
      return { status: 'error', message: err.message, candidates: [] };
    }
  });

  /*
    Adopt a chosen cover. Persisted per track, so it survives a restart and
    costs one download rather than a search on every later play.

    The chosen cover DOES drive the palette, because that is what the artwork
    event has always done and the alternative — a poster that disagrees with the
    colours around it — looks like a bug. Picking a cover recolours the app.
  */
  ipcMain.handle('choose-artwork', async (_e, payload) => {
    const track = (payload && payload.track) || currentTrack;
    const url = payload && payload.url;
    if (!track || !url) return { status: 'ignored' };

    const artwork = await downloadImage(url);
    if (!artwork) return { status: 'error', message: 'that cover could not be downloaded' };

    const key = trackKey(track);
    llmCache.merge(key, {
      title: track.title || null,
      artist: track.artist || null,
      artworkUrl: url,
      artworkArtist: (payload && payload.artistName) || null,
      artworkTitle: (payload && payload.trackName) || null,
    });

    // Invalidate any in-flight automatic lookup for this track, or it can land
    // after the choice and overwrite it.
    artworkToken += 1;

    if (currentTrack && trackKey(currentTrack) === key) {
      send('artwork', {
        track,
        artwork,
        artistName: (payload && payload.artistName) || null,
        trackName: (payload && payload.trackName) || null,
        chosen: true,
      });
    }
    return { status: 'ok' };
  });

  /** Forget a hand-picked cover and go back to whatever the search finds. */
  ipcMain.handle('clear-artwork-choice', async (_e, payload) => {
    const track = (payload && payload.track) || currentTrack;
    if (!track) return { status: 'ignored' };
    llmCache.merge(trackKey(track), {
      artworkUrl: null, artworkArtist: null, artworkTitle: null,
    });
    loadArtworkFor(track);
    return { status: 'ok' };
  });

  ipcMain.handle('get-transcribe-config', () => ({
    models: MODELS,
    model: settings.get('whisperModel') || DEFAULT_MODEL,
    language: settings.get('whisperLanguage') || '',
    enabled: settings.get('whisperEnabled') !== false,
  }));

  ipcMain.handle('set-transcribe-config', (_e, cfg) => {
    if (cfg && typeof cfg.model === 'string' && MODELS.some((m) => m.id === cfg.model)) {
      settings.set('whisperModel', cfg.model);
    }
    if (cfg && typeof cfg.language === 'string') settings.set('whisperLanguage', cfg.language);
    if (cfg && typeof cfg.enabled === 'boolean') settings.set('whisperEnabled', cfg.enabled);
    return {
      model: settings.get('whisperModel') || DEFAULT_MODEL,
      language: settings.get('whisperLanguage') || '',
      enabled: settings.get('whisperEnabled') !== false,
    };
  });

  ipcMain.handle('get-provider-status', () => ({ provider: activeProvider() }));

  // Persist an API key typed into the 🔑 panel. `name` is a canonical key name
  // (e.g. 'HF_API_KEY'); an empty value clears it. Returns the resulting active
  // provider so the UI can reflect the change immediately.
  ipcMain.handle('set-api-key', (_e, name, value) => {
    const allowed = new Set([
      'HF_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
    ]);
    if (!allowed.has(name)) return { status: 'error', message: 'Unknown key name.' };
    try {
      setKey(name, value);
      return { status: 'ok', provider: activeProvider() };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  });

  app.on('before-quit', () => watcher.stop());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (appUpdater) appUpdater.stop();
});
app.on('window-all-closed', () => app.quit());
