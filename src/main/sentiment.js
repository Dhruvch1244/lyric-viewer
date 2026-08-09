'use strict';

const { convert, isLLMAvailable } = require('./llm');
const { analyzeSentiment: coreAnalyzeSentiment } = require('@lyric-viewer/core');

/**
 * Song-sentiment analysis → visual parameters.
 *
 * The prompt/schema/batching logic lives in packages/core (shared with the
 * iOS app); this file supplies the Electron-specific `convert` — provider
 * selection by env var, see ./llm.js.
 */

/** @returns {boolean} Whether sentiment analysis can run. */
function isSentimentAvailable() {
  return isLLMAvailable();
}

/**
 * Analyze the sentiment of a cue list.
 * @param {Array<{text: string}>} cues
 * @returns {Promise<{mood: string, hue: number, saturation: number, energy: number}>}
 */
async function analyzeSentiment(cues) {
  return coreAnalyzeSentiment(cues, convert);
}

module.exports = { analyzeSentiment, isSentimentAvailable };
