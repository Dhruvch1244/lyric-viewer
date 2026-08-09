'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');

const { SmtcWatcher } = require('./smtc');
const { fetchSyncedLyrics, detectIndic } = require('./lyrics');
const { toDevanagari, isTransliterationAvailable } = require('./transliterate');
const { toEnglish, isTranslationAvailable } = require('./translate');
const { analyzeSentiment, isSentimentAvailable } = require('./sentiment');
const { Settings } = require('./settings');
const { paletteForTrack, paletteFromSentiment, trackKey } = require('@lyric-viewer/core');

/** @type {BrowserWindow|null} */
let win = null;

/** Persisted user settings (offsets, script preference). */
const settings = new Settings();

/** In-memory lyric cache keyed by "artist|title". */
const lyricCache = new Map();

/** Guards against overlapping lookups when tracks change quickly. */
let lookupToken = 0;

/** The track currently playing, used to key per-track sync offsets. */
let currentTrack = null;

// hslHex / paletteForTrack / paletteFromSentiment / trackKey now live in
// packages/core (shared with the iOS app) — imported above.

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
 * Resolve lyrics for a track and kick off translation when it looks Indic.
 * @param {{title: string, artist: string, durationMs: number}} track
 */
async function loadLyricsFor(track) {
  const key = trackKey(track);
  const token = ++lookupToken;

  if (lyricCache.has(key)) {
    const cached = lyricCache.get(key);
    send('lyrics', { track, ...cached });
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
    send('lyrics', { track, ...payload });
    return;
  }

  const indic = detectIndic(result.cues).indic || Boolean(result.cuesDevanagari);

  const payload = {
    cues: result.cues,
    cuesDevanagari: result.cuesDevanagari,
    cuesEnglish: null,
    source: result.source,
    status: 'ok',
    indic,
    transliterationAvailable: isTransliterationAvailable(),
    translationAvailable: isTranslationAvailable(),
  };

  lyricCache.set(key, payload);
  send('lyrics', { track, ...payload });

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
    lyricCache.set(key, { ...entry, mood });
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
  if (!entry.indic || !isTranslationAvailable()) return;

  send('translation', { track, status: 'translating' });
  try {
    const { cues, language } = await toEnglish(entry.cues);
    if (token !== lookupToken) return;
    // Skip showing a translation the model judged already-English.
    if (language === 'english') {
      lyricCache.set(key, { ...entry, cuesEnglish: null, language });
      send('translation', { track, status: 'skipped', language });
      return;
    }
    lyricCache.set(key, { ...entry, cuesEnglish: cues, language });
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
    lyricCache.set(key, { ...entry, cuesDevanagari: cues });
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
  win = createWindow();
  registerShortcuts();

  const watcher = new SmtcWatcher({ intervalMs: 250 });

  watcher.on('track', (track) => {
    currentTrack = track;
    send('track', { ...track, ...paletteForTrack(track) });
    send('offset', { offsetMs: activeOffsetMs(), perTrack: true });
    loadLyricsFor(track);
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
      lyricCache.set(key, { ...entry, cuesEnglish: cues, language });
      return { status: 'ok', cues, language };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  });

  app.on('before-quit', () => watcher.stop());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
