'use strict';

/*
  Rasterise the app icon master (src-tauri/icons/source-logo.svg) to a
  1024x1024 PNG, then feed it to `tauri icon` to regenerate every platform
  size (icon.ico, icon.png, the Square*Logo Store tiles, StoreLogo, etc).

  Run: npm run icon
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ICONS = path.join(__dirname, '..', 'src-tauri', 'icons');
const SRC = path.join(ICONS, 'source-logo.svg');
const MASTER = path.join(ICONS, 'app-icon.png');

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[gen-icon] missing source SVG: ${SRC}`);
    process.exit(1);
  }

  // density high enough that the 1024px SVG renders without upscaling blur.
  await sharp(SRC, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(MASTER);
  console.log(`[gen-icon] wrote ${path.relative(process.cwd(), MASTER)} (1024x1024)`);

  // Regenerate all platform icons from the master. tauri CLI lives in
  // node_modules/.bin; on Windows the launcher is a .cmd, which Node can only
  // spawn through a shell (execFileSync on a .cmd throws EINVAL otherwise).
  const bin = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
  const tauri = path.join(__dirname, '..', 'node_modules', '.bin', bin);
  console.log('[gen-icon] running tauri icon ...');
  execFileSync(tauri, ['icon', MASTER], { stdio: 'inherit', shell: process.platform === 'win32' });

  // tauri icon does not emit a wide Start-menu tile. Render it here (after
  // tauri icon, so nothing clobbers it) from the dedicated wide source.
  const WIDE_SRC = path.join(ICONS, 'source-wide.svg');
  if (fs.existsSync(WIDE_SRC)) {
    await sharp(WIDE_SRC, { density: 384 })
      .resize(310, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(ICONS, 'Wide310x150Logo.png'));
    console.log('[gen-icon] wrote Wide310x150Logo.png (310x150)');
  }
  console.log('[gen-icon] done — icon.ico + Square*Logo + Wide tile regenerated');
}

main().catch((err) => {
  console.error('[gen-icon] failed:', err.message);
  process.exit(1);
});
