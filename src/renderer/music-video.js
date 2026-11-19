'use strict';

/*
  ▶ Music video — the song's video, playing in time under the visuals.

  WHAT IT IS. YouTube's own embedded player (youtube-nocookie.com), muted,
  full-screen behind everything, driven to follow whatever you are actually
  listening to: its time is the song's position (SMTC / the local player)
  plus a per-song offset, so Spotify plays the audio and the video keeps up.
  Nothing is downloaded and no YouTube script is loaded into this page — the
  player is controlled through its documented postMessage API
  (enablejsapi=1), the same messages the IFrame API sends.

  WHY A RELAY. The player is not framed directly: it is framed by
  web/embed/youtube.html on the project's website (RELAY below), which passes
  the postMessage traffic through unchanged. YouTube refuses an embed whose
  request has no Referer from a real web origin (error 153, "Video player
  configuration error"), and this page is tauri://localhost on Linux/macOS —
  measured: no Referer → ERROR, tauri://localhost → UNPLAYABLE, the website
  → OK. One path for every platform rather than a per-OS special case.

  WHY AN OFFSET. A music video is rarely the album track: there is an intro,
  a skit, a longer outro. The first guess is that the extra length is an
  intro (most common), capped at 30s; after that, `[` and `]` (or the panel's
  buttons) nudge it by a quarter second and the value is remembered for the
  song along with the video, so it only ever needs fixing once.

  VIDEO DIRECTOR. While the 🎬 Director is on, the section it is directing
  (renderer.js fires 'director-scene' at the cut veil's peak) also styles
  the video: dreamy and on its own in an intro, plain under soft visuals in a
  verse, the grade tightening through a build, neon under full visuals with
  a harder kick punch on a drop, noir in a break. Not saved — the panel's
  own grade and mix come straight back when the Director stops.

  THE LOOK. A colour grade on the video (CSS filters — the player is a
  cross-origin frame, so its pixels cannot be read or shaded, only filtered
  and composited), the app's visuals screen-blended on top at full, soft or
  no strength, and the video punched in on every kick like the other engines.

  LOCAL VIDEO. The same song can instead play a video FILE: one the user
  links (Open file…), or a copy of its YouTube video downloaded with the
  user's own yt-dlp (video.rs — the app never ships a downloader, and why).
  A file wins over the embed when there is one, unless the panel's switch
  has put that song back on YouTube (remembered per song). It plays in a <video>,
  muted, kept in time by steering playbackRate (localSync) — drift past
  0.12s is eased out by playing 5% fast or slow, only a real jump seeks — which
  the embed cannot do; and its pixels are readable, which is what lets the
  shaders work on the footage itself (frameSource()).

  FINDING THE VIDEO. With a YouTube Data API key (Settings), the first play of
  a song asks youtube.rs, which ranks the search results for the official
  video. Without one, paste the link once. Both are remembered per song.

  Runs after renderer.js and shares its globals (currentTrack,
  estimatePosition, playbackStatus, trackLookKey, durationMs, audioEnv,
  beatFlash, bgHue, applyKickPunch, closeRailPanels, setStatus).

  Exposed on window.MusicVideo: { parseVideoId, initialOffset, syncAction,
  localSync, videoMime, open, close, isOn, setOn, frameSource, isLocal }.
*/

