'use strict';

/*
  window.player — Tauri backing for the API the renderer used to get from
  Electron's preload/contextBridge.

  In Electron this object was built in preload.js over ipcRenderer. Tauri has no
  preload; instead the runtime injects a global `window.__TAURI__` (enabled by
  `app.withGlobalTauri` in tauri.conf.json) exposing `core.invoke` and
  `event.listen`. This shim rebuilds the exact same `window.player` shape on top
  of those, so renderer.js and player.js need no changes.

  Loaded FIRST (before player.js / renderer.js) via a <script> in index.html.

  Resilience during the migration: a backend command that is not implemented yet
  rejects. Getters here therefore `.catch` to a safe default so the UI still
  boots against a partial Rust backend; each real command replaces a default as
  its phase lands. Event subscriptions are always safe — they just never fire
  until the backend emits.
*/
(function () {
  const T = window.__TAURI__;
  if (!T) {
    // Not running under Tauri — a plain browser (e.g. the web demo, which
    // doesn't load this shim). Leave window.player untouched.
    return;
  }

  const invoke = T.core.invoke;
  const listen = T.event.listen;

  /**
   * Subscribe a renderer callback to a backend event. The renderer's callbacks
   * expect the payload directly (Electron passed `(event, data) => cb(data)`),
   * so unwrap Tauri's `{ payload }` envelope here.
   * @param {string} name event name
   * @param {(data: any) => void} cb
   */
  function on(name, cb) {
    listen(name, (evt) => {
      try { cb(evt && evt.payload); } catch (err) { console.error(`[${name}]`, err); }
    });
  }

  /**
   * Invoke a backend command, falling back to `fallback` if it is not yet
   * implemented (or fails) so boot survives a partial backend.
   * @param {string} cmd snake_case Tauri command name
   * @param {any} args
   * @param {any} fallback
   */
  function call(cmd, args, fallback) {
    return invoke(cmd, args).catch((err) => {
      if (fallback !== undefined) {
        console.warn(`[tauri-shim] ${cmd} → default (${err})`);
        return fallback;
      }
      throw err;
    });
  }

  window.player = {
    /* ---- push events (main → renderer) ---- */
    onTrack: (cb) => on('track', cb),
    onTick: (cb) => on('tick', cb),
    onLyrics: (cb) => on('lyrics', cb),
    onTranslation: (cb) => on('translation', cb),
    onMood: (cb) => on('mood', cb),
    onAttribution: (cb) => on('attribution', cb),
    onWallpaperPointer: (cb) => on('wallpaper-pointer', cb),
    onWallpaperPower: (cb) => on('wallpaper-power', cb),
    onArtwork: (cb) => on('artwork', cb),
    onBeatmap: (cb) => on('beatmap', cb),
    onHeatmap: (cb) => on('heatmap', cb),
    onPresyncProgress: (cb) => on('presync-progress', cb),
    onTranscribeProgress: (cb) => on('transcribe-progress', cb),
    onIdle: (cb) => on('idle', cb),
    onVisibility: (cb) => on('overlay-visibility', cb),
    onDisplayMode: (cb) => on('display-mode', cb),
    onUpdateState: (cb) => on('update-state', cb),
    onLocalcliOffer: (cb) => on('localcli-offer', cb),
    onOffset: (cb) => on('offset', cb),
    onNativeAudio: (cb) => on('native-audio', cb),

    /* ---- invoke commands (renderer → main). snake_case per Tauri. ---- */
    // Re-announce whatever SMTC already knows, once onTrack/onTick are
    // registered — see resync_smtc in lib.rs for the race this closes.
    resyncSmtc: () => call('resync_smtc', {}),
    setDisplayMode: (mode) => call('set_display_mode', { mode }),
    getDisplayMode: () => call('get_display_mode', {}, 'full'),
    wallpaperInteract: (on) => call('wallpaper_interact', { on }),

    startAudioCapture: () => call('start_audio_capture', {}, false),
    stopAudioCapture: () => call('stop_audio_capture', {}),

    getAutostart: () => call('get_autostart', {}, false),
    setAutostart: (enabled) => call('set_autostart', { enabled }, false),

    localcliDetect: () => call('localcli_detect', {}, { detected: [] }),
    localcliStatus: () => call('localcli_status', {}, {}),
    localcliConsent: (id) => call('localcli_consent', { id }),

    milkdropCatalogue: () => call('milkdrop_catalogue', {}, []),
    milkdropPreset: (name) => call('milkdrop_preset', { name }),
    milkdropThumbs: (names) => call('milkdrop_thumb_get', { names }, {}),
    milkdropThumbSave: (name, dataUrl) => call('milkdrop_thumb_put', { name, dataUrl }),
    milkdropThumbClear: () => call('milkdrop_thumb_clear', {}),

    getUpdateState: () => call('get_update_state', {}, { available: false }),
    updateAction: (action) => call('update_action', { action }),

    getOffset: () => call('get_offset', {}, { offsetMs: 0 }),
    setOffset: (valueMs) => call('set_offset', { valueMs }, valueMs),
    getPrefs: () => call('get_prefs', {}, {}),
    setScript: (script) => call('set_script', { script }),
    setShowTranslation: (show) => call('set_show_translation', { show }),
    requestTranslation: () => call('request_translation', {}),
    getProviderStatus: () => call('get_provider_status', {}, { provider: null }),
    setApiKey: (name, value) => call('set_api_key', { name, value }),
    saveBeatmap: (payload) => call('save_beatmap', { payload }),
    saveHeatmap: (payload) => call('save_heatmap', { payload }),

    openLocalFiles: () => call('open_local_files', {}, []),
    openLocalFolder: () => call('open_local_folder', {}, []),
    readLocalFile: (filePath) => call('read_local_file', { filePath }),
    /* Native per-song analysis (symphonia decode + envelope/onset DSP) so the
       renderer doesn't decode + crunch the whole track on the UI thread. */
    analyzeLocalFile: (path) => call('analyze_local_file', { path }, { ok: false }),
    setLocalTrack: (track) => call('set_local_track', { track }),
    endLocalPlayback: () => call('end_local_playback', {}),

    reportJobs: (payload) => call('report_jobs', { payload }),
    reportClientError: (message) => call('report_client_error', { message }),
    openCrashLog: () => call('open_crash_log', {}, { status: 'error', message: 'unavailable' }),
    setCrashReporting: (enabled) => call('set_crash_reporting', { enabled }),
    artworkCandidates: (track) => call('artwork_candidates', { track }, { candidates: [] }),
    chooseArtwork: (payload) => call('choose_artwork', { payload }),
    clearArtworkChoice: (track) => call('clear_artwork_choice', { track }),
    importLyrics: (track) => call('import_lyrics', { track }, { status: 'error', message: 'unavailable' }),
    clearManualLyrics: (track) => call('clear_manual_lyrics', { track }),

    presyncList: (text) => call('presync_list', { text }),
    precomputeTracks: (tracks) => call('precompute_tracks', { tracks }, { status: 'error' }),
    listSynced: () => call('list_synced', {}, []),

    /*
      Transcription runs in the webview now (see whisper.js): Whisper turns the
      recorded PCM into cues here, then the backend aligns them to the real plain
      lyrics and caches the result. Progress is relayed through the backend so it
      reaches the renderer's existing onTranscribeProgress handler. The PCM never
      crosses IPC — only the small cue list does.
    */
    transcribeAudio: async (payload) => {
      const track = payload && payload.track;
      const report = (data) => invoke('report_transcribe_progress', { data: Object.assign({ track }, data) }).catch(() => {});
      try {
        if (!window.Whisper) {
          await report({ stage: 'error', message: 'speech engine unavailable' });
          return { status: 'error' };
        }
        await report({ stage: 'starting' });
        let pcm = payload.pcm;
        // Experimental, off by default (see demucs.js for why): isolate
        // vocals before transcribing rather than feeding Whisper the full
        // mix. A failure here falls back to the raw signal rather than
        // losing the transcription entirely.
        if (payload.vocalIsolation && window.Demucs) {
          try {
            pcm = await window.Demucs.isolateVocals(pcm, 16000, {
              outputRate: 16000,
              onProgress: (p) => report({ stage: 'isolating-vocals', pct: p.pct }),
            });
          } catch (err) {
            console.warn('[demucs] vocal isolation failed, transcribing the raw mix:', err && err.message);
          }
        }
        const cues = await window.Whisper.transcribe(pcm, {
          language: payload.language,
          onProgress: (p) => report(p),
        });
        if (!cues || cues.length === 0) {
          await report({ stage: 'empty' });
          return { status: 'empty' };
        }
        return await invoke('finalize_transcription', { payload: { track, cues, language: payload.language } });
      } catch (err) {
        await report({ stage: 'error', message: String((err && err.message) || err) });
        return { status: 'error' };
      }
    },
    getTranscribeConfig: () => call('get_transcribe_config', {}, { enabled: true, language: '', model: '', vocalIsolation: false }),
    setTranscribeConfig: (cfg) => call('set_transcribe_config', { cfg }),
  };
})();
