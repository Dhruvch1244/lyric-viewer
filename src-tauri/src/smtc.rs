//! Native "now playing" detection via the WinRT SMTC API.
//!
//! Replaces `smtc-poll.ps1`, which did exactly this from a long-lived
//! **Windows PowerShell 5.1** child process that streamed JSON lines over a
//! pipe. That worked, but cost a measured ~92MB resident for the app's whole
//! life (17% of total footprint), wrote a script into the temp dir at every
//! startup, and welded the app to PowerShell 5.1 forever — the script's own
//! header documents that PowerShell 7 removed the WinRT type projection it
//! depended on.
//!
//! The `windows` crate already in use for wallpaper mode exposes the same API
//! directly, so none of that is necessary. Field-for-field this produces what
//! the script produced; `lib.rs` consumes a `Session` struct where it used to
//! parse `SmtcMessage` JSON, and emits the identical `track`/`tick`/`idle`
//! events downstream.

#![cfg(windows)]

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

/// 100ns ticks per millisecond. WinRT `TimeSpan.Duration` and
/// `DateTime.UniversalTime` are both in these units.
const TICKS_PER_MS: i64 = 10_000;

/// Seconds between the WinRT/FILETIME epoch (1601-01-01) and the Unix epoch.
const EPOCH_DELTA_SECS: i64 = 11_644_473_600;

/// `LastUpdatedTime` at or below 1601-01-02 means the source never set it.
/// Matches the old script's `-gt [datetime]::new(1601,1,2)` guard.
const UNSET_TIMESTAMP_TICKS: i64 = 864_000_000_000;

/// How often to re-read track metadata. Title/artist/album come from an async
/// call that is comparatively expensive, so it runs an order of magnitude less
/// often than the timeline read — same split the script used.
const PROPERTY_INTERVAL_MS: i64 = 1000;

/// One SMTC sample. Mirrors the JSON object `smtc-poll.ps1` used to emit, so
/// the consuming logic in `lib.rs` is unchanged.
#[derive(Clone, Default)]
pub struct Session {
    pub source_app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub position_ms: i64,
    pub end_ms: i64,
    /// Age of `position_ms` in ms when sampled; -1 when the source gave no
    /// usable timestamp. Consumers project forward from this rather than
    /// trusting a position that may be seconds stale.
    pub staleness_ms: i64,
}

/// Current UTC as 100ns ticks since 1601-01-01, the epoch WinRT `DateTime`
/// uses. Derived from `SystemTime` rather than `GetSystemTimeAsFileTime` so
/// this needs no extra windows-crate feature; both count the same ticks from
/// the same epoch.
fn now_winrt_ticks() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64 + EPOCH_DELTA_SECS) * 10_000_000 + (d.subsec_nanos() as i64) / 100,
        Err(_) => 0,
    }
}

/// The enum's own name, matching PowerShell's `PlaybackStatus.ToString()` —
/// the renderer compares this against the literal "Playing".
fn status_name(status: PlaybackStatus) -> &'static str {
    match status {
        PlaybackStatus::Closed => "Closed",
        PlaybackStatus::Opened => "Opened",
        PlaybackStatus::Changing => "Changing",
        PlaybackStatus::Stopped => "Stopped",
        PlaybackStatus::Playing => "Playing",
        PlaybackStatus::Paused => "Paused",
        // The enum is a plain i32 newtype, so an unrecognised value is
        // representable. Report it as stopped rather than inventing a name
        // the renderer has no branch for.
        _ => "Stopped",
    }
}

/// Holds the session manager and the metadata cache across polls.
pub struct Watcher {
    manager: SessionManager,
    cached_app: Option<String>,
    cached_title: String,
    cached_artist: String,
    cached_album: String,
    last_property_fetch_ms: i64,
}

impl Watcher {
    /// Connect to the system session manager. Fails only if WinRT itself is
    /// unavailable, in which case the caller leaves now-playing detection off
    /// rather than retrying forever.
    pub fn new() -> windows::core::Result<Self> {
        let manager = SessionManager::RequestAsync()?.get()?;
        Ok(Watcher {
            manager,
            cached_app: None,
            cached_title: String::new(),
            cached_artist: String::new(),
            cached_album: String::new(),
            last_property_fetch_ms: 0,
        })
    }