(function () {
  /* -------------------------------------------------------- pure helpers */

  /** The 11-character id from a YouTube link (watch, youtu.be, shorts,
      embed, music.youtube) or a bare id. Null for anything else. */
  function parseVideoId(text) {
    const s = String(text || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    let url;
    try { url = new URL(s.includes('://') ? s : `https://${s}`); } catch { return null; }
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
        if (m) id = m[1];
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  /** First guess at video time minus song time, in seconds. */
  function initialOffset(videoSec, songSec) {
    if (!(videoSec > 0) || !(songSec > 0)) return 0;
    const extra = videoSec - songSec;
    // An intro is the usual reason a video runs long; past 30s it is more
    // likely a long outro or a skit at the end, so start at the beginning.
    return extra > 2 && extra <= 30 ? Math.round(extra * 4) / 4 : 0;
  }

  /**
   * What the player should do now.
   * @returns {'seek'|'play'|'pause'|null}
   */
  function syncAction({ videoTime, target, playing, wantPlaying, sinceSeekMs, duration }) {
    const inRange = target >= 0 && (!(duration > 0) || target < duration - 0.25);
    if (!wantPlaying || !inRange) return playing ? 'pause' : null;
    if (sinceSeekMs > 1200 && Math.abs(videoTime - target) > 0.45) return 'seek';
    if (!playing) return 'play';
    return null;
  }

  /**
   * Keeping a local <video> on the song: ease drift out through the playback
   * rate, seek only past `seekPast` seconds.
   *
   * WHY HYSTERESIS AND TWO FIXED RATES. The rate used to be re-aimed on every
   * 100ms tick (1 + drift * 0.8, any change over 0.005). Chromium shrugs that
   * off, but WebKitGTK implements a rate change as a GStreamer flush seek:
   * measured on a 25fps 720p H.264 file, playback fell from 25.1 fps to 4.1
   * with ~1 rate change a second. Now the rate leaves 1 only when drift is
   * past 0.12s, at one fixed ±5% (≈2.4s to pull 0.12s back), and returns to 1
   * once drift is under 0.03s or has crossed over — two changes per
   * correction instead of a stream of them.
   * @param {{videoTime: number, target: number, wantPlaying: boolean, duration: number, rate?: number, seekPast?: number}} q
   *   `rate` is the video's current playbackRate.
   * @returns {{action: 'pause'|'seek'|'steer', rate: number}}
   */
  function localSync({ videoTime, target, wantPlaying, duration, rate = 1, seekPast = 0.35 }) {
    const inRange = target >= 0 && (!(duration > 0) || target < duration - 0.1);
    if (!wantPlaying || !inRange) return { action: 'pause', rate: 1 };
    const drift = target - videoTime;
    if (Math.abs(drift) > seekPast) return { action: 'seek', rate: 1 };
    if (rate !== 1) {
      const crossed = (rate > 1) !== (drift > 0);
      return { action: 'steer', rate: crossed || Math.abs(drift) < 0.03 ? 1 : rate };
    }
    if (Math.abs(drift) > 0.12) return { action: 'steer', rate: drift > 0 ? 1.05 : 0.95 };
    return { action: 'steer', rate: 1 };
  }

  /** The MIME type a blob of this file should carry. */
  function videoMime(path) {
    const ext = String(path || '').split('.').pop().toLowerCase();
    return { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' }[ext] || 'video/mp4';
  }

  window.MusicVideo = { parseVideoId, initialOffset, syncAction, localSync, videoMime };
  if (typeof document === 'undefined' || !document.getElementById('mv-layer')) return;

  /* ------------------------------------------------------------ elements */

  const layer = document.getElementById('mv-layer');
  const frameBox = document.getElementById('mv-frame-box');
  const tint = document.getElementById('mv-tint');
  const panel = document.getElementById('mv-panel');
  const $ = (id) => document.getElementById(id);
  const ui = {
    toggle: $('mv-toggle'), close: $('mv-close'), now: $('mv-now'), link: $('mv-link'),
    use: $('mv-use'), find: $('mv-find'), status: $('mv-status'), earlier: $('mv-earlier'),
    later: $('mv-later'), offset: $('mv-offset'), auto: $('mv-auto'), grade: $('mv-grade'),
    mix: $('mv-mix'), openBtn: $('btn-video'),
    download: $('mv-download'), file: $('mv-file'), source: $('mv-source'), fx: $('mv-fx'),
    switchSrc: $('mv-switch'),
  };

  /* --------------------------------------------------------------- state */

  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  let on = read('musicVideo', '0') === '1';
  let grade = read('musicVideoGrade', 'neon');
  let mix = read('musicVideoMix', 'soft');
  let saved = {};
  try { saved = JSON.parse(read('musicVideos', '{}')) || {}; } catch { saved = {}; }

  let trackKey = '';
  let videoId = null;
  let offset = 0;
  let iframe = null;
  let ready = false;
  let info = { time: 0, at: 0, state: -1, duration: 0 };
  let lastSeekAt = 0;
  let searchedFor = '';
  let videoEl = null;       // the local <video>, when playing a file
  let videoUrl = '';        // its blob URL, revoked on teardown
  let localPath = null;     // the file it is playing
  let linkedFile = null;    // a file the user linked to this song (beats a download)
  /* Which source plays when a song has both a file and a YouTube video.
     The file wins by default (exact sync, shaders on the footage); the
     panel's switch flips it either way, remembered per song as `yt`. */
  let preferYoutube = false;
  let localAvail = null;    // the playable file this song has, even while YouTube plays
  let tools = { ytdlp: false };
  let downloading = '';     // video id being downloaded
  let loadSeq = 0;          // guards async loads against a newer one
  /* A seek lands late: decoding at the new spot takes a few hundred ms, by
     which time the song has moved on (measured: 0.31s behind after a jump in
     Chrome). Aim ahead by what the last seeks actually lost. */
  let seekLead = 0.15;

  const hasVideo = () => Boolean(videoId || linkedFile);

  /* Per-section styling while the Director runs. `ramp` is how long the
     grade takes to arrive: a build tightens over its whole length, the rest
     switch under the veil. */
  const SECTION_LOOK = {
    intro: { grade: 'dream', mix: 'off', punch: 0.3, ramp: 0.3, fx: 'none' },
    outro: { grade: 'dream', mix: 'soft', punch: 0.3, ramp: 0.3, fx: 'mirror' },
    break: { grade: 'none', mix: 'off', punch: 0.35, ramp: 0.3, fx: 'edges' },
    verse: { grade: 'song', mix: 'soft', punch: 0.5, ramp: 0.3, fx: 'none' },
    build: { grade: 'neon', mix: 'soft', punch: 0.75, ramp: 8, fx: 'split' },
    drop: { grade: 'neon', mix: 'full', punch: 1, ramp: 0.15, fx: 'kaleido' },
  };
  let directedLook = null;
  let directedAt = 0;

  /* Effects on the footage itself (video-fx.js) — local video only. 'auto'
     takes the Director's per-section effect, and none without it. */
  let fxPick = read('musicVideoFx', 'auto');
  let fxCanvas = null;
  let fx = null;
  let fxBroken = false;
  const liveFx = () => {
    if (!localPath || fxBroken || !window.VideoFX) return 'none';
    if (fxPick === 'auto') return directedLook ? directedLook.fx : 'none';
    return window.VideoFX.MODES.includes(fxPick) ? fxPick : 'none';
  };

  const GRADES = {
    none: '',
    neon: 'saturate(1.7) contrast(1.15) brightness(1.05)',
    noir: 'grayscale(1) contrast(1.35) brightness(0.9)',
    dream: 'blur(2px) saturate(1.35) brightness(0.85)',
    vhs: 'sepia(0.35) saturate(1.5) hue-rotate(-12deg) contrast(1.12) blur(0.6px)',
    song: 'saturate(0.6) contrast(1.1)',
  };

  function remember() {
    if (!trackKey) return;
    if (videoId || linkedFile) {
      saved[trackKey] = { id: videoId, offset, ...(linkedFile ? { file: linkedFile } : {}), ...(preferYoutube ? { yt: true } : {}) };
    }
    else delete saved[trackKey];
    write('musicVideos', JSON.stringify(saved));
  }

  function say(text) { if (ui.status) ui.status.textContent = text; }
  function showOffset() { if (ui.offset) ui.offset.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s`; }

  const liveGrade = () => (directedLook ? directedLook.grade : grade);
  const liveMix = () => (directedLook ? directedLook.mix : mix);

  function applyLook() {
    document.body.classList.toggle('mv-on', on && hasVideo());
    for (const m of ['full', 'soft', 'off']) document.body.classList.toggle(`mv-mix-${m}`, liveMix() === m);
    frameBox.style.transition = `filter ${directedLook ? directedLook.ramp : 0.3}s ease-in`;
    frameBox.style.filter = GRADES[liveGrade()] || '';
    tint.hidden = liveGrade() !== 'song';
    if (ui.grade) ui.grade.value = grade;
    if (ui.fx) {
      ui.fx.value = fxPick;
      ui.fx.disabled = !localPath;
      ui.fx.title = localPath
        ? 'Effects on the footage itself; Auto lets the 🎬 Director pick one per section'
        : 'Needs a downloaded or linked video — YouTube\'s player cannot be read';
    }
    if (ui.mix) ui.mix.value = mix;
    if (ui.toggle) {
      ui.toggle.setAttribute('aria-pressed', String(on));
      ui.toggle.textContent = on ? 'On' : 'Off';
    }
    if (ui.openBtn) ui.openBtn.setAttribute('aria-pressed', String(on && hasVideo()));
    layer.hidden = !(on && hasVideo());
    showSource();
  }

  function showSource() {
    if (ui.source) {
      ui.source.textContent = localPath
        ? (linkedFile ? '📁 Your file' : '💾 Downloaded copy')
        : videoId ? '▶ YouTube' : '';
    }
    if (ui.switchSrc) {
      const can = Boolean(videoId && localAvail);
      ui.switchSrc.hidden = !can;
      ui.switchSrc.textContent = localPath
        ? '▶ Switch to YouTube'
        : linkedFile ? '📁 Switch to your file' : '💾 Switch to downloaded copy';
    }
    if (ui.download) {
      const can = tools.ytdlp && videoId && !localPath && !downloading;
      ui.download.disabled = !can;
      ui.download.hidden = Boolean(localPath);
      ui.download.title = tools.ytdlp
        ? 'Save this video to disk with your yt-dlp and play it from there — exact sync, works offline, and the shaders can use the footage'
        : 'Needs yt-dlp on your system (pacman -S yt-dlp · pip install yt-dlp · winget install yt-dlp) — the app does not ship a downloader';
      ui.download.textContent = downloading ? '⬇ Downloading…' : '⬇ Download';
    }
  }

  /* -------------------------------------------------------------- player */

  const RELAY_ORIGIN = 'https://lyricoverlay.dhruvchoudhary.com';
  const RELAY = `${RELAY_ORIGIN}/embed/youtube.html`;

  function post(func, args = []) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), RELAY_ORIGIN);
  }

  function teardown() {
    frameBox.textContent = '';
    iframe = null;
    if (videoEl) { videoEl.removeAttribute('src'); videoEl.load(); videoEl = null; }
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = ''; }
    if (fxCanvas) fxCanvas.hidden = true;
    localPath = null;
    ready = false;
    info = { time: 0, at: 0, state: -1, duration: 0 };
  }

  /** Show this song's video: its linked file, else a downloaded copy of its
      YouTube video, else the YouTube player. */
  async function load(id, file) {
    const seq = ++loadSeq;
    videoId = id || null;
    linkedFile = file || null;
    teardown();
    localAvail = null;
    if (!hasVideo() || !on) { applyLook(); return; }
    // The file to play: a linked one (or the app's regular-MP4 copy of it —
    // see playable_video), else a downloaded copy of the YouTube video.
    let res = null;
    if (linkedFile && window.player && window.player.playableVideo) res = await window.player.playableVideo(linkedFile);
    else if (linkedFile) res = { path: linkedFile };
    else if (videoId && window.player && window.player.localVideoFor) res = await window.player.localVideoFor(videoId);
    if (seq !== loadSeq) return;
    const path = res && res.path;
    if (res && res.warning) say(res.warning.charAt(0).toUpperCase() + res.warning.slice(1));
    localAvail = path || null;
    if (path && !(preferYoutube && videoId) && await loadLocal(path, seq)) return;
    if (seq !== loadSeq) return;
    if (videoId) loadEmbed(videoId);
    else applyLook();
  }

  /** Play a file from disk. False if it could not be read. */
  async function loadLocal(path, seq) {
    let raw = null;
    try { raw = await window.player.readLocalFile(path); } catch { raw = null; }
    if (seq !== loadSeq) return true; // superseded; nothing more to do here
    if (!raw || !raw.byteLength) {
      say(linkedFile === path ? 'That video file is missing or empty — link it again' : 'The downloaded copy is missing — using YouTube');
      return false;
    }
    teardown();
    localPath = path;
    videoUrl = URL.createObjectURL(new Blob([raw], { type: videoMime(path) }));
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.addEventListener('loadedmetadata', () => {
      ready = true;
      info.duration = v.duration || 0;
      if (trackKey && !(saved[trackKey] && typeof saved[trackKey].offset === 'number')) {
        offset = initialOffset(info.duration, (typeof durationMs === 'number' ? durationMs : 0) / 1000);
        showOffset();
        remember();
      }
    });
    v.addEventListener('seeked', () => {
      const missed = estimatePosition() / 1000 + offset - v.currentTime;
      if (Number.isFinite(missed)) seekLead = Math.max(0, Math.min(0.8, seekLead + missed * 0.6));
    });
    /* A file the player cannot stream (a fragmented MP4 with no ffmpeg to
       fix it, on WebKitGTK) does not error: it plays a few seconds and then
       reports `ended` mid-song. Treat that as the failure it is, once, and
       fall back to YouTube rather than seeking back into it forever. */
    v.addEventListener('ended', () => {
      if (seq !== loadSeq || !(v.duration > 0)) return;
      const target = estimatePosition() / 1000 + offset;
      if (target >= v.duration - 1) return; // the real end
      say('This video file stops early here (a fragmented MP4?) — install ffmpeg and the app will fix it; using YouTube for now');
      if (videoId) { preferYoutube = true; teardown(); loadEmbed(videoId); }
    });
    v.addEventListener('error', () => {
      if (seq !== loadSeq) return;
      say('This video file will not play here (its codec may be unsupported) — try an MP4 (H.264)');
      if (videoId && !linkedFile) { teardown(); loadEmbed(videoId); }
    });
    v.src = videoUrl;
    videoEl = v;
    frameBox.appendChild(v);
    applyLook();
    return true;
  }

  function loadEmbed(id) {
    iframe = document.createElement('iframe');
    iframe.title = 'Music video';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.tabIndex = -1;
    // The player's own parameters are set by the relay page.
    iframe.src = `${RELAY}?v=${encodeURIComponent(id)}`;
    iframe.addEventListener('load', () => {
      // Ask the player to report its state; it answers with onReady and a
      // stream of infoDelivery messages carrying currentTime.
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), RELAY_ORIGIN);
    });
    frameBox.appendChild(iframe);
    applyLook();
  }

  window.addEventListener('message', (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    let msg;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'onReady') { ready = true; post('mute'); }
    if ((msg.event === 'infoDelivery' || msg.event === 'initialDelivery') && msg.info) {
      ready = true;
      if (typeof msg.info.currentTime === 'number') { info.time = msg.info.currentTime; info.at = performance.now(); }
      if (typeof msg.info.playerState === 'number') info.state = msg.info.playerState;
      if (typeof msg.info.duration === 'number' && msg.info.duration > 0 && !info.duration) {
        info.duration = msg.info.duration;
        // First time we know the video's length: guess the offset, unless
        // this song already has one.
        if (trackKey && !(saved[trackKey] && typeof saved[trackKey].offset === 'number')) {
          offset = initialOffset(info.duration, (typeof durationMs === 'number' ? durationMs : 0) / 1000);
          showOffset();
          remember();
        }
      }
    }
    if (msg.event === 'onError') say('YouTube would not play this video here (the uploader may block embedding) — try another link');
  });

  function tickLocal() {
    const v = videoEl;
    // A seek still landing reports its target as currentTime; deciding on
    // that would stack a second seek on a slow decoder.
    if (!on || !v || !ready || v.seeking) return;
    const r = localSync({
      videoTime: v.currentTime,
      target: estimatePosition() / 1000 + offset,
      wantPlaying: playbackStatus === 'Playing',
      duration: v.duration,
      rate: v.playbackRate,
    });
    if (r.action === 'pause') { if (!v.paused) v.pause(); if (v.playbackRate !== 1) v.playbackRate = 1; return; }
    if (r.action === 'seek') v.currentTime = Math.max(0, estimatePosition() / 1000 + offset + seekLead);
    if (v.playbackRate !== r.rate) v.playbackRate = r.rate;
    if (v.paused) v.play().catch(() => {});
  }
  setInterval(tickLocal, 100);

  function tick() {
    if (!on || !videoId || !iframe || !ready) return;
    const now = performance.now();
    const playing = info.state === 1;
    const videoTime = info.time + (playing && info.at ? (now - info.at) / 1000 : 0);
    const target = estimatePosition() / 1000 + offset;
    const act = syncAction({
      videoTime, target, playing,
      wantPlaying: playbackStatus === 'Playing',
      sinceSeekMs: now - lastSeekAt, duration: info.duration,
    });
    if (act === 'seek') { post('seekTo', [Math.max(0, target), true]); lastSeekAt = now; post('playVideo'); }
    else if (act === 'play') post('playVideo');
    else if (act === 'pause') post('pauseVideo');
  }
  setInterval(tick, 300);

  function drawFx(now) {
    const mode = liveFx();
    if (mode === 'none' || !videoEl || layer.hidden) { if (fxCanvas) fxCanvas.hidden = true; return; }
    if (!fxCanvas) {
      fxCanvas = document.createElement('canvas');
      fxCanvas.className = 'mv-fx';
      fx = window.VideoFX.create(fxCanvas);
      if (!fx) { fxBroken = true; fxCanvas = null; applyLook(); return; }
    }
    if (fxCanvas.parentNode !== frameBox) frameBox.appendChild(fxCanvas);
    const kick = audioEnv && audioEnv.active ? audioEnv.kick : Math.min(1, (beatFlash || 0) * 0.5);
    const drawn = fx.render(videoEl, {
      mode, time: now / 1000, kick,
      bass: audioEnv && audioEnv.active ? audioEnv.bass || 0 : kick * 0.6,
      drop: typeof dropFlash === 'number' ? Math.min(1, dropFlash) : 0,
      // A build's effect tightens over the build, like its grade does.
      amount: directedLook && directedLook === SECTION_LOOK.build ? Math.min(1, (now - directedAt) / 8000) : 0.5,
      hue: typeof bgHue === 'number' ? bgHue : 0,
    });
    fxCanvas.hidden = !drawn;
  }

  /* The kick punch, like the other engines get. */
  function punch(now) {
    if (window.VideoFX) drawFx(now || performance.now());
    if (on && hasVideo() && !layer.hidden && typeof applyKickPunch === 'function') {
      const k = audioEnv && audioEnv.active ? audioEnv.kick : Math.min(1, (beatFlash || 0) * 0.5);
      const gain = directedLook ? directedLook.punch : 0.6;
      applyKickPunch(layer, k * (reducedMotion ? Math.min(0.3, gain) : gain));
      if (liveGrade() === 'song') tint.style.background = `hsl(${Math.round(bgHue)} 85% 50%)`;
    }
    requestAnimationFrame(punch);
  }
  requestAnimationFrame(punch);

  /* ------------------------------------------------- following the song */

  window.addEventListener('director-scene', (e) => {
    const kind = e.detail && e.detail.kind;
    directedLook = kind ? SECTION_LOOK[kind] || SECTION_LOOK.verse : null;
    directedAt = performance.now();
    applyLook();
  });

  function trackChanged() {
    const key = currentTrack ? trackLookKey(currentTrack) : '';
    if (key === trackKey) return;
    trackKey = key;
    const s = saved[key];
    offset = s && typeof s.offset === 'number' ? s.offset : 0;
    preferYoutube = Boolean(s && s.yt);
    showOffset();
    if (ui.now) ui.now.textContent = currentTrack ? `${currentTrack.artist || ''} — ${currentTrack.title || ''}` : 'Nothing playing';
    if (s && (s.id || s.file)) { load(s.id, s.file); say('Remembered for this song'); return; }
    load(null, null);
    say('No video for this song yet — paste a link, or Find');
    if (on && key && searchedFor !== key) autoFind();
  }
  setInterval(trackChanged, 1000);

  async function autoFind(manual) {
    if (!currentTrack || !window.player || !window.player.findMusicVideo) return;
    searchedFor = trackKey;
    say('Searching YouTube…');
    const keyAtStart = trackKey;
    const res = await window.player.findMusicVideo(currentTrack.artist || '', currentTrack.title || '', typeof durationMs === 'number' ? Math.round(durationMs) : 0);
    if (keyAtStart !== trackKey) return; // the song changed while we searched
    // A link pasted while the search was out wins: never replace the user's choice.
    if (hasVideo() && !manual) return;
    if (res && res.status === 'ok' && res.id) {
      offset = 0;
      load(res.id, null);
      remember();
      say(`Found: ${res.title} · ${res.channel}`);
    } else if (manual || (res && res.status === 'none')) {
      say((res && res.message) || 'Nothing found — paste the link');
    } else {
      say((res && res.message) || 'Search unavailable — paste the link');
    }
  }

  /* ------------------------------------------------------------- the UI */

  function setOn(v) {
    on = Boolean(v);
    write('musicVideo', on ? '1' : '0');
    if (on && hasVideo() && !iframe && !videoEl) load(videoId, linkedFile);
    if (!on) { loadSeq += 1; teardown(); }
    applyLook();
    if (on && !hasVideo() && trackKey && searchedFor !== trackKey) autoFind();
    setStatus(on ? 'Music video on' : 'Music video off');
  }

  function nudge(by) {
    offset = Math.round((offset + by) * 100) / 100;
    showOffset();
    remember();
    lastSeekAt = 0; // re-seek now, so the nudge is visible at once
  }

  function open() {
    if (typeof closeRailPanels === 'function') closeRailPanels(panel);
    panel.hidden = false;
    document.body.classList.add('show-cursor');
    trackChanged();
    applyLook();
    showOffset();
  }
  function close() { panel.hidden = true; }

  if (ui.openBtn) ui.openBtn.addEventListener('click', () => (panel.hidden ? open() : close()));
  if (ui.close) ui.close.addEventListener('click', close);
  if (ui.toggle) ui.toggle.addEventListener('click', () => setOn(!on));
  if (ui.use) ui.use.addEventListener('click', () => {
    const id = parseVideoId(ui.link.value);
    if (!id) { say('That is not a YouTube link'); return; }
    searchedFor = trackKey; // a pasted link is the answer; do not search over it
    if (!on) setOn(true);
    offset = 0;
    load(id, null);
    remember();
    ui.link.value = '';
    say('Saved for this song');
  });
  if (ui.link) ui.link.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.use.click(); });
  if (ui.find) ui.find.addEventListener('click', () => { if (!on) setOn(true); autoFind(true); });
  if (ui.earlier) ui.earlier.addEventListener('click', () => nudge(-0.25));
  if (ui.later) ui.later.addEventListener('click', () => nudge(0.25));
  if (ui.auto) ui.auto.addEventListener('click', () => {
    offset = initialOffset(info.duration, (typeof durationMs === 'number' ? durationMs : 0) / 1000);
    showOffset(); remember(); lastSeekAt = 0;
  });
  if (ui.grade) ui.grade.addEventListener('change', () => { grade = ui.grade.value in GRADES ? ui.grade.value : 'none'; write('musicVideoGrade', grade); applyLook(); });
  if (ui.fx) ui.fx.addEventListener('change', () => {
    fxPick = ui.fx.value === 'auto' || (window.VideoFX && window.VideoFX.MODES.includes(ui.fx.value)) ? ui.fx.value : 'auto';
    write('musicVideoFx', fxPick);
    applyLook();
  });
  if (ui.mix) ui.mix.addEventListener('change', () => { mix = ['full', 'soft', 'off'].includes(ui.mix.value) ? ui.mix.value : 'soft'; write('musicVideoMix', mix); applyLook(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { close(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!on || !hasVideo()) return;
    if (e.key === '[') nudge(-0.25);
    else if (e.key === ']') nudge(0.25);
  });

  /* Local video: download with the user's yt-dlp, or link a file. */
  if (ui.download) ui.download.addEventListener('click', async () => {
    if (!videoId || downloading) return;
    downloading = videoId;
    showSource();
    say('Starting the download…');
    const res = await window.player.downloadMusicVideo(videoId);
    if (res && res.status === 'done' && res.path) { downloading = ''; preferYoutube = false; remember(); load(videoId, linkedFile); say('Already downloaded — playing from disk'); return; }
    if (!res || res.status === 'error') { downloading = ''; showSource(); say((res && res.message) || 'Download failed'); }
  });
  if (window.player && window.player.onVideoDownload) window.player.onVideoDownload((d) => {
    if (!d || !d.id) return;
    if (d.status === 'progress') {
      downloading = d.id;
      if (d.id === videoId) say(`Downloading… ${Math.round(d.percent || 0)}%`);
    } else {
      if (downloading === d.id) downloading = '';
      if (d.id === videoId) {
        if (d.status === 'done') { preferYoutube = false; remember(); load(videoId, linkedFile); say('Downloaded — now playing from disk'); }
        else if (d.status === 'error') say(`Download failed: ${d.message || 'unknown error'}`);
        else if (d.status === 'cancelled') say('Download cancelled');
      }
    }
    showSource();
  });
  if (ui.switchSrc) ui.switchSrc.addEventListener('click', () => {
    if (!videoId || !localAvail) return;
    preferYoutube = Boolean(localPath);
    remember();
    load(videoId, linkedFile);
    say(preferYoutube ? 'Playing YouTube for this song — switch back any time' : 'Playing from disk for this song');
  });
  if (ui.file) ui.file.addEventListener('click', async () => {
    if (!trackKey) { say('Play a song first, then link its video'); return; }
    const res = await window.player.pickVideoFile();
    if (!res || !res.path) return;
    searchedFor = trackKey;
    if (!on) setOn(true);
    offset = 0;
    preferYoutube = false;
    await load(videoId, res.path);
    remember();
    say('Linked this file to the song');
  });
  if (window.player && window.player.videoTools) {
    window.player.videoTools().then((t) => { tools = t || tools; showSource(); }).catch(() => {});
  }

  /** The playing local video, for engines that sample its pixels; null when
      the video is YouTube's frame (unreadable) or not ready. */
  function frameSource() {
    return on && videoEl && ready && videoEl.readyState >= 2 && !layer.hidden ? videoEl : null;
  }

  /* Settings → YouTube API key (youtube.rs reads it from the key store). */
  const keyInput = $('keybox-youtube');
  const keySave = $('keybox-youtube-save');
  const keyStatus = $('keybox-youtube-status');
  async function saveKey() {
    const value = keyInput.value.trim();
    keyStatus.textContent = 'saving…';
    try {
      const res = await window.player.setApiKey('YOUTUBE_API_KEY', value);
      if (res && res.status === 'ok') {
        keyInput.value = '';
        keyStatus.textContent = value ? 'saved — ▶ Video will find videos by itself' : 'cleared';
        searchedFor = ''; // let the current song try again with the new key
      } else {
        keyStatus.textContent = (res && res.message) || 'save failed';
      }
    } catch (err) {
      keyStatus.textContent = (err && err.message) || 'save failed';
    }
  }
  if (keySave && keyInput) {
    keySave.addEventListener('click', saveKey);
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
  }

  applyLook();
  Object.assign(window.MusicVideo, { open, close, isOn: () => on && hasVideo(), setOn, frameSource, isLocal: () => Boolean(localPath) });
})();
