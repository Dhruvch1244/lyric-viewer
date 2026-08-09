'use strict';

/**
 * Thin re-export of the platform-agnostic lyric matching/parsing logic.
 * The real implementation lives in packages/core/src/lyrics.ts (shared with
 * the iOS app) — this file just keeps the existing require('./lyrics') call
 * sites in main.js working unchanged.
 */
const core = require('@lyric-viewer/core');

module.exports = {
  cleanTitle: core.cleanTitle,
  normalize: core.normalize,
  tokenSimilarity: core.tokenSimilarity,
  scoreCandidate: core.scoreCandidate,
  parseLrc: core.parseLrc,
  devanagariRatio: core.devanagariRatio,
  gurmukhiRatio: core.gurmukhiRatio,
  isDevanagariCues: core.isDevanagariCues,
  detectIndic: core.detectIndic,
  fetchSyncedLyrics: core.fetchSyncedLyrics,
};
