//! Long-lived background threads: SMTC "now playing" polling, and the two
//! wallpaper-mode watchers (pointer forwarding, battery/lock/fullscreen
//! power state). Each is started once from `run()`'s setup hook and runs for
//! the app's life, gated on/off by an atomic flag rather than being spawned
//! and killed — see the module-level threading notes in lib.rs's history for
//! why that shape was chosen over tearing threads down and rebuilding them.

use tauri::AppHandle;

#[cfg(windows)]
use std::sync::atomic::Ordering;
#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
use serde_json::json;
#[cfg(windows)]
use tauri::{Emitter, Manager};

#[cfg(windows)]
use crate::commands::artwork_cmds::resolve_artwork;
#[cfg(windows)]
use crate::commands::lyrics_cmds::resolve_lyrics;
#[cfg(windows)]
use crate::state::{LOCAL_ACTIVE, WALLPAPER_ATTACHED, WALLPAPER_SURFACED, WALLPAPER_SUSPENDED};

/// How often to sample the timeline. Unchanged from the old poller's default.
#[cfg(windows)]
const SMTC_INTERVAL_MS: u64 = 250;

/// Best-effort current position, projecting past SMTC's stale `positionMs` while
/// playing — mirrors `estimatePositionMs` in the old smtc.js.
///
/// Most source apps only push a fresh timeline on play/pause/seek, not
/// continuously, so `staleness_ms` routinely climbs into the minutes for any
/// song that plays through without an interaction — that is the NORMAL case,
/// not a bad reading. A previous version capped staleness at 30s and fell
/// back to the raw (un-projected) position past that, which froze the
/// reported position — and every synced lyric on screen — for the rest of
/// the track. Only `staleness_ms == -1` (the source never set a timestamp at
/// all, per smtc.rs) is actually untrustworthy; `end_ms` below is what
/// keeps a legitimately large staleness from reporting past the track's end.
#[cfg(windows)]
fn estimate_position(s: &crate::smtc::Session) -> i64 {
    if s.status != "Playing" {
        return s.position_ms;
    }
    let staleness = if s.staleness_ms >= 0 { s.staleness_ms } else { 0 };
    let projected = s.position_ms + staleness;
    if s.end_ms > 0 {
        projected.min(s.end_ms)
    } else {
        projected
    }
}

/// Emit `track` (only when the song actually changed) and always `tick` for
/// one sample, exactly the shape the poll loop and `resync_smtc` both need —
/// pulled out so there is exactly one place that builds these events rather
/// than two copies that could quietly drift apart.
#[cfg(windows)]
pub(crate) fn emit_smtc_sample(app: &AppHandle, s: &crate::smtc::Session, current_key: &mut Option<String>) {
    let key = format!("{} {}", s.artist, s.title);
    if current_key.as_deref() != Some(key.as_str()) {
        *current_key = Some(key);
        let _ = app.emit(
            "track",
            json!({
                "title": s.title,
                "artist": s.artist,
                "album": s.album,
                "sourceApp": s.source_app,
                "durationMs": s.end_ms,
            }),
        );
        // Kick off the lyric + artwork lookups for the new song.
        resolve_lyrics(app.clone(), s.title.clone(), s.artist.clone(), s.end_ms);
        resolve_artwork(app.clone(), s.title.clone(), s.artist.clone(), s.end_ms);
    }
    let _ = app.emit(
        "tick",
        json!({
            "status": s.status,
            "positionMs": estimate_position(s),
            "durationMs": s.end_ms,
        }),
    );
}

