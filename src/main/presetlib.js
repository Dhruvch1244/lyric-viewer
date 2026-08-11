'use strict';

/*
  The MilkDrop preset corpus, read from disk on demand.

  WHY MAIN OWNS IT. The presets live as files inside the installed app. The
  renderer runs under a CSP with no file access, and the engine frame has
  `connect-src 'none'` on purpose — it must not gain a way to fetch anything,
  because the entire reason it is allowed 'unsafe-eval' is that nothing
  network-shaped can reach it. Reading here and passing the parsed object over
  IPC keeps that boundary exactly where it was.

  WHY A NAME IS NOT A PATH. Preset names are arbitrary text written by strangers
  twenty years ago. `scripts/vendor-presets.js` numbers the files and records
  the mapping, so a lookup here is a `Map.get` and never a path built from
  caller-supplied text: there is no traversal to audit, and no name that is
  legal in MilkDrop but illegal on NTFS.

  WHY IT IS CACHED BY NAME. A preset is read when it is shown, and the browser
  shows the same handful repeatedly — stepping back one with the arrow keys must
  not re-read a file. The cache is bounded because the whole corpus is 8.4MB and
  there is no reason to hold it all to display one.
*/

const fs = require('fs');
const path = require('path');

/** How many parsed presets to keep. ~5KB each, so this is a few MB at worst. */
const CACHE_MAX = 128;

class PresetLibrary {
  /**
   * @param {string} [dir] directory holding index.json and the numbered presets.
   *   Defaults to the vendored corpus; injectable so tests need no fixtures on
   *   the real path.
   */
  constructor(dir) {
    this.dir = dir || path.join(__dirname, '..', 'renderer', 'vendor', 'presets');
    /** @type {Map<string, string>|null} name → filename, null until loaded */
    this.index = null;
    /** @type {Map<string, object>} name → parsed preset, most-recent-last */
    this.cache = new Map();
    /** Set when the index could not be read, so it is not retried per click. */
    this.failed = false;
  }

  /**
   * Load the index once. Safe to call repeatedly.
   * @returns {boolean} whether a catalogue is available
   */
  load() {
    if (this.index) return true;
    if (this.failed) return false;
    try {
      const raw = fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.presets) ? parsed.presets : [];
      this.index = new Map(entries.map((p) => [p.name, p.file]));
      return this.index.size > 0;
    } catch (err) {
      /* Not fatal by design: the frame ships a resident pack precisely so a
         missing or corrupt corpus costs variety rather than the visuals. */
      console.error('[presets] catalogue unavailable:', err.message);
      this.failed = true;
      return false;
    }
  }

  /**
   * Every preset name, sorted.
   * @returns {string[]}
   */
  names() {
    if (!this.load()) return [];
    return [...this.index.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * One preset, parsed.
   * @param {string} name
   * @returns {object|null} null when the name is unknown or the file is broken
   */
  get(name) {
    if (!name || !this.load()) return null;

    const hit = this.cache.get(name);
    if (hit) {
      // Re-insert so the eviction order is genuinely least-recently-used.
      this.cache.delete(name);
      this.cache.set(name, hit);
      return hit;
    }

    const file = this.index.get(name);
    if (!file) return null;

    try {
      const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
      const preset = JSON.parse(raw);
      this.cache.set(name, preset);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      return preset;
    } catch (err) {
      console.error(`[presets] ${name}: ${err.message}`);
      return null;
    }
  }
}

/*
  Preview thumbnails.

  Rendering one costs a preset compile plus ~34 frames, so the first pass over
  the catalogue is real work. It is done once: the images are written under
  userData and read back on every later open, which is what makes a grid of
  1754 previews a reasonable thing to offer at all.

  Filenames are hashed rather than derived, for the same reason preset files are
  numbered — a name is not a path. A hash also keeps the directory flat and
  fixed-width, which matters when it holds 1754 entries.
*/

const crypto = require('crypto');

class ThumbnailStore {
  /** @param {string} dir where to keep the JPEGs (under userData in the app) */
  constructor(dir) {
    this.dir = dir;
    this.ready = false;
  }

  /** @param {string} name @returns {string} absolute path for this preset */
  pathFor(name) {
    const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 16);
    return path.join(this.dir, `${hash}.jpg`);
  }

  ensureDir() {
    if (this.ready) return true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.ready = true;
    } catch (err) {
      console.error('[thumbs] cannot write:', err.message);
    }
    return this.ready;
  }

  /**
   * @param {string} name
   * @returns {string|null} a JPEG data URL, or null if not rendered yet
   */
  get(name) {
    if (!name) return null;
    try {
      const buf = fs.readFileSync(this.pathFor(name));
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} name
   * @param {string} dataUrl as produced by canvas.toDataURL('image/jpeg')
   * @returns {boolean} whether it was stored
   */
  put(name, dataUrl) {
    if (!name || typeof dataUrl !== 'string') return false;
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || comma < 0) return false;
    if (!this.ensureDir()) return false;
    try {
      fs.writeFileSync(this.pathFor(name), Buffer.from(dataUrl.slice(comma + 1), 'base64'));
      return true;
    } catch (err) {
      console.error(`[thumbs] ${name}: ${err.message}`);
      return false;
    }
  }

  /** Throw away every rendered preview. */
  clear() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      this.ready = false;
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { PresetLibrary, ThumbnailStore, CACHE_MAX };
