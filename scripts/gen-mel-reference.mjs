/*
  Regenerate the reference numbers baked into src-tauri/sidecar/src/mel.rs.

  The Rust log-mel front end has to match Whisper's preprocessing exactly, and
  "exactly" is not checkable by inspection — a wrong window or an off-by-one in
  the framing produces a spectrogram that looks entirely reasonable and makes
  the model transcribe nonsense. So the Rust tests assert against features
  produced HERE, by transformers.js: an independently written implementation,
  and specifically the one the WASM path in src/renderer/whisper.js runs today.
  Matching it means the native path cannot regress what already works.

  Run:  node scripts/gen-mel-reference.mjs
  Then paste the printed constants into mel.rs's `REFERENCE_CELLS` and the
  min/max/mean assertions. It prints Rust, not JSON, because the output is
  source that gets pasted, not data that gets loaded.
*/
import { WhisperFeatureExtractor } from '@huggingface/transformers';

/** Whisper's preprocessor_config.json for every model this app can use. */
const CONFIG = {
  feature_size: 80,
  sampling_rate: 16000,
  hop_length: 160,
  chunk_length: 30,
  n_fft: 400,
  padding_value: 0.0,
  n_samples: 480000,
  nb_max_frames: 3000,
};

/*
  Three tones: one below the mel scale's 1 kHz linear/log knee, one above it,
  one near the top. 440 and 5000 Hz land exactly on FFT bin centres (bin
  spacing is 40 Hz) and 1500 does not, so the signal exercises both the
  leakage-free and the leaking case.

  f64 throughout, narrowed once at the end -- the Rust test does the same, and
  for a reason: at t ~ 30 s the argument to sin is ~83000 radians, where f32's
  seven digits leave the phase wrong enough to lift every quiet mel band off
  the dynamic-range floor. Getting that wrong reads exactly like a front-end
  bug.
*/
function signal(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / CONFIG.sampling_rate;
    a[i] = 0.6 * Math.sin(2 * Math.PI * 440 * t)
         + 0.3 * Math.sin(2 * Math.PI * 1500 * t)
         + 0.1 * Math.sin(2 * Math.PI * 5000 * t);
  }
  return a;
}

/*
  Frames 0, 1 and 2999 sit against the reflect padding, where a sine starting
  at zero gets mirrored into a corner and splatters energy across every band --
  which makes them the sharpest available test of the padding. The rest catch a
  wrong filterbank, window or normalisation.
*/
const PROBE_MELS = [0, 1, 13, 40, 79];
const PROBE_FRAMES = [0, 1, 2, 50, 99, 100, 1499, 2999];

const fe = new WhisperFeatureExtractor(CONFIG);

async function stats(samples) {
  const { input_features } = await fe(samples);
  const [, , frames] = input_features.dims;
  const data = input_features.data;
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { data, frames, min, max, mean: sum / data.length };
}

const full = await stats(signal(CONFIG.n_samples));
const short = await stats(signal(CONFIG.sampling_rate)); // 1 s, padded to 30 s

console.log(`// a_full_chunk_matches_transformers_js`);
console.log(`assert_close(min, ${full.min.toFixed(6)}, 1e-4, "min");`);
console.log(`assert_close(max, ${full.max.toFixed(6)}, 1e-4, "max");`);
console.log(`assert_close(mean, ${full.mean.toFixed(6)}, 1e-4, "mean");`);
console.log();
console.log(`// short_audio_is_padded_to_a_chunk_the_way_the_reference_pads_it`);
console.log(`assert_close(min, ${short.min.toFixed(6)}, 1e-4, "min");`);
console.log(`assert_close(max, ${short.max.toFixed(6)}, 1e-4, "max");`);
console.log(`assert_close(mean, ${short.mean.toFixed(6)}, 1e-4, "mean");`);
console.log();
console.log(`// REFERENCE_CELLS`);
for (const mel of PROBE_MELS) {
  for (const frame of PROBE_FRAMES) {
    const v = full.data[mel * full.frames + frame];
    console.log(`    (${mel}, ${frame}, ${v.toFixed(6)}),`);
  }
}
