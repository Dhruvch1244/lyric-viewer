'use strict';

/*
  Build the inference sidecar and stage it where Tauri's `externalBin` expects
  it: src-tauri/binaries/lyric-inference-<target-triple>.exe.

  Tauri does not build externalBin entries — it only copies them into the
  bundle, and it looks for the host target triple appended to the configured
  path. That naming is not decoration: it is how one config line ships the
  right binary when the same project is built for several targets.

  The staged binaries are gitignored and re-materialised here, matching how
  vendor-whisper.js and vendor-presets.js handle their large artefacts.
*/
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'binaries');

/** The triple `rustc` will actually produce, which is what Tauri looks for. */
function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (!line) throw new Error('cannot determine the host target triple from `rustc -vV`');
  return line.slice('host:'.length).trim();
}

function main() {
  const triple = hostTriple();
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';

  console.log(`[vendor-sidecar] building lyric-inference for ${triple}`);
  execFileSync('cargo', ['build', '--release', '--manifest-path', MANIFEST, '-p', 'lyric-inference'], { stdio: 'inherit' });

  const built = path.join(ROOT, 'src-tauri', 'target', 'release', `lyric-inference${exeSuffix}`);
  if (!fs.existsSync(built)) {
    console.error(`[vendor-sidecar] cargo reported success but ${built} is missing`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const staged = path.join(OUT_DIR, `lyric-inference-${triple}${exeSuffix}`);
  fs.copyFileSync(built, staged);
  console.log(`[vendor-sidecar] ${path.basename(staged)} (${(fs.statSync(staged).size / 1024 / 1024).toFixed(2)} MB)`);

  /*
    ORT's `download-binaries` feature links ONNX Runtime STATICALLY — verified
    by running this exact staged binary from an empty directory with no DLLs
    beside it, where it started and exited cleanly. So there is normally
    nothing else to copy, and the single self-contained exe is what ships.

    The sweep below is a guard, not a routine step: if a future ort release
    switches to a shared library, the sidecar would start failing at spawn
    with "the specified module could not be found" — an error naming neither
    the missing DLL nor the sidecar. Copying anything that shows up keeps that
    from becoming a release-day mystery.
  */
  const releaseDir = path.dirname(built);
  const runtimeLibs = fs.readdirSync(releaseDir).filter((n) => /^onnxruntime.*\.(dll|so|dylib)$/i.test(n));
  for (const name of runtimeLibs) {
    fs.copyFileSync(path.join(releaseDir, name), path.join(OUT_DIR, name));
    console.log(`[vendor-sidecar] ${name} (${(fs.statSync(path.join(releaseDir, name)).size / 1024 / 1024).toFixed(2)} MB) — ort is linking dynamically now`);
  }

  console.log('[vendor-sidecar] done');
}

main();
