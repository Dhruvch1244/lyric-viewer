/*
  Launching the real app with a DevTools port open, and doing it without
  touching the user's own installation.

  Two facts drive everything in this file, both measured rather than assumed:

  1. **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` does not work for this app.**
     wry (0.55.1, `src/webview2/mod.rs:294`) calls
     `set_additional_browser_arguments` unconditionally — with
     `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` when the
     Tauri config specifies none — and that API overrides the environment
     variable. Verified by launching a release build with the variable set and
     getting no listener on the port. So the flag has to come from the Tauri
     config, which is read at compile time.

  2. **The config override is generated, never committed.** A checked-in
     `tauri.perf.conf.json` would have to restate the whole `app.windows`
     array, because Tauri merges configs as an RFC 7386 merge-patch and arrays
     are replaced wholesale rather than merged. That duplicate would drift
     silently the first time a window property changed. Instead this file reads
     `tauri.conf.json` and hands the modified copy to `--config` as inline
     JSON, so there is exactly one window definition in the repo.

  Isolation matters as much as the port: a perf run sets a display mode, flips
  Lite, and writes `perfDebug` to localStorage. Doing that to the user's real
  install would leave their app visibly changed and look like a bug. So a perf
  build gets its own bundle identifier (its own app-data directory) and its own
  WebView2 user-data folder.
*/

