'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, explicitly-allowlisted bridge between main and renderer.
 * No Node APIs are exposed to page code.
 */
contextBridge.exposeInMainWorld('player', {
  onTrack: (cb) => ipcRenderer.on('track', (_e, data) => cb(data)),
  onTick: (cb) => ipcRenderer.on('tick', (_e, data) => cb(data)),
  onLyrics: (cb) => ipcRenderer.on('lyrics', (_e, data) => cb(data)),
  onTranslation: (cb) => ipcRenderer.on('translation', (_e, data) => cb(data)),
  onMood: (cb) => ipcRenderer.on('mood', (_e, data) => cb(data)),
  /* Which collaborator sings which line, once it has been worked out. Arrives
     separately from the lyrics because it is an LLM pass: the words must not
     wait for it. */
  onAttribution: (cb) => ipcRenderer.on('attribution', (_e, data) => cb(data)),
  onArtwork: (cb) => ipcRenderer.on('artwork', (_e, data) => cb(data)),
  onBeatmap: (cb) => ipcRenderer.on('beatmap', (_e, data) => cb(data)),
  onHeatmap: (cb) => ipcRenderer.on('heatmap', (_e, data) => cb(data)),
  onPresyncProgress: (cb) => ipcRenderer.on('presync-progress', (_e, data) => cb(data)),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe-progress', (_e, data) => cb(data)),
  onIdle: (cb) => ipcRenderer.on('idle', () => cb()),
  onVisibility: (cb) => ipcRenderer.on('overlay-visibility', (_e, data) => cb(data)),
  onDisplayMode: (cb) => ipcRenderer.on('display-mode', (_e, data) => cb(data)),
  setDisplayMode: (mode) => ipcRenderer.invoke('set-display-mode', mode),
  getDisplayMode: () => ipcRenderer.invoke('get-display-mode'),

  /** Every MilkDrop preset name the installed app holds. */
  milkdropCatalogue: () => ipcRenderer.invoke('milkdrop-catalogue'),
  /** One preset, parsed. Read from disk in main; see presetlib.js. */
  milkdropPreset: (name) => ipcRenderer.invoke('milkdrop-preset', name),
  /** @param {string[]} names @returns {Promise<Record<string,string>>} name → data URL */
  milkdropThumbs: (names) => ipcRenderer.invoke('milkdrop-thumb-get', names),
  milkdropThumbSave: (name, dataUrl) => ipcRenderer.invoke('milkdrop-thumb-put', name, dataUrl),
  milkdropThumbClear: () => ipcRenderer.invoke('milkdrop-thumb-clear'),

  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, data) => cb(data)),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  /** @param {'install'|'dismiss'|'check'} action */
  updateAction: (action) => ipcRenderer.invoke('update-action', action),
  onOffset: (cb) => ipcRenderer.on('offset', (_e, data) => cb(data)),

  getOffset: () => ipcRenderer.invoke('get-offset'),
  setOffset: (valueMs) => ipcRenderer.invoke('set-offset', valueMs),
  getPrefs: () => ipcRenderer.invoke('get-prefs'),
  setScript: (script) => ipcRenderer.invoke('set-script', script),
  setShowTranslation: (show) => ipcRenderer.invoke('set-show-translation', show),
  requestTranslation: () => ipcRenderer.invoke('request-translation'),
  getProviderStatus: () => ipcRenderer.invoke('get-provider-status'),
  setApiKey: (name, value) => ipcRenderer.invoke('set-api-key', name, value),
  saveBeatmap: (payload) => ipcRenderer.invoke('save-beatmap', payload),
  saveHeatmap: (payload) => ipcRenderer.invoke('save-heatmap', payload),

  /* Local playback. `readLocalFile` returns the raw bytes so the renderer can
     both play them and decode them for offline analysis from one read. */
  openLocalFiles: () => ipcRenderer.invoke('open-local-files'),
  openLocalFolder: () => ipcRenderer.invoke('open-local-folder'),
  readLocalFile: (filePath) => ipcRenderer.invoke('read-local-file', filePath),
  setLocalTrack: (track) => ipcRenderer.invoke('set-local-track', track),
  endLocalPlayback: () => ipcRenderer.invoke('end-local-playback'),

  /* Background work, mirrored to the tray tooltip and (for the few worth
     interrupting for) to an OS notification. */
  reportJobs: (payload) => ipcRenderer.invoke('report-jobs', payload),
  /* Cover art the user can choose from, when the automatic pick got it wrong.
     Candidates carry a small thumbnail; the full image is fetched only for the
     one that is chosen. */
  artworkCandidates: (track) => ipcRenderer.invoke('artwork-candidates', { track }),
  chooseArtwork: (payload) => ipcRenderer.invoke('choose-artwork', payload),
  clearArtworkChoice: (track) => ipcRenderer.invoke('clear-artwork-choice', { track }),

  presyncList: (text) => ipcRenderer.invoke('presync-list', text),
  listSynced: () => ipcRenderer.invoke('list-synced'),

  /**
   * Hand recorded loopback PCM to the main process for Whisper transcription.
   * `pcm` is a mono 16 kHz Float32Array; structured clone transfers it as-is,
   * so there is no base64/JSON blow-up on the way across.
   */
  transcribeAudio: (payload) => ipcRenderer.invoke('transcribe-audio', payload),
  getTranscribeConfig: () => ipcRenderer.invoke('get-transcribe-config'),
  setTranscribeConfig: (cfg) => ipcRenderer.invoke('set-transcribe-config', cfg),
});
