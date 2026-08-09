/**
 * Expo config plugin: copies the hand-written native bridge files
 * (../ios-native/*.swift, *.m) into the generated ios/ Xcode project during
 * `expo prebuild` / EAS Build, and registers them as source files on the
 * app target — so they don't need to be committed inside a generated ios/
 * folder, and rebuild automatically on every prebuild.
 *
 * NOT run/tested — written in a Linux environment with no Xcode, so the
 * `expo prebuild` step that would exercise this has never actually executed
 * here. This follows the standard @expo/config-plugins community pattern
 * for adding native source files (withDangerousMod to copy + withXcodeProject
 * to register), but verify the Xcode project actually builds after the
 * first real `expo prebuild -p ios` and fix anything this got wrong.
 *
 * Does NOT handle the SpotifyiOS.xcframework — that's a manual, one-time
 * Xcode step (see packages/mobile/README.md), since it requires downloading
 * a third-party binary this plugin has no business fetching automatically.
 */

const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject, withInfoPlist } = require('@expo/config-plugins');

// SpotifyAppRemoteBridge.swift `import`s SpotifyiOS, which only exists once
// the .xcframework is manually embedded in Xcode (see README.md) — until
// then, including it breaks the whole build. Set SKIP_SPOTIFY_NATIVE=1 to
// build Apple-Music-only while you don't have that framework in place yet.
const INCLUDE_SPOTIFY = process.env.SKIP_SPOTIFY_NATIVE !== '1';

const NATIVE_FILES = [
  'MusicKitBridge.swift',
  'MusicKitBridge.m',
  ...(INCLUDE_SPOTIFY ? ['SpotifyAppRemoteBridge.swift', 'SpotifyAppRemoteBridge.m'] : []),
];

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
    const group = project.findPBXGroupKey({ name: projectName }) || project.getFirstProject().firstProject.mainGroup;

    for (const file of NATIVE_FILES) {
      const alreadyPresent = Object.values(project.hash.project.objects.PBXFileReference || {}).some(
        (ref) => ref && ref.path === `"${file}"`
      );
      if (alreadyPresent) continue;
      project.addSourceFile(file, { target }, group);
    }
    return cfg;
  });
}

function withNowPlayingInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.LSApplicationQueriesSchemes = Array.from(
      new Set([...(cfg.modResults.LSApplicationQueriesSchemes || []), 'spotify', 'spotify-action'])
    );
    // Set your real Spotify Client ID here (or better, template it in from
    // an app.json `extra` field / EAS secret) before building — this
    // placeholder will not authenticate.
    cfg.modResults.SpotifyClientID = cfg.modResults.SpotifyClientID || 'REPLACE_WITH_SPOTIFY_CLIENT_ID';
    cfg.modResults.SpotifyRedirectURL = cfg.modResults.SpotifyRedirectURL || 'lyricplayer://spotify-callback';
    return cfg;
  });
}

module.exports = function withNativeSources(config) {
  config = withCopyNativeSources(config);
  config = withRegisterNativeSources(config);
  config = withNowPlayingInfoPlist(config);
  return config;
};
