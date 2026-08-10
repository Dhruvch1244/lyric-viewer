/**
 * Metro config for the Expo (React Native) app inside an npm-workspaces
 * monorepo.
 *
 * Two jobs:
 *
 * 1. Monorepo resolution — Metro must watch the workspace root so it can
 *    resolve the hoisted `@lyric-viewer/core` package and root-hoisted
 *    node_modules, while still preferring this package's own node_modules.
 *
 * 2. Fence off the desktop app — the workspace root also holds the Electron/
 *    Windows build (root `src/main`, `src/renderer`, `dist`, `dist-installer`).
 *    That code `require`s Node/Electron built-ins ("path", "electron", ...)
 *    that do not exist in the React Native runtime. If Metro is ever pointed
 *    at the root (e.g. `expo start` run from the repo root instead of here),
 *    the root package.json `"main": "src/main/main.js"` drags the Electron
 *    entry into the bundle and the build dies with:
 *      'You attempted to import the Node standard library module "path"'.
 *    The blockList below makes those paths unresolvable for the mobile bundle,
 *    so that class of failure cannot happen regardless of launch directory.
 *
 * Always start the mobile app from THIS directory: `npm run start:go`
 * (Expo Go) or `npm start` (dev client).
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch the whole workspace so `@lyric-viewer/core` resolves, but resolve
//    modules from this package first, then the hoisted root.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// 2. Build a separator-agnostic sub-pattern matching everything under an
//    absolute directory (Windows `\` and POSIX `/`).
const dirPattern = (absDir) => {
  const escaped = absDir
    .replace(/[.*+?^${}()|[\]]/g, '\\$&') // escape regex metachars (not slashes)
    .replace(/[\\/]/g, '[\\\\/]'); // treat either separator interchangeably
  return escaped + '[\\\\/].*';
};

// Desktop-only trees at the workspace root that must never enter the RN
// bundle. `blockList` takes a single RegExp, so combine them with alternation.
config.resolver.blockList = new RegExp(
  '^(' +
    [
      dirPattern(path.join(workspaceRoot, 'src')), // Electron main + renderer
      dirPattern(path.join(workspaceRoot, 'dist')), // packaged Electron output
      dirPattern(path.join(workspaceRoot, 'dist-installer')), // NSIS installer
    ].join('|') +
    ')$'
);

module.exports = config;