import { spawn, execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/*
  The Tauri CLI's JavaScript entry point, run directly with `process.execPath`
  rather than through `npx`. Two reasons, both load-bearing on Windows: Node 20
  and later refuse to spawn a `.cmd` shim without `shell: true`
  (EINVAL — the CVE-2024-27980 fix), and running through a shell would then
  mangle the inline JSON passed to `--config`, since cmd.exe strips the quotes.
  Invoking the .js file keeps `shell: false` and passes argv through untouched.
*/
const TAURI_CLI = join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

/*
  wry's defaults, restated because setting `additionalBrowserArgs` REPLACES
  them rather than appending — the Tauri schema says so explicitly ("you also
  need to disable these components by yourself"). Dropping them would change
  what is being measured: msWebOOUI and msPdfOOUI are out-of-process UI
  features whose absence is part of the app's normal runtime.
*/
const WRY_DEFAULT_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection';

/** Identifier suffix that gives a perf build its own app-data directory. */
const PERF_IDENTIFIER_SUFFIX = '.perf';

/**
 * Build the Tauri config override that opens the DevTools port.
 *
 * @param {number} port
 * @returns {string} Inline JSON for `tauri --config`.
 */
export function perfConfigJson(port) {
  const base = JSON.parse(readFileSync(join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const windows = structuredClone(base.app.windows).map((w) => ({
    ...w,
    additionalBrowserArgs: `${WRY_DEFAULT_ARGS} --remote-debugging-port=${port}`,
  }));
  return JSON.stringify({
    identifier: `${base.identifier}${PERF_IDENTIFIER_SUFFIX}`,
    app: { windows },
    // The vendored Whisper/Demucs runtimes are already in src/renderer/vendor
    // and are not what is being measured; re-running the copy on every perf
    // build costs minutes and changes nothing.
    build: { beforeBuildCommand: '' },
  });
}

/**
 * Environment for a perf process: its own WebView2 profile, and a marker the
 * app itself could read if it ever needed to know.
 *
 * @param {string} profileDir
 * @returns {Record<string,string>}
 */
function perfEnv(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  return {
    ...process.env,
    // Read by the WebView2 loader itself, not by wry — unlike the browser
    // arguments above, this one is genuinely honoured.
    WEBVIEW2_USER_DATA_FOLDER: profileDir,
    LYRIC_OVERLAY_PERF: '1',
  };
}

/**
 * Every live process descended from `rootPid`, including it.
 *
 * @param {number} rootPid
 * @returns {Promise<Array<{ProcessId: number, ParentProcessId: number, Name: string}>>}
 */
async function processTree(rootPid) {
  if (process.platform !== 'win32') return [];
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

/** @param {number} pid @returns {Promise<boolean>} */
async function isAlive(pid) {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return stdout.toLowerCase().includes(String(pid));
  } catch {
    return false;
  }
}

/** Best-effort kill; a PID that's already gone is not an error. @param {number} pid */
async function killPid(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    // Already gone.
  }
}

/**
 * Launch the app with the DevTools port open.
 *
 * @param {object} opts
 * @param {number} opts.port DevTools port.
 * @param {'dev'|'release'} opts.build Which build to measure.
 * @param {string} opts.profileDir WebView2 user-data folder for this run.
 * @param {boolean} [opts.verbose] Stream the child's output.
 * @returns {{child: import('node:child_process').ChildProcess, stop: () => Promise<void>}}
 */
export function launchApp({ port, build, profileDir, verbose = false }) {
  const env = perfEnv(profileDir);
  let child;

  if (build === 'dev') {
    child = spawn(
      process.execPath,
      [TAURI_CLI, 'dev', '--no-watch', '--config', perfConfigJson(port)],
      { cwd: REPO_ROOT, env, stdio: verbose ? 'inherit' : 'ignore', shell: false }
    );
  } else {
    const exe = releaseBinaryPath();
    child = spawn(exe, [], { cwd: REPO_ROOT, env, stdio: verbose ? 'inherit' : 'ignore' });
  }

  /*
    `tauri dev` is a supervisor chain — node runs the CLI, which runs cargo,
    which runs the app — and by the time teardown runs, cargo has often
    already exited, so `lyric-overlay.exe` is no longer taskkill /T's
    descendant and survives as an orphan still holding the DevTools port
    (confirmed live: an orphaned `.perf`-identifier instance outlived a
    run's teardown). The fix is resolving the real app PID while the chain
    is still intact, not at teardown time — so this polls from the moment
    the process is spawned, not when stop() is eventually called. A release
    build has no supervisor at all: child.pid IS the app.
  */
  let appPid = build === 'release' ? child.pid : null;
  if (build === 'dev' && process.platform === 'win32') {
    (async () => {
      const deadline = Date.now() + 6 * 60_000; // cold cargo compiles can take minutes
      while (appPid === null && Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return; // supervisor died before the app ever came up
        try {
          const tree = await processTree(child.pid);
          const found = tree.find((p) => /^lyric-overlay\.exe$/i.test(p.Name));
          if (found) appPid = found.ProcessId;
        } catch {
          // Transient — the process table query can race process exit; try again.
        }
        if (appPid === null) await new Promise((r) => setTimeout(r, 500));
      }
    })();
  }

  /*
    Teardown has to actually finish, not just fire taskkill and move on —
    the next run's assertPortFree check races whatever is still tearing
    down. Kills both the supervisor tree and (if resolved) the app PID
    directly, then polls until the OS confirms both are gone rather than
    trusting taskkill's own exit code.
  */
  const stop = async () => {
    if (process.platform !== 'win32') {
      child.kill('SIGTERM');
      return;
    }
    const targets = [child.pid, ...(appPid && appPid !== child.pid ? [appPid] : [])];
    await Promise.all(targets.map(killPid));

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const alive = await Promise.all(targets.map(isAlive));
      if (!alive.some(Boolean)) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.warn(`launch.mjs: stop() could not confirm PID(s) ${targets.join(', ')} exited — a stale instance may still hold port ${port}.`);
  };

  return { child, stop };
}

/**
 * Where a perf release build lands.
 *
 * Deliberately NOT `src-tauri/target/release` — that binary has a DevTools
 * port open and a different bundle identifier, and must never be mistaken for
 * something shippable. Its own `CARGO_TARGET_DIR` makes that impossible rather
 * than merely unlikely.
 *
 * @returns {string}
 */
export function releaseBinaryPath() {
  return join(REPO_ROOT, 'src-tauri', 'target', 'perf', 'release', 'lyric-overlay.exe');
}

/**
 * Build the instrumented release binary. Only needed for `--build release`;
 * the numbers that depend on Rust (startup time, process memory) are
 * meaningless from a debug build.
 *
 * @param {number} port
 * @returns {Promise<void>}
 */
export function buildRelease(port) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [TAURI_CLI, 'build', '--no-bundle', '--config', perfConfigJson(port)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CARGO_TARGET_DIR: join(REPO_ROOT, 'src-tauri', 'target', 'perf') },
        stdio: 'inherit',
      }
    );
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tauri build exited ${code}`))));
    child.on('error', reject);
  });
}
