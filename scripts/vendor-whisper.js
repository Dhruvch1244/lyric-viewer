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
  /*
    Confirmed live (2026-08-17): ort.webgpu.bundle.min.mjs — the general
    InferenceSession.create() entry point transformers.js routes ALL
    backends through, not just webgpu — dynamically imports
    ort-wasm-simd-threaded.ASYNCIFY.mjs specifically when setting up the
    'wasm' execution provider in THIS environment (WebView2), not the .jsep
    variant above. Whether jsep is still needed for anything else here is
    genuinely unclear — left vendored rather than removed on a guess, since
    the failure mode for a MISSING file (silent pipeline failure) is worse
    than the cost of one unused ~25MB file. Revisit if installer size ever
    gets measured against this.
  */
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs'],
  /*
    transformers.web.min.js has a STATIC (not lazy/conditional) top-level
    `import * as _ from "onnxruntime-web/webgpu"` in one of its chunks —
    present unconditionally regardless of the `device: 'wasm'` option this
    app actually passes, confirmed via a live transcription attempt that
    failed immediately with "Failed to resolve module specifier
    onnxruntime-web/webgpu" (a bare specifier, which only a bundler or an
    import map can resolve — there is no bundler here, the browser loads
    this as a plain ES module). The WebGPU backend is never functionally
    used (device stays 'wasm' everywhere in whisper.js), but the module
    graph still has to resolve or nothing loads at all. Vendoring the real
    file (rather than a stub) avoids guessing at which of its exports the
    dead-for-us code path might still reference.
    Package export map: onnxruntime-web's "./webgpu" subpath resolves to
    this exact file (`node -e "console.log(require('onnxruntime-web/package.json').exports['./webgpu'])"`)
    — the self-contained "bundle" variant, chosen deliberately so it has no
    further unresolvable bare imports of its own.
  */
  ['onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', 'ort.webgpu.bundle.min.mjs'],
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

/*
  transformers.web.min.js also has a static top-level
  `import { Tensor } from "onnxruntime-common"` — unconditional, not tied to
  any backend choice, found the same way as the onnxruntime-web/webgpu
  import above (live transcription attempt failing with "Failed to resolve
  module specifier onnxruntime-common"). Unlike that one, onnxruntime-common
  is a multi-file ESM package whose files import each other by RELATIVE path
  (./tensor.js etc, confirmed by grepping its whole dist/esm for import
  statements — no further bare specifiers), so the fix is copying the whole
  esm directory with its internal structure intact, not one file. .d.ts/.map
  files are dev-only and skipped — this ships to users, not to a debugger.

  MUST come from node_modules/onnxruntime-web/node_modules/onnxruntime-common,
  NOT the top-level node_modules/onnxruntime-common — confirmed live (2026-08-17)
  the hard way: the top-level one resolves to whatever onnxruntime-NODE
  hoisted (1.24.3, a released version), while onnxruntime-web's own nested
  copy is a version-matched dev build (1.24.0-dev...) it was actually built
  and tested against. Using the wrong one doesn't fail to load — it loads
  fine and then fails much later, deep inside session creation, with a
  cryptic quantization error ("Missing required scale... DequantizeLinear")
  that has nothing obviously to do with a version mismatch. `npm ls
  onnxruntime-common` shows both copies nested separately; prefer the one
  actually under onnxruntime-web and fall back to top-level only if that
  path doesn't exist (e.g. a future onnxruntime-web release that dedupes
  cleanly against a matching top-level version).
*/
const ORT_COMMON_NESTED = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'node_modules', 'onnxruntime-common', 'dist', 'esm');
const ORT_COMMON_TOPLEVEL = path.join(__dirname, '..', 'node_modules', 'onnxruntime-common', 'dist', 'esm');
const ORT_COMMON_ESM = fs.existsSync(ORT_COMMON_NESTED) ? ORT_COMMON_NESTED : ORT_COMMON_TOPLEVEL;
const ORT_COMMON_OUT = path.join(OUT, 'onnxruntime-common');
if (!fs.existsSync(ORT_COMMON_ESM)) {
  console.error(`[vendor-whisper] missing ${ORT_COMMON_ESM} — run npm install first`);
  process.exit(1);
}
fs.mkdirSync(ORT_COMMON_OUT, { recursive: true });
let ortCommonBytes = 0;
for (const name of fs.readdirSync(ORT_COMMON_ESM)) {
  if (!name.endsWith('.js')) continue; // skip .d.ts / .js.map — dev-only
  fs.copyFileSync(path.join(ORT_COMMON_ESM, name), path.join(ORT_COMMON_OUT, name));
  ortCommonBytes += fs.statSync(path.join(ORT_COMMON_ESM, name)).size;
}
console.log(`[vendor-whisper] onnxruntime-common/*.js (${(ortCommonBytes / 1024).toFixed(0)} KB)`);

console.log('[vendor-whisper] done');