/// Poll SMTC natively and stream state to the webview as `track` / `tick` /
/// `idle` events. Runs on its own thread for the app's life.
///
/// Was a PowerShell 5.1 child process streaming JSON lines over a pipe; see
/// smtc.rs for why that went away. The event shapes emitted here are
/// unchanged, so nothing downstream — renderer or otherwise — can tell the
/// difference apart from the process no longer existing.
#[cfg(windows)]
pub(crate) fn start_smtc(app: AppHandle) {
    std::thread::spawn(move || {
        // WinRT calls need an initialised apartment on this thread. The old
        // code got one free inside PowerShell's own process; a bare
        // std::thread has none, and every call would fail without this.
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let mut watcher = match crate::smtc::Watcher::new() {
            Ok(w) => w,
            Err(err) => {
                eprintln!("[smtc] WinRT session manager unavailable: {err}");
                return;
            }
        };

        let mut current_key: Option<String> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(SMTC_INTERVAL_MS));

            // While a local file is playing, ignore SMTC entirely — otherwise its
            // "no session" idle would clear the track the app is playing itself.
            if LOCAL_ACTIVE.load(Ordering::Relaxed) {
                continue;
            }

            let sample = match watcher.poll() {
                Ok(s) => s,
                // A transient WinRT hiccup is NOT "playback stopped" — emitting
                // idle here would clear the track and re-trigger a full lyric
                // lookup on a blip. Skip the tick and try again.
                Err(err) => {
                    eprintln!("[smtc] {err}");
                    continue;
                }
            };

            // Recorded on every poll (not just changes) so a late-attaching
            // frontend can pull the current state via resync_smtc instead of
            // relying on having caught the one push event that announced it —
            // see resync_smtc for why that one-shot push is not enough on its
            // own now that this poll loop starts fast enough to sometimes win
            // the race against the webview's own page load.
            if let Some(state) = app.try_state::<Mutex<Option<crate::smtc::Session>>>() {
                *state.lock().unwrap() = sample.clone();
            }

            match &sample {
                None => {
                    if current_key.is_some() {
                        current_key = None;
                        let _ = app.emit("idle", ());
                    }
                }
                Some(s) => emit_smtc_sample(&app, s, &mut current_key),
            }
        }
    });
}

/// Now-playing detection is SMTC-specific, so non-Windows builds simply have
/// none — same as before the port.
#[cfg(not(windows))]
pub(crate) fn start_smtc(_app: AppHandle) {}

/// The overlay's native window handle as a raw isize, for the wallpaper FFI.
#[cfg(windows)]
pub(crate) fn window_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize)
}

/// Enter or leave wallpaper mode as the display mode changes. Reparenting the
/// overlay behind the desktop icons is the whole feature; on any failure it
/// stays a normal overlay (the attach/detach return Err rather than panic).
#[cfg(windows)]
pub(crate) fn apply_wallpaper(app: &AppHandle, old_mode: &str, new_mode: &str) {
    let Some(hwnd) = window_hwnd(app) else { return };
    if new_mode == "wallpaper" && old_mode != "wallpaper" {
        WALLPAPER_SURFACED.store(false, Ordering::Relaxed);
        match crate::wallpaper::attach(hwnd) {
            Ok(()) => WALLPAPER_ATTACHED.store(true, Ordering::Relaxed),
            Err(e) => eprintln!("[wallpaper] attach failed: {e}"),
        }
    } else if new_mode != "wallpaper" && old_mode == "wallpaper" {
        // Leaving wallpaper mode entirely must land in a known-good state no
        // matter what wallpaper_interact left behind — a stale WALLPAPER_SURFACED
        // or a leftover always-on-top from an interrupted surface/settle is
        // exactly how a stuck "can't get out" report happens.
        let was_surfaced = WALLPAPER_SURFACED.swap(false, Ordering::Relaxed);
        WALLPAPER_ATTACHED.store(false, Ordering::Relaxed);
        // Don't wait for the power watcher's next poll tick to notice we left:
        // a stale "suspended" flag would freeze the render loop in the fullscreen
        // mode being switched to, which has nothing to do with battery/lock/games.
        if WALLPAPER_SUSPENDED.swap(false, Ordering::Relaxed) {
            let _ = app.emit("wallpaper-power", json!({ "suspended": false, "reason": serde_json::Value::Null }));
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_always_on_top(false);
        }
        // detach() on a window that's already detached (was_surfaced) is a
        // harmless no-op — still call it, since "definitely not attached" is
        // cheaper to guarantee than to track precisely.
        let _ = was_surfaced;
        if let Err(e) = crate::wallpaper::detach(hwnd) {
            eprintln!("[wallpaper] detach failed: {e}");
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn apply_wallpaper(_app: &AppHandle, _old_mode: &str, _new_mode: &str) {}

/// Forward the real cursor to the renderer while in wallpaper mode. A window
/// under the desktop icons receives no clicks — Windows routes them to the
/// desktop — so we poll the cursor + left button at 30Hz and let the renderer
/// synthesise the events (see onWallpaperPointer). Only while attached, and only
/// when the cursor is over the desktop (not another app's window).
#[cfg(windows)]
pub(crate) fn start_pointer_forwarding(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(33));
        if !WALLPAPER_ATTACHED.load(Ordering::Relaxed) {
            continue;
        }
        let Some(hwnd) = window_hwnd(&app) else { continue };
        let Some((x, y)) = crate::wallpaper::cursor_pos() else { continue };
        if !crate::wallpaper::is_cursor_over_desktop(hwnd, x, y) {
            continue;
        }
        let (_down, pressed) = crate::wallpaper::mouse_state();
        let _ = app.emit("wallpaper-pointer", json!({ "x": x, "y": y, "clicked": pressed }));
    });
}

