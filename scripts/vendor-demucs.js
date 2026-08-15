'use strict';

/*
  Copy onnxruntime-web's plain-WASM runtime into src/renderer/vendor/onnxruntime,
  where the Tauri frontend bundle serves it. Same reasoning as vendor-whisper.js:
  large binaries from node_modules, gitignored, re-materialised before a build.

  Demucs (src/renderer/demucs.js) uses onnxruntime-web DIRECTLY rather than
  through transformers.js's pipeline() — this transformers.js version's
  SUPPORTED_TASKS has no audio-source-separation entry, so there is no
  pipeline() abstraction to reuse the way whisper.js does. A second, separate
  ort runtime copy (rather than reaching into transformers.js's internal one)
  keeps demucs.js self-contained and not dependent on an internal API transformers.js
  does not document as public.
*/
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'onnxruntime');
const COPIES = [
  ['onnxruntime-web/dist/ort.wasm.min.mjs', 'ort.wasm.min.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of COPIES) {
  const src = path.join(__dirname, '..', 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error(`[vendor-demucs] missing ${src} — run npm install first`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(OUT, to));
  const mb = (fs.statSync(src).size / 1024 / 1024).toFixed(2);
  console.log(`[vendor-demucs] ${to} (${mb} MB)`);
}
console.log('[vendor-demucs] done');
