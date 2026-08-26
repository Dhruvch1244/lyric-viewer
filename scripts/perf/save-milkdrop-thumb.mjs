#!/usr/bin/env node
/*
  Save one or more MilkDrop preset thumbnails to disk as PNG, for manually
  spot-checking curate-milkdrop-presets.mjs's picks and rejects against actual
  pixels rather than trusting the luminance/texture heuristic blind.

  Usage:
    node scripts/perf/save-milkdrop-thumb.mjs "Geiss - Artifact Plasma" "Flexi - alien fish pond"

  Writes runs/thumbs/<sanitised name>.png for each.
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, REPO_ROOT } from './launch.mjs';
import { attachToApp } from './cdp.mjs';

const PORT = 9299;
const OUT_DIR = join(REPO_ROOT, 'scripts', 'perf', 'runs', 'thumbs');

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: node scripts/perf/save-milkdrop-thumb.mjs <preset name> [more names...]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const profileDir = join(REPO_ROOT, 'scripts', 'perf', 'runs', 'thumb-profile');
const { stop } = launchApp({ port: PORT, build: 'dev', profileDir, verbose: false });

try {
  const { session } = await attachToApp(PORT, 300_000);
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await session.evaluate(`
      presetId = 'milkdrop';
      playbackStatus = 'Playing';
      if (typeof currentTrack === 'undefined' || !currentTrack) currentTrack = { title: 'x', artist: 'x' };
      anchorPositionMs = 0; anchorAt = performance.now();
      return typeof activeEngine === 'string' && activeEngine === 'milkdrop' && window.MilkDrop && window.MilkDrop.isSupported();
    `).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) throw new Error('MilkDrop engine never came up');

  for (const name of names) {
    let url;
    try {
      url = await session.evaluate(
        `return (async () => window.MilkDrop.thumbnail(${JSON.stringify(name)}))();`,
        { awaitPromise: true }
      );
    } catch (err) {
      console.warn(`  failed on "${name}": ${err.message}`);
      continue;
    }
    if (!url) { console.warn(`  no thumbnail for: ${name}`); continue; }
    const base64 = url.replace(/^data:image\/jpeg;base64,/, '');
    const safe = name.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
    const outPath = join(OUT_DIR, `${safe}.jpg`);
    writeFileSync(outPath, Buffer.from(base64, 'base64'));
    console.log(`  ${outPath}`);
  }
} finally {
  await stop();
}
process.exit(0);
