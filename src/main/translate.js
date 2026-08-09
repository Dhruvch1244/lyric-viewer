'use strict';

const { convert, isLLMAvailable } = require('./llm');
const { toEnglish: coreToEnglish } = require('@lyric-viewer/core');

/**
 * English translation of Hindi / Punjabi (and other non-English) lyric lines.
 *
 * The prompt/schema/batching logic lives in packages/core (shared with the
 * iOS app); this file supplies the Electron-specific `convert` — provider
 * selection by env var, see ./llm.js.
 *
 * This is TRANSLATION (meaning), distinct from transliteration (script). It is
 * shown as a secondary line beneath the running lyric so you can follow along.
 */

/**
 * Whether English translation can run (any LLM provider configured).
 * @returns {boolean}
 */
function isTranslationAvailable() {
  return isLLMAvailable();
}

/**
 * Translate a full cue list to English, preserving timing.
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Promise<{language: string, cues: Array<{timeMs: number, text: string}>}>}
 */
async function toEnglish(cues) {
  return coreToEnglish(cues, convert);
}

module.exports = { toEnglish, isTranslationAvailable };
