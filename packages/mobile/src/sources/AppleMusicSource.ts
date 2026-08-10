/**
 * Apple Music now-playing source.
 *
 * Backed by the native Swift module in ios-native/MusicKitBridge.swift, which
 * reads `MPMusicPlayerController.systemMusicPlayer` (the Music app's app-wide
 * playback state) and exposes, as `NativeModules.MusicKitBridge`:
 *   - isAuthorized() / requestAuthorization() — Media Library permission
 *     (NSAppleMusicUsageDescription, set in app.json).
 *   - a "nowPlaying" RCTEventEmitter event shaped like NowPlayingSample.
 *
 * Observation is driven by the emitter's listener lifecycle: adding the
 * listener (start) begins observation natively, removing it (stop) ends it.
 *
 * The native module only exists in a real dev-client / production build (EAS
 * Build); in Expo Go `NativeModules.MusicKitBridge` is undefined, isAvailable
 * returns false, and MockSource stands in. See packages/mobile/README.md for
 * the build steps.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

interface MusicKitBridgeModule {
  isAuthorized(): Promise<boolean>;
  requestAuthorization(): Promise<boolean>;
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
    // `||` on two Promises is always truthy — must await, or the permission
    // prompt (requestAuthorization) never fires when not yet authorized.
    if (await this.native.isAuthorized()) return true;
    return this.native.requestAuthorization();
  }

  start(onSample: (sample: NowPlayingSample) => void): void {
    // Adding the listener triggers the native RCTEventEmitter's startObserving
    // lifecycle hook, which begins Music-app playback observation; removing it
    // (stop) triggers stopObserving. No explicit start/stop bridge calls.
    const emitter = new NativeEventEmitter(NativeModules.MusicKitBridge);
    this.emitterSub = emitter.addListener('nowPlaying', (raw: Omit<NowPlayingSample, 'sourceApp'>) => {
      onSample({ ...raw, sourceApp: this.sourceApp });
    });
  }

  stop(): void {
    this.emitterSub?.remove();
    this.emitterSub = null;
  }
}
