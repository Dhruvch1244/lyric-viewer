#!/usr/bin/env node
/*
  Semi-automated verification for docs/PERF-UX.md P2 — "the render-pause code
  (watchers.rs::start_power_watcher) is structurally smoke-tested over CDP but
  has never actually been driven through the real OS states it claims to
  react to." This script drives the ones that can be scripted; the lock
  screen and unplugging AC cannot be, and are reported as still needing a
  human (see the summary at the end).

  Reuses the perf harness's own launch/attach machinery (launch.mjs, cdp.mjs)
  so this never touches the user's real install: its own bundle identifier,
  its own WebView2 profile, same as `npm run perf`.

  What each state actually is, read from src-tauri/src/watchers.rs and
  wallpaper.rs before writing this:
    - occluded  → IsIconic (minimized) OR DWMWA_CLOAKED (parked on another
                  virtual desktop). Both drive the SAME `overlay-power`
                  reason ("occluded"), so one script covers both triggers.
    - fullscreen → the foreground window's rect exactly covers its monitor's
                  rect, isn't iconic, isn't the desktop/taskbar, isn't us.
    - lock      → OpenInputDesktop fails (winlogon or a UAC prompt owns the
                  input desktop). Scriptable via SendInput, but NOT attempted
                  here — actually locking the screen mid-run would also lock
                  out this script's own ability to recover automatically
                  (typing the unlock password isn't something to automate),
                  so it is left for the user to run by hand.

  Minimize and virtual-desktop-switch are DELIBERATELY NOT RUN BY DEFAULT
  (see PERF-UX.md P2, "Verified against real OS state"). Both were driven
  for real and both are permanently unreachable for this window's current
  config (skipTaskbar + no decorations exempts it from Windows' minimize-all
  and virtual-desktop-cloak subsystems) — and for the virtual-desktop case,
  confirmed by screenshot to be the *intended* behavior (an OSD-style overlay
  that follows you across desktops), not a bug to chase. Re-enable with
  --include-dead-triggers only if the window's decorations/skipTaskbar
  config ever changes and this needs re-checking.

  Usage:
    node scripts/perf/verify-p2.mjs
    node scripts/perf/verify-p2.mjs --mode bar
    node scripts/perf/verify-p2.mjs --include-dead-triggers
*/

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { launchApp, REPO_ROOT } from './launch.mjs';
import { attachToApp } from './cdp.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 9222;
const MODES = process.argv.includes('--mode')
  ? [process.argv[process.argv.indexOf('--mode') + 1]]
  : ['full', 'bar', 'strip'];
const INCLUDE_DEAD_TRIGGERS = process.argv.includes('--include-dead-triggers');

/**
 * Run a PowerShell snippet and wait for it to exit.
 * @param {string} script
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function ps(script) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Launch a PowerShell script as a long-running detached process (for the
 * fullscreen-window trigger, which has to stay open until we close it).
 * @param {string} script
 * @returns {import('node:child_process').ChildProcess}
 */
function psDetached(script) {
  return spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** Poll `expr` (a CDP boolean expression) until it's true or the timeout elapses. */
async function waitFor(cdp, expr, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`return Boolean(${expr});`)) return true;
    await sleep(everyMs);
  }
  return false;
}

