'use strict';

/**
 * Whisper transcription — synced lyrics for tracks LRCLIB has none for.
 *
 * Division of labour with the renderer (see src/renderer/capture.js):
 *   - The RENDERER acquires and decodes audio. Chromium's Web Audio API
 *     already decodes mp3/flac/m4a/ogg and resamples for free, and the
 *     loopback capture stream lives there anyway. It hands over plain
 *     Float32 PCM, 16 kHz, mono — exactly what Whisper wants.
 *   - THIS MODULE owns the model. Inference needs the native ONNX Runtime
 *     binding, which only exists in the main process.
 *
 * That split means no ffmpeg, no codec libraries and no temp WAV files.
 *
 * The model is downloaded once (~250 MB at q8) into userData and cached on
 * disk forever after. Nothing is downloaded until the user actually asks for
 * a transcription.
 *
 * Honest limits — Whisper is a *speech* model:
 *   - Accuracy on sung vocals over a dense mix is well below its speech
 *     accuracy. Expect real errors, especially on fast rap and heavy EDM.
 *   - It hallucinates on instrumental passages (see HALLUCINATION_RE).
 *   - Timestamps are segment-level, so they land near the line but are not
 *     as tight as a human-authored LRC file.
 * Treat the output as a good draft for songs that otherwise have no lyrics
 * at all, not as a replacement for a real synced file.
 */

const path = require('path');

/**
 * Model choice, measured on this machine (CPU, q8, 11s clip):
 *
 *   Xenova/whisper-tiny.en    8.0s   0.73x realtime   English only
 *   Xenova/whisper-base      11.9s   1.08x realtime   multilingual   <- default
 *   Xenova/whisper-small     37.5s   3.40x realtime   multilingual, most accurate
 *
 * `base` is the default because it runs at roughly realtime, so a 3.5-minute
 * song transcribes in about the time it takes to play. `small` is noticeably
 * more accurate — particularly on Hindi/Punjabi — but at 3.4x realtime the
 * same song costs ~12 minutes of CPU, which is a background-job-only
 * proposition. Callers can pass either via `options.modelId`.
 */
const DEFAULT_MODEL = 'Xenova/whisper-base';

/** Models offered to the user, fastest first. */
const MODELS = [
  { id: 'Xenova/whisper-base', label: 'Base — ~1x realtime, multilingual' },
  { id: 'Xenova/whisper-small', label: 'Small — ~3.4x realtime, most accurate' },
  { id: 'Xenova/whisper-tiny.en', label: 'Tiny — fastest, English only' },
];

/**
 * Whisper's 30-second receptive field. Longer audio is processed in chunks
 * with an overlap so words spanning a boundary are not lost.
 */
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;

/**
 * Lines Whisper emits when there is no speech — subtitle-style annotations it
 * learned from its training data, plus the "thanks for watching" family of
 * hallucinations it produces over music and silence. These are never lyrics.
 */
const HALLUCINATION_RE = new RegExp(
  [
    '^\\s*[\\[(][^\\])]*[\\])]\\s*$',          // [Music], (applause), [BLANK_AUDIO]
    '^\\s*♪+\\s*$',                             // bare music notes
    '^\\s*thanks? for watching',
    '^\\s*thank you for watching',
    '^\\s*please subscribe',
    '^\\s*subtitles? by',
    '^\\s*amara\\.org',
  ].join('|'),
  'i'
);

/** @type {Promise<any>|null} Cached pipeline promise, so we load the model once. */
let transcriberPromise = null;
/** @type {string|null} Which model the cached pipeline was built for. */
let loadedModelId = null;

/**
 * Point the library's model cache at userData. The default lives inside
 * node_modules, which is read-only in a packaged build and is wiped by every
 * app update — a 250 MB re-download each time.
 * @param {object} env transformers.js `env` object
 */
function configureCache(env) {
  // Required lazily rather than at module load so the pure helpers below stay
  // unit-testable under plain `node --test`, where `electron` does not exist.
  const { app } = require('electron');
  env.cacheDir = path.join(app.getPath('userData'), 'models');
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
}

/**
 * Load (and on first use, download) the speech-recognition pipeline.
 *
 * @param {object} [options]
 * @param {string} [options.modelId] HuggingFace repo id
 * @param {string} [options.dtype='q8'] quantisation; q8 roughly halves size
 *   and speeds up CPU inference at a small accuracy cost
 * @param {(p: {status: string, file?: string, progress?: number, loaded?: number, total?: number}) => void} [options.onProgress]
 * @returns {Promise<Function>} the transcriber pipeline
 */
