'use strict';

/**
 * Offline Hindi → English translation, no API key.
 *
 * The LLM providers (see llm.js) are a good translator but they need a key, a
 * network round-trip, and a free-tier quota. A small Marian model runs on the
 * machine instead, and the runtime it needs — onnxruntime-node — already ships
 * for Whisper, so this costs one ~75MB model download and nothing else.
 *
 * IT IS DELIBERATELY NARROW. Measured on Xenova/opus-mt-hi-en:
 *
 *   देवनागरी  "तेरा नाम मेरे दिल में है"          -> "Your Name Is in My Heart"   good
 *   देवनागरी  "सब झुके और श्रद्धा से बोले"        -> "They all said humbled and
 *                                                     reverential"               good
 *   romanized "Tera naam mere dil mein hai"    -> "So this is a negative
 *                                                  divisible by the negative."   garbage
 *   english   "I have been on my own..."       -> "I've been on my account..."   mangled
 *
 * The model was trained on Devanagari and cannot read romanized Hindi at all —
 * and being a hi→en model it will happily mangle English rather than leave it
 * alone. Both failures produce confident nonsense, which on screen is worse
 * than showing no translation, so `canTranslate` gates on the text actually
 * being Devanagari and the caller keeps the LLM path for everything else.
 *
 * Unlocking romanized lyrics (the majority of what LRCLIB carries for Indian
 * songs) needs Latin→Devanagari transliteration first — see the notes in
 * transliterate.js.
 */

const path = require('path');
const { devanagariRatio } = require('./lyrics');

/** ONNX build of Helsinki-NLP/opus-mt-hi-en. ~75MB at q8. */
const MODEL_ID = 'Xenova/opus-mt-hi-en';

/** Minimum share of Devanagari letters before this model is worth using. */
const SCRIPT_FLOOR = 0.4;

/** Lines per generate() call. Marian has a short context; keep batches small. */
const BATCH_SIZE = 8;

/** @type {Promise<Function>|null} Cached pipeline, so the model loads once. */
let pipePromise = null;

/**
 * Point the model cache at userData, matching transcribe.js.
 *
 * Without this the download lands in the package directory, which is read-only
 * in an installed build — so it would fail there, or silently re-download every
 * launch. `electron` is required lazily so the pure helpers in this file stay
 * unit-testable under plain `node --test`, where it does not exist.
 *
 * @param {object} env the transformers.js env object
 */
function configureCache(env) {
  const { app } = require('electron');
  env.cacheDir = path.join(app.getPath('userData'), 'models');
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
}

/**
 * Whether local translation is a good idea for these cues.
 *
 * @param {Array<{text: string}>} cues
 * @returns {boolean}
 */
function canTranslate(cues) {
  if (!Array.isArray(cues) || cues.length === 0) return false;
  const sample = cues.slice(0, 20).map((c) => (c && c.text) || '').join(' ');
  return devanagariRatio(sample) >= SCRIPT_FLOOR;
}

/**
 * Load (and on first use, download) the translation pipeline.
 * @returns {Promise<Function>}
 */
function getTranslator() {
  if (!pipePromise) {
    pipePromise = (async () => {
      // ESM-only package; this file is CommonJS, so dynamic import is the way in
      // (same approach as transcribe.js).
      const { pipeline, env } = await import('@huggingface/transformers');
      configureCache(env);
      return pipeline('translation', MODEL_ID, { dtype: 'q8' });
    })().catch((err) => {
      pipePromise = null;    // let a later attempt retry a transient failure
      throw err;
    });
  }
  return pipePromise;
}

/**
 * Translate cues to English locally, preserving timing.
 *
 * Mirrors the shape of translate.js `toEnglish` so the caller can use either.
 *
 * @param {Array<{timeMs: number, text: string}>} cues
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{language: string, cues: Array<{timeMs: number, text: string}>}>}
 */
async function toEnglishLocal(cues, onProgress) {
  const translate = await getTranslator();
  const out = [];

  for (let i = 0; i < cues.length; i += BATCH_SIZE) {
    const batch = cues.slice(i, i + BATCH_SIZE);
    // Blank lines would come back as hallucinated text, so pass only real ones.
    const texts = batch.map((c) => (c.text || '').trim());
    const results = await Promise.all(
      texts.map(async (text) => {
        if (!text) return '';
        const r = await translate(text);
        const first = Array.isArray(r) ? r[0] : r;
        return String((first && (first.translation_text ?? first.generated_text)) || '').trim();
      })
    );
    for (let j = 0; j < batch.length; j += 1) {
      out.push({ timeMs: batch[j].timeMs, text: results[j] });
    }
    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, cues.length), cues.length);
  }

  return { language: 'hindi', cues: out };
}

/**
 * Whether these cues can be translated offline AT ALL — natively or by
 * converting the script first.
 *
 * @param {Array<{text: string}>} cues
 * @param {boolean} indic whether the lyrics were detected as Hindi/Punjabi
 * @returns {boolean}
 */
function canTranslateOffline(cues, indic) {
  if (!Array.isArray(cues) || cues.length === 0) return false;
  return canTranslate(cues) || Boolean(indic);
}

/**
 * Translate to English offline, transliterating first when the lyrics are
 * romanized.
 *
 * This is the step that makes the offline path cover most Indian songs rather
 * than only native-script ones. The model reads Devanagari and nothing else, so
 * romanized lyrics — the majority of what LRCLIB carries — used to fall through
 * to a cloud provider. Converting the script first (see romanize.js) feeds them
 * into a translator that already works.
 *
 * The transliteration is an approximation, so this is a quality trade rather
 * than a free win: an LLM provider, when one is configured and working, will
 * still translate romanized lyrics better. It is chosen only when the
 * alternative is no translation at all.
 *
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Promise<{language: string, cues: Array, viaTransliteration: boolean}>}
 */
async function toEnglishOffline(cues) {
  if (canTranslate(cues)) {
    return { ...(await toEnglishLocal(cues)), viaTransliteration: false };
  }

  // Romanized: convert the script, translate that, and put the results back
  // against the ORIGINAL cues so timing and any word spans are preserved.
  const { cuesToDevanagari } = require('./romanize');
  const deva = cuesToDevanagari(cues);
  const out = await toEnglishLocal(deva);
  return {
    language: out.language,
    cues: cues.map((cue, i) => ({ timeMs: cue.timeMs, text: (out.cues[i] && out.cues[i].text) || '' })),
    viaTransliteration: true,
  };
}

module.exports = {
  toEnglishLocal, toEnglishOffline, canTranslate, canTranslateOffline,
  MODEL_ID, SCRIPT_FLOOR,
};
