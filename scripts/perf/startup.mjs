#!/usr/bin/env node
/*
  The startup-burst measurement (docs/PERF-UX.md P3).

  Purely observational — unlike harness.mjs there is no baseline, no
  pass/fail, no assertion. `frameIntervalMs` is "recorded, never asserted"
  even in the steady-state harness (see README.md); a from-launch series is
  the same kind of number, just over a much longer, much noisier window.

  Why this is a separate script rather than a harness.mjs scenario:

  - **No PERF_DEBUG reload.** harness.mjs reloads the page once to turn on
    per-section `perfCost` (renderer.js reads that flag once at load). This
    script only reads `frameIntervalMs`/`drawCostMs`, which update
    unconditionally (renderer.js's EMA sites are not gated on the flag), and
    a reload would destroy the exact from-launch window being measured.
  - **No synthetic audio driver.** scenarios.mjs's DRIVER_SOURCE replaces
    window.AudioReactive specifically so the harness never needs a real,
    gitignored track. The startup burst is caused BY the subsystem that
    driver bypasses — real decode, offline beatmap/heatmap analysis, lyric
    and artwork fetch — so measuring it needs a real track playing through
    the real app. This script doesn't play anything itself (the app is a
    passive SMTC observer); it just samples while you play one yourself.

  Usage:
    npm run perf:startup                       # 120s, sampled every 200ms
    npm run perf:startup -- --duration 60
    npm run perf:startup -- --interval 500 --verbose
    npm run perf:startup -- --track "C:\path\to\song.mp3"   # auto-plays a real file

  `--track` closes the gap the two bullets above describe as deliberate: it
  drives the same `window.LocalPlayer.enqueue()` the library panel's card
  click uses (renderer.js's `libraryCard`), fired right after CDP attach, so
  the burst is captured against the exact subsystem load a real play causes —
  decode, offline analysis, lyric/artwork fetch — without a human sitting
  there starting playback by hand. Omit it and the manual workflow described
  below is unchanged.
*/

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname, resolve as resolvePath } from 'node:path';
import { cpus, platform, release } from 'node:os';

import { launchApp, REPO_ROOT } from './launch.mjs';
import { attachToApp } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = { port: 9222, build: 'dev', durationMs: 120_000, intervalMs: 200, verbose: false };

function parseArgs(argv) {
  const args = { ...DEFAULTS, out: null, track: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--duration') args.durationMs = Number(argv[++i]) * 1000;
    else if (a === '--interval') args.intervalMs = Number(argv[++i]);
    else if (a === '--build') args.build = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--track') args.track = argv[++i];
    else if (a === '--verbose') args.verbose = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['dev', 'release'].includes(args.build)) throw new Error(`--build must be dev or release, got ${args.build}`);
  return args;
}

/**
 * "Artist - Title.mp3" -> {artist, title}, the same convention the library's
 * folder-import path already assumes elsewhere in this app. Falls back to the
 * bare filename as the title when there's no ` - ` to split on, rather than
 * guessing wrong.
 * @param {string} filePath
 * @returns {{artist: string, title: string}}
 */
function parseTrackMeta(filePath) {
  const stem = basename(filePath, extname(filePath));
  const sep = stem.indexOf(' - ');
  if (sep === -1) return { artist: '', title: stem };
  return { artist: stem.slice(0, sep).trim(), title: stem.slice(sep + 3).trim() };
}

/** Same reasoning as harness.mjs's assertPortFree: attaching to a leftover
 *  instance from an earlier run silently measures the wrong process. */
async function assertPortFree(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      throw new Error(
        `something is already serving DevTools on port ${port} — most likely a leftover app from an earlier run.\n` +
          'Close it (or pass --port) before measuring.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already serving DevTools')) throw err;
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Bucket the series into ~10 windows and print median fps-equivalent per
 *  bucket — the same shape as PERF-UX.md's historical
 *  116→20→19→...→240 fps sequence, so a dip is visible without opening the
 *  JSON. */
