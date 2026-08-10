/**
 * Demo now-playing source for environments without the native playback
 * bridges — chiefly Expo Go, which cannot load custom native modules
 * (MusicKitBridge / SpotifyAppRemoteBridge). Without this, the arbiter finds
 * zero available sources in Expo Go and the UI hangs on "waiting for
 * playback…" forever (see NowPlayingSource.ts for why iOS has no universal
 * transport, and AppleMusicSource.ts / SpotifySource.ts for the native
 * modules this stands in for).
 *
 * It emits a fixed, real track so the full pipeline exercises end to end —
 * LRCLIB lyric lookup, palette, cue-boundary detection, drops/build-ups, the
 * whole Starfield + LyricColumn visual system — against a synthetic but
 * honest ("· demo" in the header) playback clock that loops.
 *
 * `isAvailable()` returns true ONLY when neither native bridge is present, so
 * in a real dev-client / production build this source is inert and the actual
 * Apple Music / Spotify sources take over. Nothing to remove before shipping.
 */

import { NativeModules } from 'react-native';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

/**
 * A track LRCLIB reliably has synced (word-timed) lyrics for, so the demo
 * shows scrolling lyrics rather than "no synced lyrics found". Edit these two
 * fields to demo with any song — matching is by title + artist.
 */
const DEMO_TRACK = {
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  durationMs: 200_040, // 3:20
};

const TICK_INTERVAL_MS = 1000;

export class MockSource implements NowPlayingSource {
  readonly sourceApp = 'demo' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  /** Only stand in when the real native bridges are absent (e.g. Expo Go). */
  async isAvailable(): Promise<boolean> {
    const hasNativeBridge =
      !!NativeModules.MusicKitBridge || !!NativeModules.SpotifyAppRemoteBridge;
    return !hasNativeBridge;
  }

  start(onSample: (sample: NowPlayingSample) => void): void {
    this.startedAt = Date.now();

    const emit = () => {
      // Loop the playhead so the demo runs indefinitely.
      const positionMs = (Date.now() - this.startedAt) % DEMO_TRACK.durationMs;
      onSample({
        title: DEMO_TRACK.title,
        artist: DEMO_TRACK.artist,
        durationMs: DEMO_TRACK.durationMs,
        positionMs,
        status: 'Playing',
        sourceApp: this.sourceApp,
      });
    };

    emit(); // fire immediately so the UI leaves "waiting for playback…" at once
    this.timer = setInterval(emit, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
