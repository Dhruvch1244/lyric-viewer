#!/usr/bin/env node
/*
  The perf harness: drive the real app, record what it costs.

  Why this exists (docs/PERF-UX.md §P1): every performance claim this project
  has made cost a from-scratch measurement rig that was then thrown away. The
  one that found the 0.16.0 regression lived in a scratchpad directory that was
  never committed and no longer exists. `PERF_BUDGET_MS` warns to the dev
  console after 30 over-budget frames and nothing records it. So perf work here
  has been episodic, and every release's numbers have been unrepeatable.

  What this measures, and what it refuses to:

  - **`drawCostMs` — asserted.** Time spent inside the backdrop draw call.
    Repeatable to ~0.1ms across runs.
  - **Per-section `perfCost` — asserted against `PERF_BUDGET_MS`.** This is
    what "make the budgets assertable" means concretely; until now they were a
    console warning nobody was watching.
  - **`frameIntervalMs` — recorded, never asserted.** Presented frame rate
    varies 3–4x between byte-identical runs on this hardware. Two confident,
    wrong A/B results were nearly reported before that was understood.
  - **Process memory — recorded.** Meaningful only from a release build.

  Usage:
    node scripts/perf/harness.mjs                       # dev build, default scenarios
    node scripts/perf/harness.mjs --build release       # after --build-release
    node scripts/perf/harness.mjs --build-release       # compile the instrumented binary
    node scripts/perf/harness.mjs --baseline            # write baseline.json instead of comparing
    node scripts/perf/harness.mjs --include-wallpaper   # also measure wallpaper mode
*/

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, platform, release } from 'node:os';

import { launchApp, buildRelease, releaseBinaryPath, REPO_ROOT } from './launch.mjs';
import { attachToApp } from './cdp.mjs';
import { DRIVER_SOURCE, SCENARIOS, WALLPAPER_SCENARIO, syntheticCues } from './scenarios.mjs';
import { compareToBaseline, BASELINE_PATH, formatComparison } from './compare.mjs';

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  port: 9222,
  build: 'dev',
  /* Long enough for the adaptive quality governor to settle on a rung and for
     the scripted timeline to have been through a drop. A shorter warm-up
     measures the app deciding what quality to run at, not the quality it
     chose. */
  warmupMs: 6000,
  durationMs: 20_000,
  sampleEveryMs: 200,
  seed: 12345,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, baseline: false, includeWallpaper: false, buildRelease: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--baseline') args.baseline = true;
    else if (a === '--include-wallpaper') args.includeWallpaper = true;
    else if (a === '--build-release') args.buildRelease = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--build') args.build = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--duration') args.durationMs = Number(argv[++i]) * 1000;
    else if (a === '--warmup') args.warmupMs = Number(argv[++i]) * 1000;
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['dev', 'release'].includes(args.build)) throw new Error(`--build must be dev or release, got ${args.build}`);
  return args;
}

/**
 * Percentile of a numeric sample, nearest-rank.
 *
 * @param {number[]} values
 * @param {number} p 0–1
 * @returns {number}
 */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return +sorted[idx].toFixed(3);
}

/**
 * Every process descended from `rootPid`, including it.
 *
 * The tree matters: WebView2 runs a browser process and a renderer as
 * children, and the inference sidecar is its own process again. Anything
 * scoped to `lyric-overlay.exe` by name would both miss most of the app and
 * sweep up a copy the user happens to have open themselves. Descending from
 * our own spawned PID is what keeps this harness's reach to its own children.
 *
 * @param {number} rootPid
 * @returns {Promise<Array<{ProcessId: number, Name: string, PrivatePageCount: number, WorkingSetSize: number}>>}
 */
async function processTree(rootPid) {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,PrivatePageCount,WorkingSetSize,CommandLine | ConvertTo-Json -Compress',
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const all = JSON.parse(stdout);
  const children = new Map();
  for (const p of all) {
    if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
    children.get(p.ParentProcessId).push(p);
  }
  const byPid = new Map(all.map((p) => [p.ProcessId, p]));

  const out = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (byPid.has(pid)) out.push(byPid.get(pid));
    for (const child of children.get(pid) || []) queue.push(child.ProcessId);
  }
  return out;
}

/**
 * Which part of the app a process in the tree actually is.
 *
 * WebView2 is itself a multi-process Chromium: one browser process plus a GPU
 * process, a renderer per frame (the page, and MilkDrop's own CSP-isolated
 * iframe surfaces as another), and utility processes for things like audio.
 * A tree-wide sum treats all of that as one number; this is what lets P4 say
 * *where* memory goes instead of just how much there is. Classified from
 * `--type=` on the command line, the same flag Chromium/Edge itself uses —
 * the browser process is the only WebView2 one without it.
 *
 * @param {{Name?: string, CommandLine?: string}} p
 * @returns {string}
 */
