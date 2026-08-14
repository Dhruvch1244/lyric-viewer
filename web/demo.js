'use strict';

/*
  Lyric Overlay — browser demo.

  Runs the same Butterchurn (MilkDrop) engine the desktop app ships. The stage
  is alive from the start, driven by a silent synthetic-audio bed; drop in a
  file and real audio takes over. Synced lyrics come from LRCLIB (by artist /
  title) or an uploaded .lrc. A browser can't tap system audio the way the
  Windows app does — that's the point of the app.

  LRCLIB sends permissive CORS headers, so the fetch runs straight from the
  browser. If that changes, point LYRICS_BASE at the Cloudflare Worker proxy.
*/

const LYRICS_BASE = 'https://lrclib.net';

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const bcp = window.butterchurnPresets && (window.butterchurnPresets.default || window.butterchurnPresets);

const $ = (id) => document.getElementById(id);
const canvas = $('viz');
const audioEl = new Audio();
audioEl.crossOrigin = 'anonymous';

let ctx = null, viz = null, bed = null, mediaSource = null;
let presets = {}, presetNames = [], running = false;
let lyrics = [];

// ---------- visualizer (ambient from load) --------------------------------

function initVisualizer() {
  if (viz || !bc || !bcp || !canvas) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Silent synthetic bed so the stage moves before a track is loaded. Routed
    // only into the visualizer, never to the speakers.
    bed = ctx.createGain(); bed.gain.value = 0.9;
    [55, 110, 220, 330].forEach((f, k) => {
      const o = ctx.createOscillator(); o.type = k % 2 ? 'sawtooth' : 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.12;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15 + k * 0.11;
      const lg = ctx.createGain(); lg.gain.value = 0.1;
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(bed); o.start(); lfo.start();
    });

    viz = bc.createVisualizer(ctx, canvas, {
      width: canvas.clientWidth, height: canvas.clientHeight,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    });
    viz.connectAudio(bed);
    resize();

    presets = (bcp.getPresets && bcp.getPresets()) || {};
    presetNames = Object.keys(presets);
    loadPreset(0);
    setInterval(() => loadPreset(2.8), 20000); // rotate the vibe

    running = true;
    requestAnimationFrame(renderLoop);
  } catch (e) {
    if (canvas) canvas.style.display = 'none';
  }
}

function prettyPreset(name) {
  return String(name).replace(/^[\d\s_-]+/, '').replace(/\.milk$/i, '').trim();
}

function loadPreset(blend, index) {
  if (!presetNames.length || !viz) return;
  const i = (typeof index === 'number') ? index : Math.floor(Math.random() * presetNames.length);
  const name = presetNames[i];
  try {
    viz.loadPreset(presets[name], blend);
    const el = $('presetName');
    if (el) el.textContent = '◆ ' + prettyPreset(name);
  } catch (e) { /* skip a bad preset */ }
}

function resize() {
  const r = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.round(canvas.clientWidth * r), h = Math.round(canvas.clientHeight * r);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; if (viz) viz.setRendererSize(w, h); }
}

function renderLoop() {
  if (!running) return;
  resize();
  try { viz.render(); } catch (e) { /* keep looping */ }
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
    mediaSource = ctx.createMediaElementSource(audioEl);
    mediaSource.connect(ctx.destination);   // hear it
    if (bed) { try { bed.disconnect(); } catch (e) {} } // stop the silent bed
    viz.connectAudio(mediaSource);           // see it
  }

  if (ctx.state === 'suspended') ctx.resume();
  audioEl.play().catch(() => {});

  $('hint').style.display = 'none';
  $('playBtn').disabled = false;
  const status = $('audioStatus');
  status.className = 'status';
  status.textContent = file.name;

  // Now-playing chip + lyric fields from "Artist - Title.mp3".
  const base = file.name.replace(/\.[^.]+$/, '');
  const dash = base.split(/\s[-–]\s/);
  let who = base;
  if (dash.length === 2) {
    if (!$('artist').value) $('artist').value = dash[0].trim();
    if (!$('title').value) $('title').value = dash[1].trim();
    who = dash[1].trim() + ' — ' + dash[0].trim();
  } else if (!$('title').value) {
    $('title').value = base.trim();
  }
  $('npText').textContent = who;
}

audioEl.addEventListener('play', () => { $('playBtn').textContent = '❚❚ Pause'; });
audioEl.addEventListener('pause', () => { $('playBtn').textContent = '▶ Play'; });

$('playBtn').addEventListener('click', () => {
  if (ctx && ctx.state === 'suspended') ctx.resume();
  if (audioEl.paused) audioEl.play(); else audioEl.pause();
});
$('presetBtn').addEventListener('click', () => { initVisualizer(); loadPreset(2.8); });

const drop = $('drop'), fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadAudioFile(fileInput.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadAudioFile(f); });

// ---------- lyrics --------------------------------------------------------

function parseLRC(text) {
  const out = [], tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of text.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps = []; let m;
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

function setLyrics(list, msg, isErr) {
  lyrics = list;
  const st = $('lyricStatus');
  st.className = isErr ? 'status err' : 'status';
  st.textContent = msg;
}

async function fetchLyrics() {
  const artist = $('artist').value.trim(), title = $('title').value.trim();
  if (!title) { setLyrics([], 'Enter at least a song title.', true); return; }
  const st = $('lyricStatus'); st.className = 'status'; st.textContent = 'Searching LRCLIB…';
  const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));
  try {
    const res = await fetch(`${LYRICS_BASE}/api/search?q=${q}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    const hit = Array.isArray(hits) ? hits.find((h) => h.syncedLyrics) : null;
    if (!hit) { setLyrics([], 'No synced lyrics for that search. Try exact artist + title, or upload a .lrc.', true); return; }
    setLyrics(parseLRC(hit.syncedLyrics), `Loaded “${hit.trackName}” — ${hit.artistName}. Play to sync.`, false);
  } catch (err) {
    setLyrics([], `Lookup failed (${err.message}). You can still upload a .lrc file.`, true);
  }
}

$('lyricBtn').addEventListener('click', fetchLyrics);
[$('artist'), $('title')].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchLyrics(); }));

const lrcInput = $('lrcInput');
$('lrcBtn').addEventListener('click', () => lrcInput.click());
lrcInput.addEventListener('change', () => {
  const f = lrcInput.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => setLyrics(parseLRC(String(reader.result)), 'Loaded from file. Play to sync.', false);
  reader.readAsText(f);
});

let lastIdx = -1;
function updateLyricLine() {
  if (!lyrics.length) return;
  const t = audioEl.currentTime + 0.15;
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) { if (lyrics[i].t <= t) idx = i; else break; }
  if (idx === lastIdx) return;
  lastIdx = idx;
  $('lyricNow').textContent = idx >= 0 ? lyrics[idx].text : '';
  $('lyricNext').textContent = idx + 1 < lyrics.length ? lyrics[idx + 1].text : '';
}

// Start the engine now; resume audio on the first gesture (autoplay policy).
initVisualizer();
window.addEventListener('pointerdown', function once() {
  if (ctx && ctx.state === 'suspended') ctx.resume();
  window.removeEventListener('pointerdown', once);
}, { once: true });
