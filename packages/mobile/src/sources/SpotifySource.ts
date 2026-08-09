/**
 * Spotify now-playing source, via the Spotify iOS SDK's App Remote.
 *
 * The native side (ios-native/SpotifyAppRemoteBridge.swift) owns the App
 * Remote connection and player-state subscription. The OAuth *callback* is
 * handled here in JS instead, using React Native's `Linking` module —
 * Expo's default AppDelegate already forwards every `openURL` call to JS, so
 * no native AppDelegate patching is needed. `connect()` triggers the native
 * side to open Spotify for authorization; when Spotify redirects back with
 * an access token, this listener extracts it and hands it to the native
 * module via `setAccessToken`.
 *
 * Setup this depends on (see packages/mobile/README.md for the full
 * checklist):
 *   1. A Spotify Developer app registration (developer.spotify.com/dashboard)
 *      — gives you a Client ID and lets you register the redirect URI.
 *   2. `SpotifyClientID` and `SpotifyRedirectURL` in the iOS Info.plist
 *      (wired via app.json's `extra`/config plugin, not hardcoded here).
 *   3. The SpotifyiOS.xcframework manually embedded in Xcode — this is the
 *      one step that can't be scripted from this Linux environment.
 */

import { Linking, NativeEventEmitter, NativeModules } from 'react-native';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

interface SpotifyAppRemoteBridgeModule {
  isConnected(): Promise<boolean>;
  connect(): Promise<boolean>;
  disconnect(): void;
  setAccessToken(token: string): void;
}

/**
 * Spotify's App Remote auth flow redirects back with the token in the URL
 * *fragment* (e.g. `lyricplayer://spotify-callback#access_token=...&...`),
 * which RN's `Linking` doesn't parse for you.
 */
function parseAccessToken(url: string): string | null {
  const fragmentIndex = url.indexOf('#');
  if (fragmentIndex === -1) return null;
  const params = new URLSearchParams(url.slice(fragmentIndex + 1));
  return params.get('access_token');
}

export class SpotifySource implements NowPlayingSource {
  readonly sourceApp = 'spotify' as const;
  private emitterSub: { remove(): void } | null = null;
  private linkingSub: { remove(): void } | null = null;

  private get native(): SpotifyAppRemoteBridgeModule {
    const mod = NativeModules.SpotifyAppRemoteBridge as SpotifyAppRemoteBridgeModule | undefined;
    if (!mod) {
      throw new Error(
        'SpotifyAppRemoteBridge native module not found — this requires the native ' +
          'Swift module + Spotify iOS SDK to be integrated and the app built with ' +
          "Xcode. See this file's header comment for setup steps."
      );
    }
    return mod;
  }

  async isAvailable(): Promise<boolean> {
    if (!NativeModules.SpotifyAppRemoteBridge) return false;
    if (await this.native.isConnected()) return true;

    this.linkingSub = Linking.addEventListener('url', ({ url }) => {
      const token = parseAccessToken(url);
      if (token) this.native.setAccessToken(token);
    });
    return this.native.connect();
  }

  start(onSample: (sample: NowPlayingSample) => void): void {
    const emitter = new NativeEventEmitter(NativeModules.SpotifyAppRemoteBridge);
    this.emitterSub = emitter.addListener('nowPlaying', (raw: Omit<NowPlayingSample, 'sourceApp'>) => {
      onSample({ ...raw, sourceApp: this.sourceApp });
    });
  }

  stop(): void {
    this.native.disconnect();
    this.emitterSub?.remove();
    this.emitterSub = null;
    this.linkingSub?.remove();
    this.linkingSub = null;
  }
}
