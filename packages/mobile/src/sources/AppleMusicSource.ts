/**
 * Apple Music now-playing source, via MusicKit.
 *
 * NOT YET IMPLEMENTED NATIVELY. React Native has no first-party MusicKit
 * binding, so this needs a small native Swift module (e.g. exposed as
 * `NativeModules.MusicKitBridge`) that:
 *   1. Requests MusicKit authorization (`MusicAuthorization.request()`).
 *   2. Observes `SystemMusicPlayer.shared` (or `ApplicationMusicPlayer` if
 *      the app plays music itself) for now-playing item + elapsed time.
 *   3. Emits updates back to JS via `RCTEventEmitter` / Expo Modules API.
 *
 * Building and testing this requires Xcode on macOS — this file defines the
 * JS-side contract so the rest of the app (lyric matching, sync, UI) can be
 * built against a stable interface before the native side exists.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

interface MusicKitBridgeModule {
  isAuthorized(): Promise<boolean>;
  requestAuthorization(): Promise<boolean>;
  startObserving(): void;
  stopObserving(): void;
}

export class AppleMusicSource implements NowPlayingSource {
  readonly sourceApp = 'apple-music' as const;
  private emitterSub: { remove(): void } | null = null;

  private get native(): MusicKitBridgeModule {
    const mod = NativeModules.MusicKitBridge as MusicKitBridgeModule | undefined;
    if (!mod) {
      throw new Error(
        'MusicKitBridge native module not found — this requires the native Swift ' +
          'module to be implemented and the app built with Xcode. See this file\'s ' +
          'header comment for what that module needs to expose.'
      );
    }
    return mod;
  }

  async isAvailable(): Promise<boolean> {
    if (!NativeModules.MusicKitBridge) return false;
    return this.native.isAuthorized() || this.native.requestAuthorization();
  }

  start(onSample: (sample: NowPlayingSample) => void): void {
    const emitter = new NativeEventEmitter(NativeModules.MusicKitBridge);
    this.emitterSub = emitter.addListener('nowPlaying', (raw: Omit<NowPlayingSample, 'sourceApp'>) => {
      onSample({ ...raw, sourceApp: this.sourceApp });
    });
    this.native.startObserving();
  }

  stop(): void {
    this.native.stopObserving();
    this.emitterSub?.remove();
    this.emitterSub = null;
  }
}
