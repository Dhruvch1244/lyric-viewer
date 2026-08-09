/**
 * iOS's analogue of the Windows app's SmtcWatcher (src/main/smtc.js).
 *
 * There is no SMTC equivalent on iOS — third-party apps cannot observe
 * another app's playback state system-wide, for sandboxing/privacy reasons.
 * So instead of one universal transport, each supported music app gets its
 * own `NowPlayingSource` implementation (Apple Music via MusicKit, Spotify
 * via App Remote), and `SourceArbiter` below picks whichever one is
 * currently reporting active playback — same idea as SmtcWatcher's single
 * stream, just fed by more than one transport.
 */

export type PlaybackStatus = 'Playing' | 'Paused' | 'Stopped';

export interface NowPlayingSample {
  title: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  status: PlaybackStatus;
  sourceApp: 'apple-music' | 'spotify';
}

export interface NowPlayingSource {
  readonly sourceApp: 'apple-music' | 'spotify';
  /** Whether this source's underlying app/SDK is available on this device right now. */
  isAvailable(): Promise<boolean>;
  /** Start observing playback state. `onSample` fires on every update. */
  start(onSample: (sample: NowPlayingSample) => void): void;
  /** Stop observing. */
  stop(): void;
}