#[cfg(not(windows))]
pub(crate) fn start_pointer_forwarding(_app: AppHandle) {}

/// Pause rendering when it would be pure waste. Two policies share this one
/// poll — a 2s interval is plenty for state that changes on human timescales
/// (unplugging, alt-tabbing into a game), unlike the pointer-forwarding loop
/// above which has to track a moving cursor:
///
/// - **Wallpaper mode**: pause on battery, behind a locked screen, or behind
///   another app's exclusive fullscreen (a game) — the same three triggers
///   Wallpaper Engine and Lively Wallpaper both use.
/// - **Overlay mode** (full/bar/strip): pause on lock, exclusive-fullscreen,
///   or the window itself being occluded (minimized / cloaked) — nobody can
///   see it either way. Battery is handled differently here: throttling to
///   Lite mode is right, blanking the visualiser the user deliberately opened
///   is not, so it is reported as an independent bit rather than a pause
///   reason (PERF-UX.md P2).
#[cfg(windows)]
pub(crate) fn start_power_watcher(app: AppHandle) {
    let mut last_overlay: Option<(bool, bool)> = None;
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let Some(hwnd) = window_hwnd(&app) else { continue };

        if WALLPAPER_ATTACHED.load(Ordering::Relaxed) {
            let (suspend, reason) = if crate::wallpaper::is_locked() {
                (true, "lock")
            } else if crate::wallpaper::on_battery().unwrap_or(false) {
                (true, "battery")
            } else if crate::wallpaper::foreground_is_fullscreen(hwnd) {
                (true, "fullscreen")
            } else {
                (false, "")
            };
            if suspend != WALLPAPER_SUSPENDED.swap(suspend, Ordering::Relaxed) {
                let _ = app.emit(
                    "wallpaper-power",
                    json!({ "suspended": suspend, "reason": if suspend { serde_json::Value::from(reason) } else { serde_json::Value::Null } }),
                );
            }
            continue;
        }

        let (paused, pause_reason) = if crate::wallpaper::is_locked() {
            (true, "lock")
        } else if crate::wallpaper::foreground_is_fullscreen(hwnd) {
            (true, "fullscreen")
        } else if crate::wallpaper::is_main_window_occluded(hwnd) {
            (true, "occluded")
        } else {
            (false, "")
        };
        let on_battery = crate::wallpaper::on_battery().unwrap_or(false);
        if last_overlay != Some((paused, on_battery)) {
            last_overlay = Some((paused, on_battery));
            let _ = app.emit(
                "overlay-power",
                json!({
                    "paused": paused,
                    "pauseReason": if paused { serde_json::Value::from(pause_reason) } else { serde_json::Value::Null },
                    "onBattery": on_battery,
                }),
            );
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn start_power_watcher(_app: AppHandle) {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn session(status: &str, position_ms: i64, end_ms: i64, staleness_ms: i64) -> crate::smtc::Session {
        crate::smtc::Session {
            status: status.into(),
            position_ms,
            end_ms,
            staleness_ms,
            ..Default::default()
        }
    }

    #[test]
    fn a_long_running_song_with_no_seek_still_advances_past_thirty_seconds() {
        // The regression: most source apps only push a fresh timeline on
        // play/pause/seek, so a song playing uninterrupted for minutes is
        // normal, not a bad reading. staleness_ms of 90s used to get clamped
        // back to 0 here, freezing every synced lyric for the rest of the track.
        let s = session("Playing", 10_000, 240_000, 90_000);
        assert_eq!(estimate_position(&s), 100_000);
    }

    #[test]
    fn projected_position_is_still_bounded_by_the_track_length() {
        let s = session("Playing", 10_000, 60_000, 90_000);
        assert_eq!(estimate_position(&s), 60_000);
    }

    #[test]
    fn an_unset_timestamp_projects_nothing() {
        let s = session("Playing", 10_000, 240_000, -1);
        assert_eq!(estimate_position(&s), 10_000);
    }

    #[test]
    fn a_paused_session_reports_the_raw_position_unprojected() {
        let s = session("Paused", 10_000, 240_000, 90_000);
        assert_eq!(estimate_position(&s), 10_000);
    }
}
