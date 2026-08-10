/**
 * Expo config plugin: copies the hand-written Apple Music native bridge
 * (../ios-native/MusicKitBridge.{swift,m}) into the generated ios/ Xcode
 * project during `expo prebuild` / EAS Build, and registers the files as
 * sources on the app target — so they don't need to be committed inside a
 * generated ios/ folder, and rebuild automatically on every prebuild.
 *
 * Apple Music only. Spotify support is intentionally excluded from the build:
 * SpotifyAppRemoteBridge.swift `import`s the SpotifyiOS xcframework, which is
 * a manual, non-scriptable Xcode step (see packages/mobile/README.md). Its
 * source files remain in ios-native/ but are NOT compiled — re-add them here
 * (and embed the framework) if Spotify is revived later.
 *
 * NOT run/tested — written in a Linux environment with no Xcode, so the
 * `expo prebuild` step that would exercise this has never actually executed
 * here. This follows the standard @expo/config-plugins community pattern for
 * adding native source files (withDangerousMod to copy + withXcodeProject to
 * register); verify the Xcode project builds after the first real EAS Build
 * and fix anything this got wrong.
 */

const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

const NATIVE_FILES = ['MusicKitBridge.swift', 'MusicKitBridge.m'];

const SOURCE_DIR = path.join(__dirname, '..', 'ios-native');

function withCopyNativeSources(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const iosRoot = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      fs.mkdirSync(iosRoot, { recursive: true });
      for (const file of NATIVE_FILES) {
        fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(iosRoot, file));
      }
      return cfg;
    },
  ]);
}

function withRegisterNativeSources(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const target = project.getFirstTarget().uuid;
    const group =
      project.findPBXGroupKey({ name: projectName }) ||
      project.getFirstProject().firstProject.mainGroup;

    for (const file of NATIVE_FILES) {
      const alreadyPresent = Object.values(
        project.hash.project.objects.PBXFileReference || {}
      ).some((ref) => ref && ref.path === `"${file}"`);
      if (alreadyPresent) continue;
      project.addSourceFile(file, { target }, group);
    }
    return cfg;
  });
}

module.exports = function withNativeSources(config) {
  config = withCopyNativeSources(config);
  config = withRegisterNativeSources(config);
  return config;
};
