'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, desktopCapturer } = require('electron');
const path = require('path');

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
const { fetchSyncedLyrics, detectIndic, cleanArtist } = require('./lyrics');
const { toDevanagari, isTransliterationAvailable } = require('./transliterate');
const { toEnglish, isTranslationAvailable } = require('./translate');
const { analyzeSentiment, isSentimentAvailable } = require('./sentiment');
const { Settings } = require('./settings');
const { LlmCache } = require('./cache');
const { fetchArtwork } = require('./artwork');
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
 * Fetch cover art + full artist credit for a track and push it to the renderer.
 * Best-effort: on any failure the visuals simply keep their hash palette and the
 * SMTC-reported artist. Guarded by `artworkToken` so a rapid track change wins.
 * @param {{title: string, artist: string, durationMs: number}} track
 */
async function loadArtworkFor(track) {
  const token = ++artworkToken;
  try {
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
    const payload = {
      cues: disk.cues,
      cuesDevanagari: disk.cuesDevanagari || null,
      cuesEnglish: disk.cuesEnglish || null,
      language: disk.language,
      mood: disk.mood || null,
      source: disk.source || null,
      status: 'ok',
      indic: Boolean(disk.indic),
      transliterationAvailable: isTransliterationAvailable(),
      translationAvailable: isTranslationAvailable(),
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
    cuesEnglish: saved.cuesEnglish || null,
    language: saved.language,
    mood: saved.mood || null,
    source: result.source,
    status: 'ok',
    indic,
    transliterationAvailable: isTransliterationAvailable(),
    translationAvailable: isTranslationAvailable(),
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
  if (!entry.indic || !isTranslationAvailable()) return;

  send('translation', { track, status: 'translating' });
  try {
    const { cues, language } = await toEnglish(entry.cues);
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

/** Register global hotkeys. */
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+Left', () => setOffsetMs(activeOffsetMs() - 100));
  globalShortcut.register('CommandOrControl+Alt+Right', () => setOffsetMs(activeOffsetMs() + 100));
  globalShortcut.register('CommandOrControl+Alt+0', () => setOffsetMs(0));
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
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

  const watcher = new SmtcWatcher({ intervalMs: 250 });

  watcher.on('track', (rawTrack) => {
    // Clean the artist credit once, here at the SMTC boundary, so every
    // consumer downstream sees the same tidy value: lyric matching, artwork
    // search, the dancer registry, the cache key and the on-screen label.
    // YouTube Music reports "Seedhe Maut - Topic" and VEVO uploads append
    // "VEVO"; both wreck matching and look wrong on screen.
    const track = { ...rawTrack, artist: cleanArtist(rawTrack.artist) };
    currentTrack = track;
    send('track', { ...track, ...paletteForTrack(track) });
    send('offset', { offsetMs: activeOffsetMs(), perTrack: true });
    // Hand the renderer any learned beat map for this song (null on first listen).
    const saved = llmCache.get(trackKey(track));
    send('beatmap', { track, beatmap: (saved && saved.beatmap) || null });
    loadLyricsFor(track);
    loadArtworkFor(track);
  });

  watcher.on('tick', (state) => {
    send('tick', { ...state, positionMs: (state.positionMs ?? 0) - activeOffsetMs() });
  });

  watcher.on('idle', () => {
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
    if (!isTranslationAvailable()) {
      return { status: 'unavailable', message: 'Set ANTHROPIC_API_KEY for translation.' };
    }
    const key = trackKey(currentTrack);
    const entry = lyricCache.get(key);
    if (!entry || entry.cues.length === 0) return { status: 'unavailable', message: 'No lyrics loaded.' };
    if (entry.cuesEnglish) return { status: 'ok', cues: entry.cuesEnglish, language: entry.language };
    try {
      const { cues, language } = await toEnglish(entry.cues);
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
      return { status: 'already-have-lyrics' };
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

      const indic = detectIndic(result.cues).indic;
      const payloadOut = {
        cues: result.cues,
        cuesDevanagari: null,
        cuesEnglish: null,
        source: { name: 'whisper', artistName: track.artist || null },
        status: 'ok',
        indic,
        transliterationAvailable: isTransliterationAvailable(),
        translationAvailable: isTranslationAvailable(),
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

      send('transcribe-progress', { track, stage: 'done', pct: 100, lines: result.cues.length });
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

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