function classifyProcess(p) {
  const name = p.Name || '';
  if (/^lyric-overlay\.exe$/i.test(name)) return 'app (main)';
  if (/^lyric-inference/i.test(name)) return 'sidecar (inference)';
  if (/^msedgewebview2\.exe$/i.test(name)) {
    const m = /--type=([a-z-]+)/i.exec(p.CommandLine || '');
    return m ? `webview2 (${m[1]})` : 'webview2 (browser)';
  }
  return `other (${name || 'unknown'})`;
}

/**
 * Memory across the app's process tree, both as a total and broken out by
 * what each process actually is.
 *
 * @param {number} rootPid
 * @returns {Promise<{privateMb: number, workingSetMb: number, processes: number, byRole: Record<string,{privateMb: number, workingSetMb: number, processes: number}>}|null>}
 */
async function sampleProcessTree(rootPid) {
  try {
    const tree = await processTree(rootPid);
    if (!tree.length) return null;
    const priv = tree.reduce((sum, p) => sum + (Number(p.PrivatePageCount) || 0), 0);
    const ws = tree.reduce((sum, p) => sum + (Number(p.WorkingSetSize) || 0), 0);

    const byRole = {};
    for (const p of tree) {
      const role = classifyProcess(p);
      const bucket = byRole[role] || { privateMb: 0, workingSetMb: 0, processes: 0 };
      bucket.privateMb += Number(p.PrivatePageCount) || 0;
      bucket.workingSetMb += Number(p.WorkingSetSize) || 0;
      bucket.processes += 1;
      byRole[role] = bucket;
    }
    for (const bucket of Object.values(byRole)) {
      bucket.privateMb = +(bucket.privateMb / 1048576).toFixed(1);
      bucket.workingSetMb = +(bucket.workingSetMb / 1048576).toFixed(1);
    }

    return {
      privateMb: +(priv / 1048576).toFixed(1),
      workingSetMb: +(ws / 1048576).toFixed(1),
      processes: tree.length,
      byRole,
    };
  } catch {
    return null; // Memory is a nice-to-have; never fail a run over it.
  }
}

/**
 * Refuse to run when something already holds the DevTools port.
 *
 * Without this the harness attaches to whatever is already there — which in
 * practice meant a leftover instance from a previous run. It produced a full
 * set of numbers, froze partway through as that instance was torn down, and
 * looked like a rendering bug rather than a harness one.
 *
 * @param {number} port
 */
async function assertPortFree(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      throw new Error(
        `something is already serving DevTools on port ${port} — most likely a leftover app from an earlier run.\n` +
          'Close it (or pass --port) before measuring: attaching to it would silently measure the wrong process.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already serving DevTools')) throw err;
    // Anything else means nothing is listening, which is what we want.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one scenario and summarise it.
 *
 * @param {import('./cdp.mjs').CdpSession} cdp
 * @param {object} scenario
 * @param {object} args
 * @param {number} rootPid
 * @returns {Promise<object>}
 */