function printSummary(samples, durationMs) {
  if (!samples.length) {
    console.log('No samples collected.');
    return;
  }
  const bucketCount = 10;
  const span = Math.max(durationMs, samples[samples.length - 1].elapsedMs);
  const bucketMs = span / bucketCount;
  console.log('\nfps-equivalent by time bucket (median frameIntervalMs → 1000/x):\n');
  for (let i = 0; i < bucketCount; i += 1) {
    const lo = i * bucketMs;
    const hi = (i + 1) * bucketMs;
    const inBucket = samples.filter((s) => s.elapsedMs >= lo && s.elapsedMs < hi).map((s) => s.frameIntervalMs);
    const m = median(inBucket);
    const label = `${(lo / 1000).toFixed(0)}-${(hi / 1000).toFixed(0)}s`;
    const reading = inBucket.length ? (m > 0 ? `${Math.round(1000 / m)} fps` : 'parked (0ms interval)') : 'no samples';
    console.log(`  ${label.padEnd(10)} ${reading}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = join(REPO_ROOT, 'scripts', 'perf', 'runs');
  const profileDir = join(runDir, 'startup-profile');
  mkdirSync(runDir, { recursive: true });

  await assertPortFree(args.port);

  const launchedAt = Date.now();
  console.log(`Launching ${args.build} build with DevTools on :${args.port}…`);
  const { child, stop } = launchApp({ port: args.port, build: args.build, profileDir, verbose: args.verbose });

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
  });

  let exitCode = 0;
  const samples = [];
  try {
    const { session: cdp } = await attachToApp(args.port, 15 * 60_000);

    let trackMeta = null;
    if (args.track) {
      const localPath = resolvePath(args.track);
      trackMeta = parseTrackMeta(localPath);
      // Fire-and-forget, per cdp.mjs's own warning: enqueue()'s promise
      // resolves only after the file is read over IPC, decoded and playback
      // started, so awaiting it here would block sampling on exactly the
      // burst this script exists to capture.
      await cdp.evaluate(
        `window.LocalPlayer.enqueue([{localPath: ${JSON.stringify(localPath)}, ` +
          `title: ${JSON.stringify(trackMeta.title)}, artist: ${JSON.stringify(trackMeta.artist)}}]);`
      );
      console.log(
        `Recording for ${(args.durationMs / 1000).toFixed(0)}s from process launch (Ctrl-C to stop early and still save).\n` +
          `Auto-started "${trackMeta.artist ? trackMeta.artist + ' - ' : ''}${trackMeta.title}" via LocalPlayer.enqueue right after attach.\n`
      );
    } else {
      console.log(
        `Recording for ${(args.durationMs / 1000).toFixed(0)}s from process launch (Ctrl-C to stop early and still save).\n` +
          'This app only observes SMTC — it does not play anything itself. Start a real track in ' +
          'whatever media app you normally use whenever you want the burst captured; the timestamps ' +
          'below are what let you line the dip up with when playback actually started.\n'
      );
    }

    while (!interrupted && Date.now() - launchedAt < args.durationMs) {
      const tickStart = Date.now();
      try {
        const data = await cdp.evaluate('return { frameIntervalMs, drawCostMs };');
        samples.push({
          elapsedMs: Date.now() - launchedAt,
          frameIntervalMs: typeof data?.frameIntervalMs === 'number' ? +data.frameIntervalMs.toFixed(2) : null,
          drawCostMs: typeof data?.drawCostMs === 'number' ? +data.drawCostMs.toFixed(3) : null,
        });
      } catch (err) {
        console.error(`sample failed, stopping early: ${err.message}`);
        break;
      }
      const spent = Date.now() - tickStart;
      await sleep(Math.max(0, args.intervalMs - spent));
    }

    cdp.close();

    const run = {
      recordedAt: new Date(launchedAt).toISOString(),
      build: args.build,
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, platform: `${platform()} ${release()}` },
      durationMs: args.durationMs,
      intervalMs: args.intervalMs,
      track: trackMeta ? { ...trackMeta, path: resolvePath(args.track) } : null,
      interrupted,
      samples,
    };

    const outPath = args.out || join(runDir, `startup-${run.recordedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(outPath, JSON.stringify(run, null, 2));
    console.log(`Run written to ${outPath}`);
    printSummary(samples, args.durationMs);
  } catch (err) {
    console.error(`\nstartup.mjs failed: ${err.message}`);
    exitCode = 1;
  } finally {
    await stop();
  }

  process.exit(exitCode);
}

main();
