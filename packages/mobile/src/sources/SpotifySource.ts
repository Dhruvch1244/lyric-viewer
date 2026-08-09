/**
 * Spotify now-playing source, via the Spotify iOS SDK's App Remote.
 *
 * NOT YET IMPLEMENTED NATIVELY. Requires:
 *   1. A Spotify Developer app registration (client ID + registered
 *      redirect URI) — the user needs to create this at
 *      developer.spotify.com/dashboard.
 *   2. The Spotify iOS SDK (SpotifyiOS.xcframework) linked into the Xcode
 *      project, wrapped in a small native module (e.g.
 *      `NativeModules.SpotifyAppRemoteBridge`) that connects
 *      `SPTAppRemote`, subscribes to `playerAPI.delegate` player-state
 *      updates, and emits them back to JS the same way AppleMusicSource does.
 *
 * Building and testing this requires Xcode on macOS plus a registered
 * Spotify app — this file defines the JS-side contract so the rest of the
 * app can be built against a stable interface before the native side exists.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

interface SpotifyAppRemoteBridgeModule {
  isConnected(): Promise<boolean>;
  connect(): Promise<boolean>;
  disconnect(): void;
}

export class SpotifySource implements NowPlayingSource {
  readonly sourceApp = 'spotify' as const;
  private emitterSub: { remove(): void } | null = null;

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
    return this.native.isConnected() || this.native.connect();
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
  }
}
