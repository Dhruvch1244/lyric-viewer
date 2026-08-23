#!/usr/bin/env node
/*
  Growing MILKDROP_CURATED (milkdrop-panel.js) beyond its original 10 entries,
  without reintroducing the regression its own comment warns about: cycling
  the raw 1754-preset catalogue was tried once already and rejected, because a
  large share of it is dim, broken on this renderer, or blank. So this script
  vets before adding rather than dumping the corpus in wholesale.

  HOW IT VETS, AND WHY THIS METHOD. milkdrop-frame.js already has a preview
  renderer built for the browser panel's cards: `thumbnail(name)` loads a
  preset, drives it for ~1s (34 frames) with a synthetic waveform, and returns
  a 192x108 JPEG data URL — or nothing, if the preset throws while compiling.
  That is reused as-is here rather than reimplemented, both because it is
  already proven against this exact renderer and because writing a second
  preview path risks silently vetting against different behaviour than what a
  user's shuffle actually loads.

  For each preset the survey decodes that JPEG back to pixels (in-page, via a
  hidden <canvas>) and scores it on:
    - meanLuminance   catches near-black (broken/blank) and blown-white frames
    - textureScore    mean absolute luminance gradient between adjacent
                       pixels — catches a flat/solid-colour render that isn't
                       black but also isn't drawing anything, which luminance
                       alone would miss
    - a thrown/timed-out thumbnail is a hard reject (preset does not compile)

  This is a proxy for "looks broken", not a judge of "looks good" — see the
  curate step below, which samples the survivors rather than trusting one
  ranking, and the manual spot-check the accompanying report describes.

  USAGE
    node scripts/perf/curate-milkdrop-presets.mjs survey   # ~1754 presets, writes runs/milkdrop-survey.json
    node scripts/perf/curate-milkdrop-presets.mjs curate    # reads that file, prints a curated shortlist

  Re-run `survey` whenever `npm run vendor-presets` changes the corpus; it is
  the slow, resumable step (~15-20 min). `curate` is instant and safe to
  re-run repeatedly while tuning the thresholds below.
*/

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { launchApp, REPO_ROOT } from './launch.mjs';
import { attachToApp } from './cdp.mjs';

const execFileAsync = promisify(execFile);

/*
  Rotate the port per batch rather than reusing one. `launch.mjs`'s `stop()`
  taskkills the `tauri dev` supervisor's PID tree, but `tauri dev` is exactly
  that — a supervisor — and startup.mjs's own README documents the same trap:
  once cargo exits, the real `lyric-overlay.exe` it launched is no longer a
  descendant of the killed PID, so it can survive `stop()` as an orphan still
  holding its DevTools port. Confirmed live here too (a `.perf`-identifier
  `lyric-overlay.exe` outlived the first smoke-test's teardown). A new port
  per batch means the next launch can never silently attach to that orphan
  instead of its own fresh process; `killOrphan` below is the belt-and-braces
  cleanup on top.
*/
// 9222/9223/9224/9226 are known to collide with other perf/verification runs
// on this machine (confirmed live: batch 2 picked 9226 and silently never got
// a listener because something else already held it). Starting well clear of
// the range this project's other scripts default to.
let portCounter = 9310;
async function nextPort() {
  for (let tries = 0; tries < 20; tries += 1) {
    const port = portCounter++;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) continue; // something's already listening — skip it
    } catch {
      return port; // nothing answered — free
    }
  }
  throw new Error('could not find a free DevTools port after 20 tries');
}

/** Walk the process tree from the launcher PID to find the real app exe, the
 *  same way startup.mjs does, and kill it directly — `stop()` alone can miss
 *  it once cargo has exited and the exe is no longer its descendant. */