async function runScenario(cdp, scenario, args, rootPid) {
  process.stdout.write(`  ${scenario.name.padEnd(20)}`);

  /*
    Mode goes through the real backend command, not a class toggle. Compact
    modes genuinely tear both GPU surfaces and the 2D canvas out of the page
    (renderer.js's isCompact path) — faking the class would measure a full-mode
    page wearing a compact stylesheet, which is precisely the wrong number.
  */
  await cdp.evaluate(`window.player.setDisplayMode(${JSON.stringify(scenario.mode)}); return true;`);
  await sleep(1200); // window resize + teardown/rebuild of the surfaces

  const installed = await cdp.evaluate(`
    return window.__perfDriver.install({
      seed: ${args.seed},
      presetId: ${JSON.stringify(scenario.presetId)},
      liteMode: ${scenario.liteMode},
      backdropLevel: ${scenario.backdropLevel},
      spritesEnabled: ${scenario.spritesEnabled},
      cues: ${JSON.stringify(syntheticCues())},
    });
  `);

  await sleep(args.warmupMs);

  const samples = [];
  const deadline = Date.now() + args.durationMs;
  while (Date.now() < deadline) {
    samples.push(await cdp.evaluate('return window.__perfDriver.snapshot();'));
    await sleep(args.sampleEveryMs);
  }
  const memory = await sampleProcessTree(rootPid);
  await cdp.evaluate('window.__perfDriver.uninstall(); return true;');

  const drawCost = samples.map((s) => s.drawCostMs);
  const frameInterval = samples.map((s) => s.frameIntervalMs);
  const sections = {};
  for (const key of Object.keys(samples[0]?.perfCost || {})) {
    const values = samples.map((s) => s.perfCost[key]);
    sections[key] = { p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
  }

  /*
    Did the backdrop actually run? `lastDrawnAt` advances only past
    drawBackdrop's compact early-return, so a value that never moves means the
    loop is parked — and a parked loop's `drawCostMs` is a leftover, not a
    measurement. Distinguishing the two is what stops "cheap" and "not running"
    from looking identical in the output.
  */
  const drawnAt = samples.map((s) => s.lastDrawnAt);
  const backdropDrawing = drawnAt.at(-1) > drawnAt[0];

  const result = {
    name: scenario.name,
    mode: scenario.mode,
    presetId: scenario.presetId,
    liteMode: scenario.liteMode,
    /* Recorded so a scenario that silently failed to select the engine it
       names cannot be mistaken for a passing measurement. */
    activeEngine: samples.at(-1)?.activeEngine ?? null,
    expectEngine: scenario.expectEngine ?? null,
    canRender: samples.every((s) => s.canRender),
    backdropDrawing,
    expectBackdrop: scenario.expectBackdrop ?? true,
    samples: samples.length,
    drawCostMs: { p50: percentile(drawCost, 0.5), p90: percentile(drawCost, 0.9) },
    frameIntervalMs: { p50: percentile(frameInterval, 0.5) },
    sections,
    memory,
    heapMb: samples.at(-1)?.heapMb ?? null,
    ticks: samples.at(-1)?.tick ?? 0,
  };

  process.stdout.write(
    backdropDrawing
      ? `draw p50 ${result.drawCostMs.p50.toFixed(2)}ms  p90 ${result.drawCostMs.p90.toFixed(2)}ms` +
          `  (engine ${result.activeEngine}, ${installed.cues} cues)\n`
      : `backdrop parked — nothing drawn (engine ${result.activeEngine})\n`
  );
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.buildRelease) {
    console.log('Building the instrumented release binary (own CARGO_TARGET_DIR, never bundled)…');
    await buildRelease(args.port);
    console.log(`Built: ${releaseBinaryPath()}`);
    if (process.argv.slice(2).length === 1) return; // --build-release on its own
  }

  if (args.build === 'release' && !existsSync(releaseBinaryPath())) {
    throw new Error(`no instrumented release binary at ${releaseBinaryPath()} — run with --build-release first`);
  }

  const runDir = join(REPO_ROOT, 'scripts', 'perf', 'runs');
  const profileDir = join(runDir, 'webview2-profile');
  mkdirSync(runDir, { recursive: true });

  await assertPortFree(args.port);

  console.log(`Launching ${args.build} build with DevTools on :${args.port}…`);
  const { child, stop } = launchApp({ port: args.port, build: args.build, profileDir, verbose: args.verbose });

  /*
    Teardown has to survive Ctrl-C and an unhandled throw as well as a normal
    finish. An orphaned always-on-top overlay is not just untidy: it keeps the
    DevTools port, so the NEXT run silently attaches to it.
  */
  process.on('SIGINT', async () => {
    await stop();
    process.exit(130);
  });

  let exitCode = 0;
  try {
    let { session: cdp } = await attachToApp(args.port, 15 * 60_000);

    /*
      PERF_DEBUG is read once at load (renderer.js), and without it every
      per-section cost stays at zero — a run that looks clean because nothing
      was measured. Set it, reload, and re-attach to the new page.
    */
    const alreadyOn = await cdp.evaluate('return PERF_DEBUG === true;');
    if (!alreadyOn) {
      await cdp.evaluate("localStorage.setItem('perfDebug','1'); location.reload(); return true;");
      cdp.close();
      await sleep(1500);
      ({ session: cdp } = await attachToApp(args.port, 120_000));
      if (!(await cdp.evaluate('return PERF_DEBUG === true;'))) {
        throw new Error('PERF_DEBUG did not take after a reload — per-section costs would all read zero');
      }
    }

    await cdp.evaluate(DRIVER_SOURCE);

    const scenarios = args.includeWallpaper ? [...SCENARIOS, WALLPAPER_SCENARIO] : SCENARIOS;
    console.log(`Running ${scenarios.length} scenarios, ${args.durationMs / 1000}s each after a ${args.warmupMs / 1000}s warm-up:\n`);

    const results = [];
    for (const scenario of scenarios) results.push(await runScenario(cdp, scenario, args, child.pid));

    // Leave the app in a sane mode rather than whatever the last scenario set.
    await cdp.evaluate("window.player.setDisplayMode('full'); return true;");
    cdp.close();

    const run = {
      recordedAt: new Date().toISOString(),
      build: args.build,
      /*
        A baseline is only meaningful against the machine that produced it —
        draw cost is CPU and GPU bound, and this project's whole doctrine is
        built on numbers from one desk. Recording the machine lets compare.mjs
        say so out loud instead of quietly producing a confident delta between
        two different computers.
      */
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, platform: `${platform()} ${release()}` },
      version: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version,
      seed: args.seed,
      durationMs: args.durationMs,
      warmupMs: args.warmupMs,
      scenarios: results,
    };

    const outPath = join(runDir, `run-${run.recordedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(outPath, JSON.stringify(run, null, 2));
    console.log(`\nRun written to ${outPath}`);

    if (args.baseline) {
      writeFileSync(BASELINE_PATH, JSON.stringify(run, null, 2));
      console.log(`Baseline updated: ${BASELINE_PATH}`);
    } else {
      const comparison = compareToBaseline(run);
      console.log(formatComparison(comparison));
      if (comparison.failures.length) exitCode = 1;
    }
  } catch (err) {
    console.error(`\nHarness failed: ${err.message}`);
    exitCode = 1;
  } finally {
    await stop();
  }

  process.exit(exitCode);
}

main();