    /// Sample the current session. `Ok(None)` means nothing is playing on the
    /// system; `Err` is a transient WinRT hiccup the caller should skip rather
    /// than treat as "playback stopped" — reporting idle on a blip would clear
    /// the current track and re-trigger a whole lyric lookup.
    pub fn poll(&mut self) -> windows::core::Result<Option<Session>> {
        let session = match self.manager.GetCurrentSession() {
            Ok(s) => s,
            // No active session at all: this is the normal "nothing playing"
            // path, not a failure.
            Err(_) => {
                self.cached_app = None;
                return Ok(None);
            }
        };

        let source_app = session.SourceAppUserModelId()?.to_string_lossy();

        // Re-read metadata when the source app changed or the refresh window
        // elapsed, so switching apps updates the track immediately instead of
        // waiting out the interval.
        let now_ms = now_winrt_ticks() / TICKS_PER_MS;
        let app_changed = self.cached_app.as_deref() != Some(source_app.as_str());
        if app_changed || now_ms - self.last_property_fetch_ms >= PROPERTY_INTERVAL_MS {
            let props = session.TryGetMediaPropertiesAsync()?.get()?;
            self.cached_title = props.Title().map(|s| s.to_string_lossy()).unwrap_or_default();
            self.cached_artist = props.Artist().map(|s| s.to_string_lossy()).unwrap_or_default();
            self.cached_album = props.AlbumTitle().map(|s| s.to_string_lossy()).unwrap_or_default();
            self.cached_app = Some(source_app.clone());
            self.last_property_fetch_ms = now_ms;
        }

        let timeline = session.GetTimelineProperties()?;
        let playback = session.GetPlaybackInfo()?;

        // SMTC does not tick Position continuously — most apps only push a new
        // timeline on play/pause/seek. LastUpdatedTime says when the value was
        // actually captured, so the consumer can project forward from it.
        let staleness_ms = match timeline.LastUpdatedTime() {
            Ok(t) if t.UniversalTime > UNSET_TIMESTAMP_TICKS => {
                ((now_winrt_ticks() - t.UniversalTime) / TICKS_PER_MS).max(0)
            }
            _ => -1,
        };

        Ok(Some(Session {
            source_app,
            title: self.cached_title.clone(),
            artist: self.cached_artist.clone(),
            album: self.cached_album.clone(),
            status: status_name(playback.PlaybackStatus()?).to_string(),
            position_ms: timeline.Position()?.Duration / TICKS_PER_MS,
            end_ms: timeline.EndTime()?.Duration / TICKS_PER_MS,
            staleness_ms,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_names_match_the_powershell_tostring_output() {
        // The renderer branches on the literal "Playing"; the rest are carried
        // through to the UI as-is, so the spellings are a real contract.
        assert_eq!(status_name(PlaybackStatus::Playing), "Playing");
        assert_eq!(status_name(PlaybackStatus::Paused), "Paused");
        assert_eq!(status_name(PlaybackStatus::Stopped), "Stopped");
        assert_eq!(status_name(PlaybackStatus::Closed), "Closed");
        assert_eq!(status_name(PlaybackStatus::Opened), "Opened");
        assert_eq!(status_name(PlaybackStatus::Changing), "Changing");
    }

    #[test]
    fn an_out_of_range_status_degrades_to_stopped() {
        // It is an i32 newtype, not a closed enum — a future Windows value
        // must not panic or produce a name nothing handles.
        assert_eq!(status_name(PlaybackStatus(99)), "Stopped");
    }

    #[test]
    fn winrt_epoch_conversion_lands_in_a_sane_range() {
        let ticks = now_winrt_ticks();
        // 2020-01-01 and 2100-01-01 as WinRT ticks — a conversion that got the
        // epoch or the unit wrong lands orders of magnitude outside this.
        assert!(ticks > 132_223_104_000_000_000, "before 2020: epoch/unit wrong");
        assert!(ticks < 157_474_080_000_000_000, "after 2100: epoch/unit wrong");
    }

    #[test]
    fn the_unset_timestamp_sentinel_is_one_day_of_ticks() {
        // Guards the 1601-01-02 threshold the old script used.
        assert_eq!(UNSET_TIMESTAMP_TICKS, 24 * 60 * 60 * 10_000_000);
    }

    /// Reads the real system session. Cross-check the printed values against
    /// `npm run probe`, which asks Windows the same questions through the old
    /// PowerShell path — the two must agree, since agreeing is the entire
    /// claim this port makes.
    #[test]
    #[ignore] // live system state — run with `cargo test -- --ignored`
    fn live_matches_what_windows_reports() {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut watcher = Watcher::new().expect("WinRT session manager should be reachable");
        match watcher.poll().expect("poll should not error") {
            Some(s) => {
                eprintln!(
                    "sourceApp={} title={:?} artist={:?} album={:?}",
                    s.source_app, s.title, s.artist, s.album
                );
                eprintln!(
                    "status={} positionMs={} endMs={} stalenessMs={}",
                    s.status, s.position_ms, s.end_ms, s.staleness_ms
                );
                // Shape checks that hold for any real session, whatever is
                // playing — a units or epoch mistake breaks these even though
                // the exact values differ run to run.
                assert!(!s.source_app.is_empty(), "a real session always names its app");
                assert!(s.position_ms >= 0, "negative position means a units error");
                assert!(s.end_ms >= 0, "negative duration means a units error");
                assert!(
                    s.staleness_ms == -1 || s.staleness_ms < 86_400_000,
                    "staleness of a day+ means the epoch conversion is wrong, got {}",
                    s.staleness_ms
                );
            }
            None => eprintln!("no active media session — start playback and re-run"),
        }
    }
}
