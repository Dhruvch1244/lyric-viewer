/**
 * Picks whichever registered NowPlayingSource is actively reporting
 * playback and re-emits a single stream — the iOS analogue of
 * src/main/smtc.js's SmtcWatcher, just fed by more than one transport
 * (Apple Music, Spotify) instead of one OS-level API.
 *
 * Position estimation reuses @lyric-viewer/core's PositionAnchor rather than
 * reimplementing the anchor-projection math per platform.
 */

import { PositionAnchor } from '@lyric-viewer/core';
import type { NowPlayingSample, NowPlayingSource } from './NowPlayingSource';

export interface ArbitratedTrack {
  title: string;
  artist: string;
  durationMs: number;
  sourceApp: NowPlayingSample['sourceApp'];
}

export interface ArbitratedTick {
  status: NowPlayingSample['status'];
  positionMs: number;
  durationMs: number;
}

export interface SourceArbiterCallbacks {
  onTrack(track: ArbitratedTrack): void;
  onTick(tick: ArbitratedTick): void;
  onIdle(): void;
}

export class SourceArbiter {
  private readonly anchor = new PositionAnchor();
  private currentKey: string | null = null;
  private activeSource: NowPlayingSource['sourceApp'] | null = null;

  constructor(
    private readonly sources: NowPlayingSource[],
    private readonly callbacks: SourceArbiterCallbacks
  ) {}

  async start(): Promise<void> {
    for (const source of this.sources) {
      if (await source.isAvailable()) {
        source.start((sample) => this.handleSample(source.sourceApp, sample));
      }
    }
  }

  stop(): void {
    for (const source of this.sources) source.stop();
  }

  private handleSample(sourceApp: NowPlayingSource['sourceApp'], sample: NowPlayingSample): void {
    // Playing takes priority; a paused/stopped source shouldn't preempt a
    // different source that's actively playing.
    if (this.activeSource && this.activeSource !== sourceApp && sample.status !== 'Playing') {
      return;
    }
    this.activeSource = sample.status === 'Playing' ? sourceApp : this.activeSource;

    const key = `${sample.artist}|${sample.title}`;
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.callbacks.onTrack({
        title: sample.title,
        artist: sample.artist,
        durationMs: sample.durationMs,
        sourceApp,
      });
    }

    this.anchor.set(sample.positionMs, sample.status);
    this.callbacks.onTick({
      status: sample.status,
      positionMs: this.anchor.estimateMs(),
      durationMs: sample.durationMs,
    });

    if (sample.status === 'Stopped') {
      this.currentKey = null;
      this.activeSource = null;
      this.callbacks.onIdle();
    }
  }
}
