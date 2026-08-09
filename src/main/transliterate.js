'use strict';

const { convert, isLLMAvailable } = require('./llm');
const { toDevanagari: coreToDevanagari } = require('@lyric-viewer/core');

/**
 * Devanagari transliteration for romanized Hindi lyrics.
 *
 * The prompt/schema/batching logic lives in packages/core (shared with the
 * iOS app); this file supplies the Electron-specific `convert` — provider
 * selection by env var, see ./llm.js.
 *
 * This is TRANSLITERATION (script conversion), never translation: the words and
 * their order are preserved exactly; only the writing system changes.
 */

/**
 * Whether transliteration can run (any LLM provider configured).
 * @returns {boolean}
 */
function isTransliterationAvailable() {
  return isLLMAvailable();
}

/**
 * Transliterate a full cue list into Devanagari, preserving timing.
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Promise<Array<{timeMs: number, text: string}>>}
 */
async function toDevanagari(cues) {
  return coreToDevanagari(cues, convert);
}

module.exports = { toDevanagari, isTransliterationAvailable };
