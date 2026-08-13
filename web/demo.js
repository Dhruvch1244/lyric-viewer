'use strict';

/*
  Lyric Overlay — browser demo.

  Reuses the same Butterchurn (MilkDrop) engine the desktop app ships. Audio
  comes from a file the visitor drops in (a browser can't tap system audio the
  way the Windows app does). Synced lyrics come from LRCLIB, either fetched by
  artist/title or from an uploaded .lrc file.

  LRCLIB sends permissive CORS headers, so the fetch runs straight from the
  browser. If that ever changes, point LYRICS_BASE at the Cloudflare Worker
  proxy (see web/worker/) instead.
*/

const LYRICS_BASE = 'https://lrclib.net'; // or a Cloudflare Worker proxy URL

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const bcPresets = window.butterchurnPresets && (window.butterchurnPresets.default || window.butterchurnPresets);

const $ = (id) => document.getElementById(id);
const canvas = $('viz');
const audioEl = new Audio();
audioEl.crossOrigin = 'anonymous';

let audioCtx = null;
let visualizer = null;
let mediaSource = null;
let presets = {};
let presetNames = [];
let running = false;
let lyrics = []; // [{ t: seconds, text }]

// ---------- visualizer ----------------------------------------------------

function initVisualizer() {
  if (visualizer) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Keep audio "connected" with a silent node until a real track loads, so
  // render() always has an analyser to read.
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  silent.connect(audioCtx.destination);

  visualizer = bc.createVisualizer(audioCtx, canvas, {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });
  visualizer.connectAudio(silent);

  presets = (bcPresets && bcPresets.getPresets) ? bcPresets.getPresets() : {};
  presetNames = Object.keys(presets);
  if (presetNames.length) loadRandomPreset(0);

  resize();
  running = true;
  requestAnimationFrame(renderLoop);
}

function loadRandomPreset(blend = 2.7) {
  if (!presetNames.length) return;
  const name = presetNames[Math.floor(Math.random() * presetNames.length)];
  try { visualizer.loadPreset(presets[name], blend); } catch (e) { /* skip bad preset */ }
}

function resize() {
  const r = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * r);
  const h = Math.round(canvas.clientHeight * r);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    if (visualizer) visualizer.setRendererSize(w, h);
  }
}

function renderLoop() {
  if (!running) return;
  resize();
  try { visualizer.render(); } catch (e) { /* keep looping */ }
  updateLyricLine();
  requestAnimationFrame(renderLoop);
}

window.addEventListener('resize', resize);

// ---------- audio ---------------------------------------------------------

function loadAudioFile(file) {
  if (!file) return;
  initVisualizer();
  audioEl.src = URL.createObjectURL(file);

  if (!mediaSource) {
    mediaSource = audioCtx.createMediaElementSource(audioEl);
    mediaSource.connect(audioCtx.destination); // hear it
    visualizer.connectAudio(mediaSource);      // see it
  }

  audioCtx.resume();
  audioEl.play().catch(() => {});
  $('hint').style.display = 'none';
  $('playBtn').disabled = false;
  $('presetBtn').disabled = false;
  $('audioStatus').className = 'status';
  $('audioStatus').textContent = file.name;

  // Prefill lyric fields from the filename ("Artist - Title.mp3").
  const base = file.name.replace(/\.[^.]+$/, '');
  const dash = base.split(/\s[-–]\s/);
  if (dash.length === 2) {
    if (!$('artist').value) $('artist').value = dash[0].trim();
    if (!$('title').value) $('title').value = dash[1].trim();
  } else if (!$('title').value) {
    $('title').value = base.trim();
  }
}

audioEl.addEventListener('play', () => { $('playBtn').textContent = '❚❚ Pause'; });
audioEl.addEventListener('pause', () => { $('playBtn').textContent = '▶ Play'; });

$('playBtn').addEventListener('click', () => {
  if (audioCtx) audioCtx.resume();
  if (audioEl.paused) audioEl.play(); else audioEl.pause();
});
$('presetBtn').addEventListener('click', () => loadRandomPreset(2.7));

// file drop + picker
const drop = $('drop');
const fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadAudioFile(fileInput.files[0]));
['dragover', 'dragenter'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadAudioFile(f);
});

// ---------- lyrics --------------------------------------------------------

function parseLRC(text) {
  const out = [];
  const tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of text.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = tag.exec(line))) {
      const cs = m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0;
      stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + cs);
    }
    const words = line.replace(tag, '').trim();
    if (!stamps.length) continue;
    for (const t of stamps) out.push({ t, text: words });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function setLyrics(list, msg) {
  lyrics = list;
  const st = $('lyricStatus');
  if (!list.length) {
    st.className = 'status err';
    st.textContent = msg || 'No synced lyrics found. Try exact artist + title, or upload a .lrc.';
  } else {
    st.className = 'status';
    st.textContent = msg || `Loaded ${list.length} lines. Play the track to sync.`;
  }
}

async function fetchLyrics() {
  const artist = $('artist').value.trim();
  const title = $('title').value.trim();
  if (!title) { setLyrics([], 'Enter at least a song title.'); return; }

  const st = $('lyricStatus');
  st.className = 'status';
  st.textContent = 'Searching LRCLIB…';

  const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));
  try {
    const res = await fetch(`${LYRICS_BASE}/api/search?q=${q}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    const hit = Array.isArray(hits) ? hits.find((h) => h.syncedLyrics) : null;
    if (!hit) { setLyrics([], 'No synced lyrics for that search. Upload a .lrc instead.'); return; }
    setLyrics(parseLRC(hit.syncedLyrics), `“${hit.trackName}” — ${hit.artistName}. Play to sync.`);
  } catch (err) {
    setLyrics([], `Lookup failed (${err.message}). You can still upload a .lrc file.`);
  }
}

$('lyricBtn').addEventListener('click', fetchLyrics);
[$('artist'), $('title')].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchLyrics(); }));

const lrcInput = $('lrcInput');
$('lrcBtn').addEventListener('click', () => lrcInput.click());
lrcInput.addEventListener('change', () => {
  const f = lrcInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => setLyrics(parseLRC(String(reader.result)), 'Loaded from file. Play to sync.');
  reader.readAsText(f);
});

// sync the displayed line to playback
let lastIdx = -1;
function updateLyricLine() {
  if (!lyrics.length) return;
  const t = audioEl.currentTime + 0.15; // small lead so lines land on the beat
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].t <= t) idx = i; else break;
  }
  if (idx === lastIdx) return;
  lastIdx = idx;
  $('lyricNow').textContent = idx >= 0 ? lyrics[idx].text : '';
  $('lyricNext').textContent = idx + 1 < lyrics.length ? lyrics[idx + 1].text : '';
}

// Start the engine on first interaction (autoplay policy needs a gesture).
window.addEventListener('pointerdown', function once() {
  initVisualizer();
  window.removeEventListener('pointerdown', once);
}, { once: true });