async function killOrphan(rootPid) {
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const all = JSON.parse(stdout);
    const children = new Map();
    for (const p of all) {
      if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
      children.get(p.ParentProcessId).push(p);
    }
    const byPid = new Map(all.map((p) => [p.ProcessId, p]));
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
      const pid = queue.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (byPid.get(pid)?.Name && /^lyric-overlay\.exe$/i.test(byPid.get(pid).Name)) {
        spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
        return;
      }
      for (const child of children.get(pid) || []) queue.push(child.ProcessId);
    }
  } catch {
    // Best-effort cleanup; the next batch's fresh port makes this non-fatal either way.
  }
}
const RUN_DIR = join(REPO_ROOT, 'scripts', 'perf', 'runs');
const SURVEY_PATH = join(RUN_DIR, 'milkdrop-survey.json');
const INDEX_PATH = join(REPO_ROOT, 'src', 'renderer', 'vendor', 'presets', 'index.json');

const PER_PRESET_TIMEOUT_MS = 4500; // shorter than thumbnail()'s own 6000ms internal timeout
const SAVE_EVERY = 50;

/** In-page: decode a thumbnail data URL to pixel stats. Runs inside the app. */
const SCORE_EXPRESSION = (name) => `
  return (async () => {
    if (!window.MilkDrop || !window.MilkDrop.isSupported()) return { ok: false, reason: 'engine-not-ready' };
    const withTimeout = (p, ms) => new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }).catch(() => { clearTimeout(t); resolve(null); });
    });
    const url = await withTimeout(window.MilkDrop.thumbnail(${JSON.stringify(name)}), ${PER_PRESET_TIMEOUT_MS});
    if (!url) return { ok: false, reason: 'no-thumbnail' };

    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error('image decode failed'));
    });
    img.src = url;
    try { await loaded; } catch (e) { return { ok: false, reason: 'decode-error' }; }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 192;
    canvas.height = img.naturalHeight || 108;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let sum = 0, sumSq = 0, nearBlack = 0, nearWhite = 0, n = 0;
    const lum = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      lum[p] = l;
      sum += l; sumSq += l * l; n += 1;
      if (l < 18) nearBlack += 1;
      if (l > 245) nearWhite += 1;
    }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const std = Math.sqrt(variance);

    let texSum = 0, texN = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 1; x < width; x += 1) {
        texSum += Math.abs(lum[y * width + x] - lum[y * width + x - 1]);
        texN += 1;
      }
    }
    const textureScore = texSum / texN;

    return {
      ok: true,
      meanLuminance: +mean.toFixed(2),
      stdLuminance: +std.toFixed(2),
      nearBlackFrac: +(nearBlack / n).toFixed(3),
      nearWhiteFrac: +(nearWhite / n).toFixed(3),
      textureScore: +textureScore.toFixed(3),
    };
  })();
`;

function loadIndex() {
  const idx = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  return idx.presets.map((p) => p.name);
}

function loadSurveyIfPresent() {
  if (!existsSync(SURVEY_PATH)) return { results: {}, startedAt: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(SURVEY_PATH, 'utf8'));
  } catch {
    return { results: {}, startedAt: new Date().toISOString() };
  }
}

function saveSurvey(survey) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(SURVEY_PATH, JSON.stringify(survey, null, 0));
}

