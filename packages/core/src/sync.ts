/**
 * Playback-position estimation math, decoupled from any specific transport.
 *
 * Windows' SMTC only refreshes `positionMs` on discrete events (play/pause/
 * seek), so a naive read lags badly during playback — the poller reports how
 * *old* each sample was (`stalenessMs`) and we project forward from it. iOS
 * sources (MusicKit, Spotify App Remote) have the same shape of problem —
 * whatever the transport, "position we last heard" + "time elapsed since we
 * heard it" is the estimate — so this logic is shared rather than
 * reimplemented per platform.
 */

export interface StalenessSample {
  status: 'Playing' | 'Paused' | 'Stopped' | string;
  positionMs: number;
  /** How old `positionMs` was when sampled, in ms. -1/absent means unknown. */
  stalenessMs?: number;
  /** Track duration in ms, if known. Used to clamp the projected position. */
  endMs?: number;
}

/**
 * Best-effort current playback position, corrected for sample staleness.
 * Mirrors `SmtcWatcher#estimatePositionMs` from the Windows app's smtc.js.
 */
export function estimateFromStaleness(sample: StalenessSample | null): number | null {
  if (!sample) return null;
  if (sample.status !== 'Playing') return sample.positionMs;

  // Ignore absent (-1), negative, or implausibly large staleness values.
  const raw = sample.stalenessMs;
  const staleness = Number.isFinite(raw) && (raw as number) >= 0 && (raw as number) < 30_000 ? (raw as number) : 0;

  const projected = sample.positionMs + staleness;
  return sample.endMs && sample.endMs > 0 ? Math.min(projected, sample.endMs) : projected;
}

/**
 * Anchor-based position estimator: given a known position at a known clock
 * time, project the current position forward while playing. Mirrors the
 * renderer's `estimatePosition()` in src/renderer/renderer.js — used on the
 * UI/render side where you want continuous interpolation between discrete
 * ticks rather than re-deriving from staleness on every frame.
 */
export class PositionAnchor {
  private anchorPositionMs = 0;
  private anchorAt = 0;
  private status: 'Playing' | 'Paused' | 'Stopped' | string = 'Stopped';

  /** @param now Clock reader, e.g. `performance.now` or `Date.now`. Defaults to `Date.now`. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Record a fresh sample: position we know to be accurate as of right now. */
  set(positionMs: number, status: 'Playing' | 'Paused' | 'Stopped' | string): void {
    this.anchorPositionMs = positionMs;
    this.anchorAt = this.now();
    this.status = status;
  }

  /** Project the current position forward from the last anchor. */
  estimateMs(): number {
    if (this.status !== 'Playing') return this.anchorPositionMs;
    return this.anchorPositionMs + (this.now() - this.anchorAt);
  }
}
