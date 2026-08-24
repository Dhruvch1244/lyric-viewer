'use strict';

/*
  Local playback — the app as a player, not only an overlay.

  Until now this was strictly a passenger: it watched whatever Windows reported
  through SMTC and drew on top. That worked, but it left two structural
  weaknesses that no amount of visual work could fix.

    1. Everything the app LEARNS needed `♫` loopback capture and a full listen.
       A song's shape, its tempo, and the anticipation that reads a stored map
       forwards were all unavailable on a first play.

    2. Position came from a 250ms poll of an external process, so the lyric
       clock was always chasing.

  Owning playback fixes both. The decoded samples are in hand before the first
  note, so `SongAnalysis` measures the entire track offline in well under a
  second — the timeline is full, the tempo is locked and a drop can be
  anticipated on play one, with no capture and no permission prompt. And
  `audio.currentTime` is exact.

  Exposed on window.LocalPlayer.
*/

(function () {
  /** @type {HTMLAudioElement|null} */
  let el = null;
  /** @type {Array<{localPath: string, title: string, artist: string}>} */
  let queue = [];
  let index = -1;
  /** Object URL for the track currently loaded; revoked when replaced. */
  let objectUrl = null;
  /** Callbacks the renderer registers. */
  const listeners = { track: null, tick: null, ended: null, analysed: null };

  /** Whether a local file is what is currently playing. */
  function isActive() {
    return Boolean(el && queue.length > 0 && index >= 0);
  }

  /** The audio element, created lazily so nothing exists until first use. */
  function element() {
    if (el) return el;
    el = new Audio();
    el.preload = 'auto';
    el.addEventListener('ended', () => { next(); });
    el.addEventListener('timeupdate', emitTick);
    el.addEventListener('play', emitTick);
    el.addEventListener('pause', emitTick);
    return el;
  }

  function emitTick() {
    if (!el || !listeners.tick) return;
    listeners.tick({
      status: el.paused ? 'Paused' : 'Playing',
      positionMs: el.currentTime * 1000,
      durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0,
    });
  }

  /**
   * Add songs to the queue. Starts playing if nothing is.
   * @param {Array<{localPath: string, title: string, artist: string}>} items
   */
  async function enqueue(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const wasEmpty = queue.length === 0;
    queue = queue.concat(items);
    if (wasEmpty) await playAt(0);
  }

  /**
   * Load and play the queue entry at `i`.
   *
   * The file is read once and used twice — as a Blob for playback and as an
   * ArrayBuffer for analysis. Reading it twice would double the I/O for a
   * result we already have in memory.
   *
   * @param {number} i
   */
  async function playAt(i) {
    if (i < 0 || i >= queue.length) return;
    index = i;
    const item = queue[i];

    const raw = await window.player.readLocalFile(item.localPath);
    if (!raw) {
      // A slow/failed read used to fall straight through to the next track
      // with nothing on screen — indistinguishable from the queue simply
      // being empty. setStatus is the app-wide mechanism for exactly this
      // kind of transient notice (renderer.js, #status/role="status").
      const label = item.title || item.localPath;
      if (typeof setStatus === 'function') setStatus(`couldn't read "${label}" — skipping`);
      next();
      return;
    }

    const audio = element();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([raw]));

    // A file that reads fine but is corrupt or an unsupported codec fires
    // 'error' on the element rather than rejecting anything awaitable here —
    // without this, playAt() falls through as if it were fine: track info
    // shows, nothing ever plays, and there is no visible failure state. The
    // sibling of the !raw case above, for a file that reads but does not decode.
    let decodeFailed = false;
    const onDecodeError = () => { decodeFailed = true; };
    audio.addEventListener('error', onDecodeError, { once: true });

    audio.src = objectUrl;

    // Wait for metadata so the duration is known before the track is announced —
    // the heat map bins against duration, so announcing early would bin wrong.
    await new Promise((resolve) => {
      const done = () => { audio.removeEventListener('loadedmetadata', done); resolve(); };
      audio.addEventListener('loadedmetadata', done);
      // Never hang on a file the decoder cannot read.
      setTimeout(done, 4000);
    });

    audio.removeEventListener('error', onDecodeError);
    if (decodeFailed) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      const label = item.title || item.localPath;
      if (typeof setStatus === 'function') setStatus(`couldn't play "${label}" — skipping`);
      next();
      return;
    }

    const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
    const track = { ...item, durationMs };
    await window.player.setLocalTrack(track);
    if (listeners.track) listeners.track(track);

    await audio.play().catch((err) => {
      // NotAllowedError is the ordinary autoplay-policy refusal the UI's own
      // play button already covers. Anything else — a file that passed
      // loadedmetadata but still can't actually decode, for instance — is a
      // real failure that deserves a visible status instead of silent nothing.
      if (err && err.name !== 'NotAllowedError') {
        const label = item.title || item.localPath;
        if (typeof setStatus === 'function') setStatus(`couldn't play "${label}"`);
      }
    });

    /*
      Warm the lyrics cache for what is queued behind this song, so it opens
      instantly instead of showing "searching…" for a network round trip.

      A queue is the one place "what plays next" is known rather than guessed,
      which is why this is a plain hand-off — the backend does not have to
      predict anything here. It runs at a lower priority than the current
      song's own lookup, and caches without emitting, so it cannot delay or
      overwrite what is on screen. Fire-and-forget: there is nothing to show
      when it finishes, and nothing to do if it fails.
    */
    if (window.player && window.player.precomputeTracks) {
      const ahead = queue.slice(i + 1, i + 3);
      if (ahead.length) window.player.precomputeTracks(ahead).catch(() => {});
    }

    /*
      Analyse AFTER playback starts, not before.

      The decode plus three envelope passes take a fraction of a second, but
      "a fraction of a second" is still a stall between pressing play and
      hearing sound. Starting first and measuring immediately after means the
      map is ready within the first bar — long before any drop it would predict.
    */
    analyse(raw, track);
  }

  /**
   * Decode and measure the whole song, then hand the result to the visuals.
   * @param {ArrayBuffer} raw @param {object} track
   */
  async function analyse(raw, track) {
    if (!window.SongAnalysis) return;

    /*
      Native analysis first. Rust (symphonia) decodes the file and runs the
      envelope/onset DSP off the UI thread, so the opening frames of a track are
      no longer stalled by a synchronous decode + multi-pass loop over millions
      of samples on the main thread. Falls through to the Web Audio path below
      if it is unavailable (a format symphonia cannot read, or a non-Tauri host).
    */
    if (track.localPath && window.player && window.player.analyzeLocalFile) {
      try {
        const a = await window.player.analyzeLocalFile(track.localPath);
        if (a && a.ok && Array.isArray(a.level) && a.level.length) {
          const summary = window.SongAnalysis.applyAnalysis(a, a.durationMs || track.durationMs || 0);
          if (listeners.analysed) listeners.analysed(track, { ...summary, ms: 0 });
          return;
        }
      } catch (err) {
        console.warn('[player] native analysis failed, falling back:', err && err.message);
      }
    }

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // decodeAudioData detaches the buffer it is given, so hand it a copy —
      // the original is still backing the Blob that is currently playing.
      const buffer = await ctx.decodeAudioData(raw.slice(0));
      const summary = window.SongAnalysis.loadFromBuffer(buffer);
      ctx.close();
      if (listeners.analysed) listeners.analysed(track, summary);
    } catch (err) {
      // A format Chromium will play but not decode offline is possible; the app
      // simply falls back to learning the song the slow way.
      console.warn('[player] offline analysis failed:', err.message);
    }
  }

  function togglePlay() {
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }

  function next() {
    if (index + 1 < queue.length) playAt(index + 1);
    else stop();
  }

  function previous() {
    // Restart the current track first, like every other player.
    if (el && el.currentTime > 3) { el.currentTime = 0; return; }
    if (index > 0) playAt(index - 1);
  }

  /** @param {number} ms */
  function seek(ms) {
    if (el && Number.isFinite(ms)) el.currentTime = Math.max(0, ms / 1000);
  }

  function stop() {
    if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    index = -1;
    queue = [];
    window.player.endLocalPlayback();
  }

  /** The element, so the reactive analyser can tap it. */
  function audioElement() {
    return el;
  }

  function on(name, fn) {
    if (name in listeners) listeners[name] = fn;
  }

  window.LocalPlayer = {
    enqueue, playAt, togglePlay, next, previous, seek, stop,
    isActive, audioElement, on,
    get queue() { return queue.slice(); },
    get index() { return index; },
  };
})();
