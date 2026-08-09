'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Persistent, disk-backed cache for lyric data.
 *
 * The in-memory `lyricCache` in main.js is lost on every restart, which means a
 * song you already played gets re-fetched from LRCLIB — and re-sent to the LLM
 * provider for translation — the next time you play it, burning a limited free
 * quota fast and requiring the network. This store keeps both:
 *
 *   - the raw synced cues (from LRCLIB), so a song you've heard before replays
 *     instantly and OFFLINE, and
 *   - the LLM-derived results (English translation, Devanagari transliteration,
 *     mood palette), so each song is analysed by the provider at most once, ever.
 *
 * All keyed by track, so the app becomes a growing offline library of everything
 * you've listened to.
 */

// Kept at 1: the new raw-cue fields are additive, so pre-existing entries (which
// already hold translations/mood) load fine and simply lack `cues` until the song
// is played once more — no cache wipe, no re-burning of LLM quota.
const CACHE_VERSION = 1;
/** Hard cap on stored tracks; oldest are evicted first to bound the file size. */
const MAX_ENTRIES = 600;
/** Debounce window (ms) so bursts of writes coalesce into one disk flush. */
const WRITE_DEBOUNCE_MS = 400;
/** Fields merged/persisted per entry. Only defined keys overwrite on merge. */
const PERSISTED_FIELDS = ['title', 'artist', 'cues', 'source', 'indic', 'cuesEnglish', 'language', 'cuesDevanagari', 'mood', 'beatmap'];

/** @typedef {{cues?: Array|null, source?: string|null, indic?: boolean, cuesEnglish?: Array|null, language?: string, cuesDevanagari?: Array|null, mood?: object|null, updatedAt: number}} CacheEntry */

class LlmCache {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'llm-cache.json');
    /** @type {Record<string, CacheEntry>} */
    this.entries = this.#load();
    /** @type {NodeJS.Timeout|null} */
    this.writeTimer = null;
  }

  /**
   * @returns {Record<string, CacheEntry>} Parsed entries, or empty on absence/corruption.
   */
  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
        return parsed.entries;
      }
    } catch {
      // Missing or unreadable cache is not an error — start empty.
    }
    return {};
  }

  /**
   * Return the cached LLM data for a track, or null if nothing is stored.
   * @param {string} key trackKey (already normalised by the caller)
   * @returns {CacheEntry|null}
   */
  get(key) {
    return Object.prototype.hasOwnProperty.call(this.entries, key) ? this.entries[key] : null;
  }

  /**
   * Summarise every cached song for the "synced library" UI, newest first.
   * @returns {Array<{key:string, title:string|null, artist:string|null, hasCues:boolean, hasBeatmap:boolean, updatedAt:number}>}
   */
  list() {
    return Object.entries(this.entries)
      .map(([key, e]) => ({
        key,
        title: e.title || null,
        artist: e.artist || null,
        hasCues: Array.isArray(e.cues) && e.cues.length > 0,
        hasBeatmap: Boolean(e.beatmap),
        updatedAt: e.updatedAt || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Merge partial LLM data into the entry for a track and schedule a flush.
   * Only defined keys overwrite; this lets translation, transliteration, and
   * mood each be filled in independently as they complete.
   * @param {string} key trackKey
   * @param {Partial<CacheEntry>} partial
   */
  merge(key, partial) {
    const prev = this.entries[key] || {};
    const next = { ...prev };
    for (const field of PERSISTED_FIELDS) {
      if (partial[field] !== undefined) next[field] = partial[field];
    }
    next.updatedAt = Date.now();
    this.entries[key] = next;
    this.#scheduleWrite();
  }

  /** Coalesce rapid writes into a single debounced disk flush. */
  #scheduleWrite() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.#flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Evict oldest entries past the cap, then write the whole cache to disk. */
  #flush() {
    try {
      const keys = Object.keys(this.entries);
      if (keys.length > MAX_ENTRIES) {
        keys
          .sort((a, b) => (this.entries[a].updatedAt || 0) - (this.entries[b].updatedAt || 0))
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach((k) => delete this.entries[k]);
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ version: CACHE_VERSION, entries: this.entries }),
        'utf8'
      );
    } catch (err) {
      // The cache is a convenience; never let a disk failure break playback.
      console.error('[llm-cache] write failed:', err.message);
    }
  }
}

module.exports = { LlmCache };
