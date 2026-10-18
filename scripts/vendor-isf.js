'use strict';

/*
  Copy the ISF renderer bundle into the renderer's vendor directory.

  The renderer page has no bundler and loads plain <script> files, the same as
  butterchurn's bundles, so the prebuilt UMD build is used as-is: it exposes
  `window.interactiveShaderFormat` with `Renderer`/`Parser`. It contains no
  eval or `new Function` (mathjs-expression-parser is an interpreter), which is
  why it can run on the main page under its strict CSP — see shaders.js.

  Run when interactive-shader-format is upgraded; the output is committed.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'interactive-shader-format', 'dist', 'build.js');
const DEST = path.join(ROOT, 'src', 'renderer', 'vendor', 'isf.min.js');

const { version, license } = require(path.join(ROOT, 'node_modules', 'interactive-shader-format', 'package.json'));
const banner = `/*! interactive-shader-format ${version} (${license}) — https://github.com/msfeldstein/interactive-shader-format-js */\n`;
fs.writeFileSync(DEST, banner + fs.readFileSync(SRC, 'utf8'));
console.log(`wrote ${path.relative(ROOT, DEST)} (${version})`);
