'use strict';

/*
  Which recorder learns a song, and the teardown that goes with it.

  Two recorders exist and they are not interchangeable:

    native  — the Rust backend already runs a WASAPI loopback thread to feed
              `native-audio` frames, so it taps that same thread and writes the
              song straight to a temp file. Nothing but a track object crosses
              IPC, and the transcription runs in the inference sidecar
              (docs/JOB-ENGINE.md §7.10). This is the default.

    webview — capture.js + WASM Whisper in this page. Reached for the one thing
              the sidecar cannot do yet (vocal isolation — Demucs is not
              ported) and for any setup where native loopback is unavailable,
              e.g. the getDisplayMedia fallback, where the audio only exists as
              a MediaStream in this process.

  Picking between them is asked, never inferred: `startNativeSongRecording`
  answering false is the signal to use the webview recorder. The renderer
  cannot tell from `AudioReactive.isActive()` alone which capture path is live,
  and guessing would silently record nothing.

  The awkward part this module exists to contain is the window between
  "recording claimed" and "recorder actually running" — one backend round trip,
  during which a track change can arrive. `begin` claims the slot
  synchronously, so a second `begin` cannot start a second recorder, and undoes
  itself if the slot was taken away while it was starting.

  Exposed on window.TranscriptionListen:
    - create(deps) -> listener
*/

(function () {
  /**
   * @typedef {object} ListenDeps
   * @property {object} player            window.player (the backend bridge)
   * @property {() => object|null|undefined} getCapture  window.PcmCapture, read
   *   lazily so a listener created before capture.js loads still works
   * @property {() => boolean} wantsIsolation  whether vocal isolation is on,
   *   which forces the webview recorder
   */

  /**
   * Build a listener. One per renderer; it holds the single in-flight
   * recording and the recorder it belongs to.
   * @param {ListenDeps} deps
   */
  function create(deps) {
    /** The track being recorded, or null. */
    let track = null;
    /** 'pending' | 'native' | 'webview' | null — see the module comment. */
    let mode = null;

    /**
     * Start recording `next` so it can be transcribed once it ends. Safe to
     * call repeatedly; the second call while one is active is a no-op.
     * @param {object} next the track to attribute the recording to
     * @returns {Promise<'native'|'webview'|null>} the recorder that started,
     *   or null if none would start or the listen was cancelled while starting
     */
    async function begin(next) {
      if (track || !next) return null;

      // Claim the slot before the first await. A second begin() arriving
      // during the round trip below would otherwise start a second recorder
      // against the same song.
      track = next;
      mode = 'pending';

      let started = null;
      if (!deps.wantsIsolation() && deps.player.startNativeSongRecording) {
        const ok = await deps.player.startNativeSongRecording().catch(() => false);
        if (ok) started = 'native';
      }
      if (!started) {
        const capture = deps.getCapture();
        if (capture && capture.start()) started = 'webview';
      }

      if (!started) {
        // Neither recorder would run. Release the slot rather than leaving the
        // song marked as listened-to, so a later attempt can retry it.
        if (track === next) { track = null; mode = null; }
        return null;
      }
      if (track !== next) {
        // stop() or flush() ran while we were starting, or the track changed.
        // Undo what we just started instead of leaking a recording nobody owns.
        undo(started);
        return null;
      }
      mode = started;
      return started;
    }

    /** Tear down a recorder that was started for a song no longer being listened to. */
    function undo(which) {
      if (which === 'native') deps.player.discardNativeSongRecording();
      else {
        const capture = deps.getCapture();
        if (capture) capture.reset();
      }
    }

    /**
     * Abandon the in-progress recording without transcribing it — real lyrics
     * turned up, or the user skipped the song.
     */
    function stop() {
      if (!track) return;
      const was = mode;
      track = null;
      mode = null;
      // 'pending' needs nothing: no recorder has started, and clearing `track`
      // above is what tells the in-flight begin() to undo itself.
      if (was === 'native' || was === 'webview') undo(was);
    }

    /**
     * Hand what was recorded to the backend for transcription. Called as the
     * track changes, which is when we know the song is over.
     *
     * @param {{language?: string}} [opts]
     * @returns {'native'|'webview'|null} the recorder that was flushed, or
     *   null when there was nothing to flush (never listening, still pending,
     *   or too little audio for the webview recorder to bother with)
     */
    function flush(opts) {
      if (!track) return null;
      const was = mode;
      const of = track;
      const language = (opts && opts.language) || undefined;
      track = null;
      mode = null;

      if (was === 'native') {
        // The samples are already in the backend — this only names the song
        // they belong to. Everything after (models, VAD, Whisper, alignment,
        // caching) is the pipeline transcribe_local_file already runs.
        deps.player
          .stopNativeSongRecording(of, language)
          .catch((err) => console.warn('[listen] native flush failed:', err && err.message));
        return 'native';
      }
      if (was !== 'webview') return null; // 'pending' — nothing was recorded

      const capture = deps.getCapture();
      if (!capture) return null;
      const pcm = capture.take(); // null when too little audio to bother
      if (!pcm) return null;

      deps.player
        .transcribeAudio({ track: of, pcm, language, vocalIsolation: deps.wantsIsolation() })
        .catch((err) => console.warn('[listen] failed:', err && err.message));
      return 'webview';
    }

    return {
      begin,
      stop,
      flush,
      /** The track currently being recorded, or null. */
      track: () => track,
      /** Which recorder is running: 'pending', 'native', 'webview', or null. */
      mode: () => mode,
      isListening: () => track !== null,
    };
  }

  window.TranscriptionListen = { create };
})();