async function getTranscriber(options = {}) {
  const modelId = options.modelId || DEFAULT_MODEL;

  // Rebuild if the caller switched models.
  if (transcriberPromise && loadedModelId !== modelId) {
    transcriberPromise = null;
  }

  if (!transcriberPromise) {
    loadedModelId = modelId;
    transcriberPromise = (async () => {
      // ESM-only package; this file is CommonJS, so dynamic import is the
      // only route in. Verified to work under Electron's loader.
      const { pipeline, env } = await import('@huggingface/transformers');
      configureCache(env);
      return pipeline('automatic-speech-recognition', modelId, {
        dtype: options.dtype || 'q8',
        progress_callback: options.onProgress,
      });
    })().catch((err) => {
      // Never cache a failed load, or every later attempt replays the failure.
      transcriberPromise = null;
      loadedModelId = null;
      throw err;
    });
  }

  return transcriberPromise;
}

/**
 * Convert Whisper's timestamped chunks into the app's cue format.
 *
 * Drops hallucinated non-lyric annotations, collapses the runs of identical
 * lines Whisper produces when it loops on instrumental sections, and skips
 * chunks with no usable start time.
 *
 * @param {Array<{timestamp: [number, number|null], text: string}>} chunks
 * @returns {Array<{timeMs: number, text: string}>} cues, ascending by time
 */
function chunksToCues(chunks) {
  if (!Array.isArray(chunks)) return [];

  const cues = [];
  let lastText = '';

  for (const chunk of chunks) {
    const text = (chunk.text || '').trim();
    if (!text) continue;
    if (HALLUCINATION_RE.test(text)) continue;

    // The final chunk can carry a null end timestamp; only the start matters.
    const start = chunk.timestamp && typeof chunk.timestamp[0] === 'number'
      ? chunk.timestamp[0]
      : null;
    if (start === null || !Number.isFinite(start)) continue;

    // Whisper loops the same phrase over long instrumental stretches.
    if (text === lastText) continue;
    lastText = text;

    cues.push({ timeMs: Math.max(0, Math.round(start * 1000)), text });
  }

  cues.sort((a, b) => a.timeMs - b.timeMs);
  return cues;
}

/**
 * Transcribe mono 16 kHz PCM into synced cues.
 *
 * @param {Float32Array} pcm mono samples at 16 kHz, range -1..1
 * @param {object} [options]
 * @param {string} [options.language] e.g. 'english', 'hindi', 'punjabi'.
 *   IMPORTANT: omitting this does NOT auto-detect — the library logs
 *   "No language specified - defaulting to English (en)" and decodes as
 *   English, which mangles Hindi/Punjabi vocals into English-sounding
 *   nonsense. Always pass the language for non-English tracks.
 * @param {string} [options.modelId]
 * @param {string} [options.dtype]
 * @param {Function} [options.onProgress] model download/load progress
 * @returns {Promise<{cues: Array<{timeMs: number, text: string}>, text: string, durationMs: number}>}
 */
async function transcribePcm(pcm, options = {}) {
  if (!(pcm instanceof Float32Array) || pcm.length === 0) {
    throw new Error('transcribePcm: expected a non-empty Float32Array of 16kHz mono PCM');
  }

  const transcriber = await getTranscriber(options);

  const result = await transcriber(pcm, {
    return_timestamps: true,
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    ...(options.language ? { language: options.language, task: 'transcribe' } : {}),
  });

  return {
    cues: chunksToCues(result.chunks),
    text: (result.text || '').trim(),
    durationMs: Math.round((pcm.length / 16000) * 1000),
  };
}

/** Release the model, freeing its (substantial) memory. */
async function dispose() {
  if (!transcriberPromise) return;
  try {
    const t = await transcriberPromise;
    if (t && typeof t.dispose === 'function') await t.dispose();
  } catch {
    /* already failed to load; nothing to release */
  }
  transcriberPromise = null;
  loadedModelId = null;
}

/** Whether the model has been loaded into memory this session. */
function isLoaded() {
  return Boolean(transcriberPromise);
}

module.exports = {
  transcribePcm,
  getTranscriber,
  chunksToCues,
  dispose,
  isLoaded,
  DEFAULT_MODEL,
  MODELS,
  SAMPLE_RATE: 16000,
};
