#!/usr/bin/env node
'use strict';

/*
  Upload the built installer, its update manifest AND its blockmap to the
  matching GitHub release.

  This exists because of a silent failure. v0.19.0 shipped auto-update and was
  published with only the .exe attached; `latest.yml` is what electron-updater
  actually reads, so without it every client's update check finds nothing and
  the feature does nothing at all — with no error anywhere to notice. That is a
  bad failure mode to leave to memory on every release.

  v0.20.0 fixed the manifest and left the same hole one file over. electron-
  updater downloads an NSIS update *differentially*: it fetches
  `<installer>.exe.blockmap` for both the installed build and the new one, and
  transfers only the chunks that differ. Ours was never uploaded, so that fetch
  404s on every client. It does fall back to a full download, which is why this
  is a slow bug rather than a dead one — but the fallback re-downloads all
  114MB for what is usually a few MB of changed chunks, on an app that ships
  most days. The blockmap is written by the same electron-builder run; there is
  no reason not to publish it.

  Usage:  node scripts/release-assets.js [--tag v0.19.0]

  Defaults to `v` + the version in package.json, which is the convention this
  repo already follows.
*/

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist-installer');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tag = arg('--tag') || `v${version}`;

const installer = path.join(DIST, `LyricOverlay-Setup-${version}.exe`);
const manifest = path.join(DIST, 'latest.yml');
const blockmap = `${installer}.blockmap`;

const missing = [installer, manifest, blockmap].filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error('Missing build output — run `npm run dist:win` first:');
  for (const f of missing) console.error('  ' + f);
  process.exit(1);
}

/*
  Guard against uploading a manifest that describes a different build than the
  installer beside it. They are written by the same electron-builder run, so a
  mismatch means one of them is stale — and a stale manifest points every
  client at a file whose checksum will not match, which fails mid-download.
*/
const declared = /^version:\s*(.+)$/m.exec(fs.readFileSync(manifest, 'utf8'));
if (!declared || declared[1].trim() !== version) {
  console.error(`latest.yml declares ${declared ? declared[1].trim() : '(unknown)'}, `
    + `but package.json is ${version}. Rebuild before publishing.`);
  process.exit(1);
}

const assets = [installer, manifest, blockmap];

console.log(`Uploading to ${tag}:`);
for (const f of assets) console.log('  ' + path.basename(f));

execFileSync('gh', ['release', 'upload', tag, ...assets, '--clobber'], {
  stdio: 'inherit',
  cwd: ROOT,
});

console.log('Done. Auto-update reads latest.yml and the blockmap; neither is optional.');
