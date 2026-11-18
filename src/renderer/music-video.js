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

  WHY AN OFFSET. A music video is rarely the album track: there is an intro,
  a skit, a longer outro. The first guess is that the extra length is an
  intro (most common), capped at 30s; after that, `[` and `]` (or the panel's
  buttons) nudge it by a quarter second and the value is remembered for the
  song along with the video, so it only ever needs fixing once.

  THE LOOK. A colour grade on the video (CSS filters — the player is a
  cross-origin frame, so its pixels cannot be read or shaded, only filtered
  and composited), the app's visuals screen-blended on top at full, soft or
  no strength, and the video punched in on every kick like the other engines.

  FINDING THE VIDEO. With a YouTube Data API key (Settings), the first play of
  a song asks youtube.rs, which ranks the search results for the official
  video. Without one, paste the link once. Both are remembered per song.

  Runs after renderer.js and shares its globals (currentTrack,
  estimatePosition, playbackStatus, trackLookKey, durationMs, audioEnv,
  beatFlash, bgHue, applyKickPunch, closeRailPanels, setStatus).

  Exposed on window.MusicVideo: { parseVideoId, initialOffset, syncAction,
  open, close, isOn }.
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

  window.MusicVideo = { parseVideoId, initialOffset, syncAction };
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
    if (videoId) saved[trackKey] = { id: videoId, offset };
    else delete saved[trackKey];
    write('musicVideos', JSON.stringify(saved));
  }

  function say(text) { if (ui.status) ui.status.textContent = text; }
  function showOffset() { if (ui.offset) ui.offset.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s`; }

  function applyLook() {
    document.body.classList.toggle('mv-on', on && Boolean(videoId));
    for (const m of ['full', 'soft', 'off']) document.body.classList.toggle(`mv-mix-${m}`, mix === m);
    frameBox.style.filter = GRADES[grade] || '';
    tint.hidden = grade !== 'song';
    if (ui.grade) ui.grade.value = grade;
    if (ui.mix) ui.mix.value = mix;
    if (ui.toggle) {
      ui.toggle.setAttribute('aria-pressed', String(on));
      ui.toggle.textContent = on ? 'On' : 'Off';
    }
    if (ui.openBtn) ui.openBtn.setAttribute('aria-pressed', String(on && Boolean(videoId)));
    layer.hidden = !(on && videoId);
  }

  /* -------------------------------------------------------------- player */

  function post(func, args = []) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube-nocookie.com');
  }

  function load(id) {
    videoId = id;
    ready = false;
    info = { time: 0, at: 0, state: -1, duration: 0 };
    frameBox.textContent = '';
    iframe = null;
    if (!id || !on) { applyLook(); return; }
    iframe = document.createElement('iframe');
    iframe.title = 'Music video';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.tabIndex = -1;
    const params = new URLSearchParams({
      enablejsapi: '1', autoplay: '1', mute: '1', controls: '0', disablekb: '1', fs: '0',
      iv_load_policy: '3', modestbranding: '1', playsinline: '1', rel: '0', origin: location.origin,
    });
    iframe.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
    iframe.addEventListener('load', () => {
      // Ask the player to report its state; it answers with onReady and a
      // stream of infoDelivery messages carrying currentTime.
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube-nocookie.com');
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

  /* The kick punch, like the other engines get. */
  function punch() {
    if (on && videoId && !layer.hidden && typeof applyKickPunch === 'function') {
      const k = audioEnv && audioEnv.active ? audioEnv.kick : Math.min(1, (beatFlash || 0) * 0.5);
      applyKickPunch(layer, k * (reducedMotion ? 0.3 : 0.6));
      if (grade === 'song') tint.style.background = `hsl(${Math.round(bgHue)} 85% 50%)`;
    }
    requestAnimationFrame(punch);
  }
  requestAnimationFrame(punch);

  /* ------------------------------------------------- following the song */

  function trackChanged() {
    const key = currentTrack ? trackLookKey(currentTrack) : '';
    if (key === trackKey) return;
    trackKey = key;
    const s = saved[key];
    offset = s && typeof s.offset === 'number' ? s.offset : 0;
    showOffset();
    if (ui.now) ui.now.textContent = currentTrack ? `${currentTrack.artist || ''} — ${currentTrack.title || ''}` : 'Nothing playing';
    if (s && s.id) { load(s.id); say('Remembered for this song'); return; }
    load(null);
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
    if (videoId && !manual) return;
    if (res && res.status === 'ok' && res.id) {
      offset = 0;
      load(res.id);
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
    if (on && videoId && !iframe) load(videoId);
    if (!on) { frameBox.textContent = ''; iframe = null; ready = false; }
    applyLook();
    if (on && !videoId && trackKey && searchedFor !== trackKey) autoFind();
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
    load(id);
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
  if (ui.mix) ui.mix.addEventListener('change', () => { mix = ['full', 'soft', 'off'].includes(ui.mix.value) ? ui.mix.value : 'soft'; write('musicVideoMix', mix); applyLook(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { close(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!on || !videoId) return;
    if (e.key === '[') nudge(-0.25);
    else if (e.key === ']') nudge(0.25);
  });

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
  Object.assign(window.MusicVideo, { open, close, isOn: () => on && Boolean(videoId), setOn });
})();
