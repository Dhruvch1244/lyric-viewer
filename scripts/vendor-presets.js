#!/usr/bin/env node
'use strict';

/*
  Vendor the full MilkDrop preset corpus into src/renderer/vendor/presets.

  WHY. 0.19.0 shipped four minified preset bundles holding 395 unique presets,
  and that was taken to be the catalogue. It is not: `butterchurn-presets` also
  ships `presets/converted`, the 1754 presets those bundles were built from.
  1360 looks — nearly four times what the app offered — were sitting in
  node_modules unexposed, on the axis the whole visualiser category is judged
  on.

  WHY FILES RATHER THAN A FIFTH BUNDLE. 13MB of preset JSON parsed into the
  renderer at startup, to show one preset at a time, is the wrong shape. As
  files they are read on demand by main and cross to the frame one at a time,
  so the resident cost is a name list. Measured: the corpus is 13MB raw and
  1.2MB compressed, against the 1.7MB of minified bundles this replaces — so
  4.4x the presets costs the installer approximately nothing.

  WHY NUMBERED FILENAMES. Preset names are arbitrary text written by strangers
  in 2003 — `$$$ Royal - Mashup (160)`, `!!!---flexi + amandio c - organic12`.
  Some contain characters Windows will not accept in a path, and any scheme
  that derives a path from a name has to be audited for traversal. Numbering
  them and keeping the name in an index removes both problems: main resolves a
  filename by looking the name up, never by building a path from it.

  Usage:  node scripts/vendor-presets.js
  Run when butterchurn-presets is upgraded; the output is committed.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'butterchurn-presets', 'presets', 'converted');
const OUT = path.join(ROOT, 'src', 'renderer', 'vendor', 'presets');

if (!fs.existsSync(SRC)) {
  console.error(`No preset corpus at ${SRC}\nRun \`npm install\` first.`);
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`No .json presets in ${SRC}`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const presets = [];
let bytes = 0;
let skipped = 0;

files.forEach((file) => {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8');

  /*
    Parsed rather than copied, because a preset that will not parse is worse
    than a missing one: it reaches the engine, throws inside the render loop,
    and the frame's recovery path steps to the next preset every frame forever.
    Better to find it here, once, at build time.
  */
  try {
    JSON.parse(raw);
  } catch (err) {
    console.warn(`  skipped ${file}: ${err.message}`);
    skipped += 1;
    return;
  }

  const name = file.replace(/\.json$/, '');
  const out = `${String(presets.length).padStart(4, '0')}.json`;
  fs.writeFileSync(path.join(OUT, out), raw);
  presets.push({ name, file: out });
  bytes += raw.length;
});

const index = { version: 1, count: presets.length, presets };
fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index)}\n`);

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`Vendored ${presets.length} presets (${mb}MB) to ${path.relative(ROOT, OUT)}`);
if (skipped) console.log(`${skipped} would not parse and were left out.`);
