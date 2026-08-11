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

  0.21.0 changed two things, both from the same complaint — that the update
  never arrived and there was nothing on screen to say so:

    - **It checks more than once.** 0.20.0 checked exactly at startup. An
      overlay is left running for days; a release published while it is up was
      never noticed, and this app ships most days. There is now a periodic
      re-check.

    - **There is a history to read.** Every phase change is timestamped into a
      ring buffer. When an update silently does not happen, "nothing in the
      console of a packaged app nobody is running from a terminal" is not a
      diagnosis, and the next report should not need one either.

  The status formatting and the prompt decision are kept as pure functions so
  they can be unit-tested without Electron, an updater, or a network. See
  test/updater.test.js.
*/

/** How often to ask again while the app stays open. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** How many phase changes to keep for diagnosis. */
const HISTORY_LIMIT = 50;

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

/**
 * Whether the overlay should put a card on screen offering to restart.
 *
 * Only 'ready' qualifies: it is the one phase where there is something for the
 * user to decide. 'available' and 'downloading' are reported as a passive pill
 * instead — an update that is still arriving has no answer to give.
 *
 * A version the user has already said "later" to stays dismissed. Nagging every
 * few hours for the same build is how a prompt trains people to dismiss it
 * without reading, and the tray still carries the state for anyone who wants it.
 *
 * @param {UpdateState} state
 * @param {string|null} dismissedVersion the version 'Later' was clicked for
 * @returns {boolean}
 */
function shouldPromptRestart(state, dismissedVersion) {
  if (!state || state.phase !== 'ready') return false;
  return !state.version || state.version !== dismissedVersion;
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
    /** Version the user answered 'Later' to; suppresses the on-screen card. */
    this.dismissedVersion = null;
    /** @type {{at: number, phase: string, detail: string}[]} */
    this.history = [];
    this.recheckMs = opts.recheckMs || RECHECK_MS;
    this.timer = null;
    this.now = opts.now || (() => Date.now());
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

    /*
      Ask again while the app stays open. An overlay is left running for days
      and this app ships most days, so a startup-only check means a release
      published at noon is not seen until the machine is rebooted.

      `unref` so a pending timer never holds the process open at quit — the app
      is closed by the tray, and a 6-hour handle would keep it alive.
    */
    this.timer = setInterval(() => this.checkNow(), this.recheckMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Ask GitHub whether there is anything newer. Safe to call any time. */
  checkNow() {
    if (!this.enabled || !this.updater) return;
    this.updater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err && err.message);
      this.set({ phase: 'error', message: err && err.message });
    });
  }

  /** Stop re-checking. Called on quit; safe to call twice. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Record that the user chose 'Later' for the version currently ready.
   *
   * The download stays on disk and `autoInstallOnAppQuit` still applies it on
   * the next natural quit — declining the card declines the *interruption*, not
   * the update.
   */
  dismiss() {
    this.dismissedVersion = this.state.version || null;
    this.onChange();
  }

  /** Whether the overlay should show its restart card right now. */
  shouldPrompt() {
    return shouldPromptRestart(this.state, this.dismissedVersion);
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
    /*
      Progress ticks arrive many times a second and would flood the history out
      of anything useful within one download, so only phase *changes* are
      recorded. The percent is still live in `state` for the pill to read.
    */
    if (!this.state || this.state.phase !== next.phase) {
      this.history.push({
        at: this.now(),
        phase: next.phase,
        detail: next.message || next.version || '',
      });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    this.state = next;
    this.onChange();
  }
}

module.exports = {
  AppUpdater, describeUpdate, isUpdateActionable, shouldPromptRestart, RECHECK_MS,
};