/*
  Every step here is wrapped rather than fired once: a page reload (see the
  BATCH_SIZE comment above scoreOne — this genuinely happens mid-survey) can
  land the app between navigation and renderer.js finishing its top-level
  `let` declarations, and evaluating against that window throws a plain
  ReferenceError, not a "not ready yet" signal. Swallowing and retrying is the
  only way to ride out that window instead of the whole run dying on it —
  confirmed necessary live, not a defensive guess: the un-wrapped version
  killed the process outright the first time a reload landed here.
*/
async function waitForMilkdropEngine(session, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await session.evaluate(`
        if (typeof presetId === 'undefined') return false;
        presetId = 'milkdrop';
        playbackStatus = 'Playing';
        if (typeof currentTrack === 'undefined' || !currentTrack) currentTrack = { title: 'curate', artist: 'curate' };
        anchorPositionMs = 0;
        anchorAt = performance.now();
        return typeof activeEngine === 'string' && activeEngine === 'milkdrop' && window.MilkDrop && window.MilkDrop.isSupported();
      `);
      if (ready) return true;
    } catch {
      // Mid-reload — the page's top-level lets aren't all live yet. Just retry.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/*
  A preset can crash the GPU process outright (Butterchurn compiles arbitrary
  strangers'-shader-equations to real shaders — a malformed one is not
  hypothetical here), which surfaces as the page reloading mid-scan:
  `Runtime.evaluate` throws "Execution context was destroyed", and every call
  after that reports `engine-not-ready` forever because the reload reset
  `presetId` and nothing re-armed it. Measured live during this script's own
  smoke test (`$$$ Royal - Mashup (253)` onward, first attempt) — this is not
  a defensive-programming guess, it is what actually happened on preset #8.

  So the survey runs in small batches with a fresh app process per batch
  (bounds any slow GPU-resource leak from hundreds of loadPreset calls in one
  session too), and re-arms the engine between individual presets whenever it
  finds it not ready — cheap when nothing is wrong, and the only way to
  survive a crash without losing the rest of the run.
*/
const BATCH_SIZE = 250;

/** One preset, with up to one re-arm-and-retry if the engine dropped out from under it. */
async function scoreOne(session, name) {
  let result;
  try {
    result = await session.evaluate(SCORE_EXPRESSION(name), { awaitPromise: true });
  } catch (err) {
    result = { ok: false, reason: `threw: ${err.message}` };
  }
  if (result.ok || (result.reason !== 'engine-not-ready' && !result.reason?.startsWith('threw:'))) {
    return result;
  }
  // Engine dropped (reload, or never came up after a prior crash) — re-arm once and retry this preset.
  const recovered = await waitForMilkdropEngine(session, 15_000);
  if (!recovered) return result; // give up on this one; caller may still recover for the next
  try {
    return await session.evaluate(SCORE_EXPRESSION(name), { awaitPromise: true });
  } catch (err) {
    return { ok: false, reason: `threw after re-arm: ${err.message}` };
  }
}

/** Run one batch against a fresh app process. Returns false if the app never came up at all. */
async function runBatch(batchNames, state) {
  const port = await nextPort();
  const profileDir = join(RUN_DIR, 'curate-profile');
  const { child, stop } = launchApp({ port, build: 'dev', profileDir, verbose: false });
  try {
    const { session } = await attachToApp(port, 360_000); // cold cargo compile, possibly behind another build's lock
    const engineUp = await waitForMilkdropEngine(session);
    if (!engineUp) return false;

    let done = 0;
    for (const name of batchNames) {
      state.results[name] = await scoreOne(session, name);
      done += 1;
      if (done % SAVE_EVERY === 0) {
        saveSurvey(state);
        console.log(`  ${done}/${batchNames.length} this batch — ${Object.keys(state.results).length} total scored`);
      }
    }
    saveSurvey(state);
    return true;
  } finally {
    stop();
    await killOrphan(child.pid);
    await new Promise((r) => setTimeout(r, 1500)); // let the port and any child processes actually release
  }
}

async function survey() {
  const names = loadIndex();
  const state = loadSurveyIfPresent();
  let pending = names.filter((n) => !(n in state.results));
  if (process.env.CURATE_LIMIT) pending = pending.slice(0, Number(process.env.CURATE_LIMIT));
  console.log(`${names.length} presets total, ${pending.length} not yet surveyed.`);
  if (pending.length === 0) {
    console.log('Nothing to do — delete runs/milkdrop-survey.json to re-survey from scratch.');
    return;
  }

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${i / BATCH_SIZE + 1}: ${batch.length} presets (fresh app process)…`);
    const ok = await runBatch(batch, state);
    if (!ok) {
      // The app itself never came up for this batch (not a per-preset issue) — one retry, then give up on the run.
      console.warn('  batch app never came up; retrying this batch once…');
      const retried = await runBatch(batch, state);
      if (!retried) {
        console.error(`  batch still failed to launch — stopping with ${Object.keys(state.results).length}/${names.length} scored. Re-run to resume.`);
        process.exit(1);
      }
    }
  }
  console.log(`\nSurvey complete: ${Object.keys(state.results).length}/${names.length} presets scored.`);
  process.exit(0);
}

/*
  Reject thresholds. Deliberately loose — this is a "does it look broken"
  filter, not a taste filter. meanLuminance keeps near-black and blown-white
  renders out; textureScore catches a flat/solid-colour render that
  meanLuminance alone would wave through (a mid-grey dead frame is exactly
  the kind of "broken" the original curated-10 comment was about).
*/
const REJECT = {
  minLuminance: 12,
  maxLuminance: 248,
  maxNearBlackFrac: 0.55,
  minTexture: 1.4,
};

function curate() {
  if (!existsSync(SURVEY_PATH)) {
    console.error('No survey found. Run `node scripts/perf/curate-milkdrop-presets.mjs survey` first.');
    process.exit(1);
  }
  const { results } = JSON.parse(readFileSync(SURVEY_PATH, 'utf8'));
  const entries = Object.entries(results);
  const failed = entries.filter(([, r]) => !r.ok);
  const survivors = entries
    .filter(([, r]) => r.ok)
    .filter(([, r]) =>
      r.meanLuminance >= REJECT.minLuminance &&
      r.meanLuminance <= REJECT.maxLuminance &&
      r.nearBlackFrac <= REJECT.maxNearBlackFrac &&
      r.textureScore >= REJECT.minTexture
    );

  // Composite score: texture (detail/movement) weighted above raw contrast,
  // since a preset can have high std from a single hard edge while still
  // being mostly flat. Not trying to rank "prettiest" — just "most alive".
  const scored = survivors
    .map(([name, r]) => ({ name, r, score: r.textureScore * 1.5 + r.stdLuminance * 0.5 }))
    .sort((a, b) => a.score - b.score);

  console.log(`${entries.length} surveyed, ${failed.length} failed (no thumbnail/threw), ${survivors.length} passed the broken/blank filter.`);

  // Stratified sample across the upper 65% of the survivor score range, not
  // just top-N by one heuristic — avoids overfitting to whatever textureScore
  // happens to reward (e.g. pure noise scores high on texture and would
  // dominate a naive top-N).
  const TARGET = 150;
  const cut = Math.floor(scored.length * 0.35); // drop the bottom third (still "not broken" but low-detail)
  const pool = scored.slice(cut);
  const step = Math.max(1, Math.floor(pool.length / TARGET));
  const picked = [];
  for (let i = pool.length - 1; i >= 0 && picked.length < TARGET; i -= step) picked.push(pool[i]);

  console.log(`Stratified sample: ${picked.length} presets from a pool of ${pool.length} (score range ${pool[0]?.score.toFixed(2)}..${pool[pool.length - 1]?.score.toFixed(2)}).`);
  saveSurvey.__unused = failed; // no-op, keeps failed reachable if inspecting interactively

  const outPath = join(RUN_DIR, 'milkdrop-curated-candidates.json');
  writeFileSync(outPath, JSON.stringify(picked.map((p) => p.name), null, 2));
  console.log(`Candidate list written to ${outPath}`);

  console.log('\nA few rejects, for spot-checking:');
  entries
    .filter(([, r]) => r.ok && (r.meanLuminance < REJECT.minLuminance || r.textureScore < REJECT.minTexture))
    .slice(0, 5)
    .forEach(([name, r]) => console.log(`  ${name} — lum=${r.meanLuminance} tex=${r.textureScore}`));
}

const mode = process.argv[2];
if (mode === 'survey') await survey();
else if (mode === 'curate') curate();
else {
  console.error('usage: node scripts/perf/curate-milkdrop-presets.mjs <survey|curate>');
  process.exit(1);
}
