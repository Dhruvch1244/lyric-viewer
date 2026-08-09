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
  onArtwork: (cb) => ipcRenderer.on('artwork', (_e, data) => cb(data)),
  onBeatmap: (cb) => ipcRenderer.on('beatmap', (_e, data) => cb(data)),
  onPresyncProgress: (cb) => ipcRenderer.on('presync-progress', (_e, data) => cb(data)),
  onIdle: (cb) => ipcRenderer.on('idle', () => cb()),
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
  presyncList: (text) => ipcRenderer.invoke('presync-list', text),
});
