#!/usr/bin/env node
'use strict';

/*
  Upload the built installer AND its update manifest to the matching GitHub
  release.

  This exists because of a silent failure. v0.19.0 shipped auto-update and was
  published with only the .exe attached; `latest.yml` is what electron-updater
  actually reads, so without it every client's update check finds nothing and
  the feature does nothing at all — with no error anywhere to notice. That is a
  bad failure mode to leave to memory on every release.

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

const missing = [installer, manifest].filter((f) => !fs.existsSync(f));
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

console.log(`Uploading to ${tag}:`);
console.log('  ' + path.basename(installer));
console.log('  ' + path.basename(manifest));

execFileSync('gh', ['release', 'upload', tag, installer, manifest, '--clobber'], {
  stdio: 'inherit',
  cwd: ROOT,
});

console.log('Done. Auto-update reads latest.yml, so it is not optional.');
