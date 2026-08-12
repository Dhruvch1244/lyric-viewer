'use strict';

/*
  Copy the transformers.js WEB build + the onnxruntime-web WASM into
  src/renderer/vendor/transformers, where the Tauri frontend bundle serves them.

  These are large binaries copied from node_modules, so they are gitignored and
  re-materialised here. Run before `tauri build` (wired into the npm scripts).
*/
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'transformers');
const COPIES = [
  ['@huggingface/transformers/dist/transformers.web.min.js', 'transformers.web.min.js'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.wasm'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.mjs'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of COPIES) {
  const src = path.join(__dirname, '..', 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error(`[vendor-whisper] missing ${src} — run npm install first`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(OUT, to));
  const mb = (fs.statSync(src).size / 1024 / 1024).toFixed(2);
  console.log(`[vendor-whisper] ${to} (${mb} MB)`);
}
console.log('[vendor-whisper] done');
