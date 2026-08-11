'use strict';

/*
  Auto-update against GitHub Releases.

  Why this is worth its weight: every fix currently requires the user to notice
  a release exists and re-download an installer by hand. At any scale beyond one
  machine that means most people stay on whatever version they first installed,
  and a bug fixed today reaches them never. It is the cheapest item on the
  roadmap and the one that makes every later fix actually land.

  Design notes:

    - **Nothing is installed behind the user's back.** The download happens
      automatically because it is large and slow and there is no point making
      someone wait for it after they have already said yes; but it is applied
      only when they choose to restart, or on the next natural quit. An overlay
      that vanishes mid-song to install itself would be worse than being stale.

    - **Failure is silent in the UI and loud in the log.** No network, a rate
      limit, an unsigned build, a machine behind a corporate proxy — none of
      these are the user's problem to solve, and a modal about them during a
      song is pure noise. The tray carries the state for anyone who looks.

    - **It does nothing in development.** electron-updater looks for a
      `dev-app-update.yml` that is not there and throws; guarding on
      `app.isPackaged` keeps `npm start` clean.

  The status formatting is kept as a pure function so it can be unit-tested
  without Electron, an updater, or a network. See test/updater.test.js.
*/

/**
 * @typedef {object} UpdateState
 * @property {'idle'|'checking'|'available'|'downloading'|'ready'|'none'|'error'} phase
 * @property {number} [percent]  0..100 while downloading
 * @property {string} [version]  the version found, once known
 * @property {string} [message]  error text, when phase is 'error'
 */

/**
 * Human label for an update state, for the tray menu and tooltip.
 *
 * Split out from the Electron plumbing on purpose: this is the only part with
 * branching worth testing, and it needs no runtime to test.
 *
 * @param {UpdateState} state
 * @returns {string}
 */
function describeUpdate(state) {
  if (!state || !state.phase) return 'Check for updates';
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Downloading ${state.version || 'update'}…`;
    case 'downloading': {
      // Math.floor, not round: showing "100%" while bytes are still arriving
      // reads as a hang. It reaches 100 only when the phase changes to 'ready'.
      const pct = Math.max(0, Math.min(99, Math.floor(state.percent || 0)));
      return `Downloading ${state.version || 'update'}… ${pct}%`;
    }
    case 'ready':
      return `Restart to install ${state.version || 'update'}`;
    case 'none':
      return 'Up to date';
    case 'error':
      return 'Update check failed';
    default:
      return 'Check for updates';
  }
}

/** Whether clicking the menu item should do anything in this state. */
function isUpdateActionable(state) {
  const phase = state && state.phase;
  return phase !== 'checking' && phase !== 'available' && phase !== 'downloading';
}

class AppUpdater {
  /**
   * @param {object} opts
   * @param {() => void} [opts.onChange] called whenever the state changes, so
   *   the tray can redraw itself.
   */
  constructor(opts = {}) {
    this.onChange = opts.onChange || (() => {});
    /** @type {UpdateState} */
    this.state = { phase: 'idle' };
    this.updater = null;
    this.enabled = false;
  }

  /**
   * Wire up electron-updater and run the first check.
   *
   * @param {boolean} isPackaged `app.isPackaged` — false in development.
   */
  start(isPackaged) {
    if (!isPackaged) {
      console.log('[updater] development build, auto-update disabled');
      return;
    }
    try {
      // Required lazily: pulling the module into a dev run costs startup time
      // for something that is then guarded off anyway.
      // eslint-disable-next-line global-require
      const { autoUpdater } = require('electron-updater');
      this.updater = autoUpdater;
      this.enabled = true;
    } catch (err) {
      console.error('[updater] unavailable:', err.message);
      return;
    }

    // Download without asking, install only on request. See the header note.
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;

    this.updater.on('checking-for-update', () => this.set({ phase: 'checking' }));
    this.updater.on('update-available', (info) => {
      this.set({ phase: 'available', version: info && info.version });
    });
    this.updater.on('update-not-available', () => this.set({ phase: 'none' }));
    this.updater.on('download-progress', (p) => {
      this.set({
        phase: 'downloading',
        percent: p && p.percent,
        version: this.state.version,
      });
    });
    this.updater.on('update-downloaded', (info) => {
      this.set({ phase: 'ready', version: info && info.version });
    });
    this.updater.on('error', (err) => {
      // Expected in the wild: offline, proxied, rate-limited. Log it, show a
      // neutral label, never interrupt.
      console.error('[updater]', err && err.message);
      this.set({ phase: 'error', message: err && err.message });
    });

    this.checkNow();
  }

  /** Ask GitHub whether there is anything newer. Safe to call any time. */
  checkNow() {
    if (!this.enabled || !this.updater) return;
    this.updater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err && err.message);
      this.set({ phase: 'error', message: err && err.message });
    });
  }

  /**
   * Quit and install a downloaded update.
   * @returns {boolean} whether anything was ready to install
   */
  installNow() {
    if (!this.enabled || !this.updater || this.state.phase !== 'ready') return false;
    // `true, true` — force quit even with a hidden window, and restart after.
    // Without the force the always-on-top overlay can keep the app alive.
    this.updater.quitAndInstall(true, true);
    return true;
  }

  /** @param {UpdateState} next */
  set(next) {
    this.state = next;
    this.onChange();
  }
}

module.exports = { AppUpdater, describeUpdate, isUpdateActionable };
