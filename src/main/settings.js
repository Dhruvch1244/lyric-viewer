'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The userData directory, resilient to running outside Electron.
 *
 * Electron's `app.getPath('userData')` is the real answer in the app. In a bare
 * `node --test` run there is no Electron app, so `require('electron')` yields a
 * stub with no `app` and `getPath` throws — which used to crash any module that
 * constructed a Settings at load time. Fall back to a per-OS config dir so the
 * store works headless too.
 *
 * @returns {string}
 */
function userDataDir() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch { /* not in Electron — fall through */ }
  const base = process.env.APPDATA
    || process.env.XDG_CONFIG_HOME
    || path.join(os.homedir(), '.config');
  return path.join(base, 'lyric-overlay');
}

/**
 * Tiny JSON-backed settings store.
 *
 * Holds the per-track sync offsets that make lyric alignment stick between
 * sessions — the same track tends to need the same correction every time, so
 * dialling it in once should be permanent.
 */
class Settings {
  constructor() {
    this.file = path.join(userDataDir(), 'settings.json');
    this.data = this.#load();
  }

  /**
   * @returns {object} Parsed settings, or an empty object when absent/corrupt.
   */
  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // Missing or unreadable settings are not an error — start fresh.
      return {};
    }
  }

  /**
   * @param {string} key
   * @param {*} fallback Returned when the key is unset.
   * @returns {*}
   */
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  /**
   * Set a value and flush to disk.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      // Settings are a convenience; never let a disk failure break playback.
      console.error('[settings] write failed:', err.message);
    }
  }
}

module.exports = { Settings };