const KEYBD_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class P2Keys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@ -ErrorAction SilentlyContinue
`;

/** Ctrl+Win+<key>, held briefly then released, via keybd_event. */
async function chord(vkChar) {
  const vk = { RIGHT: 0x27, LEFT: 0x25, D: 0x44, F4: 0x73 }[vkChar];
  await ps(`
    ${KEYBD_HELPER}
    $LWIN=0x5B; $CTRL=0x11; $KEY=${vk}; $UP=0x2
    [P2Keys]::keybd_event($LWIN,0,0,[UIntPtr]::Zero)
    [P2Keys]::keybd_event($CTRL,0,0,[UIntPtr]::Zero)
    [P2Keys]::keybd_event($KEY,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [P2Keys]::keybd_event($KEY,0,$UP,[UIntPtr]::Zero)
    [P2Keys]::keybd_event($CTRL,0,$UP,[UIntPtr]::Zero)
    [P2Keys]::keybd_event($LWIN,0,$UP,[UIntPtr]::Zero)
  `);
}

/** Spawn a borderless WinForms window covering the primary monitor. Returns the child process. */
function spawnFullscreenCover() {
  return psDetached(`
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'
    $f.WindowState = 'Maximized'
    $f.TopMost = $true
    $f.BackColor = 'Black'
    $f.Text = 'p2-verify-fullscreen-cover'
    $f.Add_Shown({ $f.Activate() })
    [System.Windows.Forms.Application]::Run($f)
  `);
}

async function killTree(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    // Already gone.
  }
}

async function testOccludedByMinimize(cdp, results, mode) {
  const label = `${mode}: minimize → occluded`;
  try {
    await cdp.evaluate(`window.__TAURI__.window.getCurrentWindow().minimize(); return true;`);
    const paused = await waitFor(cdp, `overlayPaused === true`, 4000);
    await cdp.evaluate(`window.__TAURI__.window.getCurrentWindow().unminimize(); return true;`);
    const resumed = await waitFor(cdp, `overlayPaused === false`, 4000);
    results.push({ label, pass: paused && resumed, detail: `paused=${paused} resumed=${resumed}` });
  } catch (err) {
    results.push({ label, pass: false, detail: `threw: ${err.message}` });
  }
}

async function testOccludedByVirtualDesktop(cdp, results, mode) {
  const label = `${mode}: virtual-desktop switch → occluded (cloaked)`;
  try {
    await chord('D'); // create + switch to a new desktop
    await sleep(600); // let DWM actually cloak the window
    const paused = await waitFor(cdp, `overlayPaused === true`, 4000);
    await chord('F4'); // close the new desktop, returns to the original
    await sleep(600);
    const resumed = await waitFor(cdp, `overlayPaused === false`, 4000);
    results.push({ label, pass: paused && resumed, detail: `paused=${paused} resumed=${resumed}` });
  } catch (err) {
    results.push({ label, pass: false, detail: `threw: ${err.message}` });
    // Best-effort recovery so the run doesn't leave a stray desktop behind.
    try { await chord('F4'); } catch { /* already back */ }
  }
}

async function testFullscreen(cdp, results, mode) {
  const label = `${mode}: exclusive fullscreen app → pause (reason: fullscreen)`;
  const child = spawnFullscreenCover();
  try {
    await sleep(1200); // form creation + activation
    const paused = await waitFor(cdp, `overlayPaused === true`, 4000);
    await killTree(child.pid);
    await sleep(600);
    const resumed = await waitFor(cdp, `overlayPaused === false`, 4000);
    results.push({ label, pass: paused && resumed, detail: `paused=${paused} resumed=${resumed}` });
  } catch (err) {
    results.push({ label, pass: false, detail: `threw: ${err.message}` });
    await killTree(child.pid);
  }
}

async function main() {
  const runDir = join(REPO_ROOT, 'scripts', 'perf', 'runs');
  const profileDir = join(runDir, 'webview2-profile-p2');
  mkdirSync(runDir, { recursive: true });

  console.log(`Launching dev build with DevTools on :${PORT} (isolated perf identifier, not your real install)…`);
  const { child, stop } = launchApp({ port: PORT, build: 'dev', profileDir, verbose: false });

  const teardown = () => stop();
  process.on('SIGINT', () => { teardown(); process.exit(130); });

  const results = [];
  try {
    const { session: cdp } = await attachToApp(PORT, 120_000);

    const hasWindowApi = await cdp.evaluate(`return typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.window !== 'undefined';`);
    if (!hasWindowApi) {
      throw new Error('window.__TAURI__.window is not available on the page — withGlobalTauri or the window plugin JS binding may have changed.');
    }

    for (const mode of MODES) {
      console.log(`\n=== display mode: ${mode} ===`);
      await cdp.evaluate(`window.player.setDisplayMode(${JSON.stringify(mode)}); return true;`);
      await sleep(1200);

      const baseline = await cdp.evaluate(`return overlayPaused === false;`);
      console.log(`  baseline (nothing blocking): overlayPaused=false → ${baseline}`);

      const before = results.length;
      if (INCLUDE_DEAD_TRIGGERS) {
        await testOccludedByMinimize(cdp, results, mode);
        await testOccludedByVirtualDesktop(cdp, results, mode);
      } else {
        console.log('  SKIP  minimize / virtual-desktop-switch — confirmed permanently unreachable for this window (PERF-UX.md P2); pass --include-dead-triggers to re-check');
      }
      await testFullscreen(cdp, results, mode);

      for (const r of results.slice(before)) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  (${r.detail})`);
    }

    await cdp.evaluate(`window.player.setDisplayMode('full'); return true;`);
    cdp.close();
  } catch (err) {
    console.error(`\nHarness error: ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  } finally {
    teardown();
  }

  await sleep(1500);

  console.log('\n=== Summary ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
  console.log('\nNot attempted here — needs a human at the machine:');
  console.log('  - Win+L (lock screen): scriptable to trigger, but recovering requires typing the unlock password.');
  console.log('  - Unplugging AC: no software trigger; battery state is read from Windows, not simulated.');

  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

main();
