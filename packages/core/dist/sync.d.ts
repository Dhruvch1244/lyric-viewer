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
export declare function estimateFromStaleness(sample: StalenessSample | null): number | null;
/**
 * Anchor-based position estimator: given a known position at a known clock
 * time, project the current position forward while playing. Mirrors the
 * renderer's `estimatePosition()` in src/renderer/renderer.js — used on the
 * UI/render side where you want continuous interpolation between discrete
 * ticks rather than re-deriving from staleness on every frame.
 */
export declare class PositionAnchor {
    private readonly now;
    private anchorPositionMs;
    private anchorAt;
    private status;
    /** @param now Clock reader, e.g. `performance.now` or `Date.now`. Defaults to `Date.now`. */
    constructor(now?: () => number);
    /** Record a fresh sample: position we know to be accurate as of right now. */
    set(positionMs: number, status: 'Playing' | 'Paused' | 'Stopped' | string): void;
    /** Project the current position forward from the last anchor. */
    estimateMs(): number;
}
