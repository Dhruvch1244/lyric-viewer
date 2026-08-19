//! Shared app state: persisted preferences, the current track, and the
//! process-wide flags the SMTC/wallpaper watchers and the command layer both
//! need to see. Split out of lib.rs so the 59 `#[tauri::command]` handlers
//! don't have to share one file with what they all read and write.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// True while the app is playing a local file itself. The SMTC watcher stands
/// down so its "no session" idle doesn't clear a locally-playing track.
pub(crate) static LOCAL_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Set once in `run()`'s setup hook. `llm::convert()` is a pure function with
/// no `AppHandle` of its own, called from four different modules — this is
/// how it reaches back up to emit the local-CLI offer without every caller
/// needing to know about it (mirrors where Electron's `setAllFailedHook`
/// lived: inside llm.js's `convert()`, not in each feature module).
pub(crate) static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// True once the local-CLI offer has fired this session — asked once, not on
/// every subsequent provider failure.
static OFFERED_CLI: AtomicBool = AtomicBool::new(false);

/// Live mirror of `Prefs::crash_reporting_enabled`, readable from crashlog.rs
/// (a panic hook has no `State<Mutex<Prefs>>` to pull from, and crashlog.rs
/// deliberately doesn't know Prefs' shape) without needing to lock the prefs
/// mutex from a context that might itself be panicking. Kept in sync by
/// `set_crash_reporting` and seeded from the persisted value at startup.
pub(crate) static CRASH_REPORTING_ENABLED: AtomicBool = AtomicBool::new(false);

/// Called from `llm::convert()` when every configured provider (cloud and
/// local-CLI) has just failed or none is configured. Offers the local-CLI
/// fallback exactly at the moment it would actually help, rather than as a
/// startup nag — but only once per session, and not if the user already
/// decided (consented to one, or explicitly declined).
pub(crate) fn maybe_offer_localcli() {
    if OFFERED_CLI.swap(true, Ordering::Relaxed) {
        return; // already asked this session
    }
    let Some(app) = APP_HANDLE.get() else { return };
    let decided = crate::localcli::consent();
    let consented = decided.get("consented").and_then(|v| v.as_bool()).unwrap_or(false);
    let declined = decided.get("id").and_then(|v| v.as_str()) == Some("declined");
    if consented || declined {
        return;
    }
    let detected = crate::localcli::detect();
    let any_installed = detected
        .as_array()
        .map(|arr| arr.iter().any(|c| c.get("installed").and_then(|v| v.as_bool()).unwrap_or(false)))
        .unwrap_or(false);
    if !any_installed {
        OFFERED_CLI.store(false, Ordering::Relaxed); // nothing to offer; try again on a later failure
        return;
    }
    let _ = app.emit("localcli-offer", json!({ "detected": detected }));
}

/// True while the overlay is reparented behind the desktop. Gates the pointer-
/// forwarding loop, which is the only way a window under the icons gets clicks.
#[cfg(windows)]
pub(crate) static WALLPAPER_ATTACHED: AtomicBool = AtomicBool::new(false);

/// True while a scrollable panel has temporarily lifted the wallpaper window
/// to the foreground so wheel/drag/focus work. See `wallpaper_interact`.
#[cfg(windows)]
pub(crate) static WALLPAPER_SURFACED: AtomicBool = AtomicBool::new(false);

/// True while wallpaper mode has paused its own rendering because the system
/// is on battery, locked, or another app owns exclusive fullscreen. See
/// `start_power_watcher`. Mirrors what Wallpaper Engine / Lively Wallpaper do
/// on Windows — a reparented window behind the icons has no way to notice
/// any of this on its own.
#[cfg(windows)]
pub(crate) static WALLPAPER_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// Persisted user preferences. Field names map to the camelCase the renderer
/// reads (see `get_prefs`/`get_offset`/`get_transcribe_config`).
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Prefs {
    pub(crate) script: String,
    pub(crate) show_translation: bool,
    pub(crate) offset_ms: i64,
    pub(crate) transcribe_enabled: bool,
    pub(crate) transcribe_language: String,
    pub(crate) transcribe_model: String,
    pub(crate) display_mode: String,
    pub(crate) vocal_isolation: bool,
    /// Opt-in, off by default: whether crashlog.rs also POSTs a crash/error
    /// entry to the (self-hosted, maintainer-controlled) remote endpoint on
    /// top of always writing it locally. See crashlog.rs's module doc.
    pub(crate) crash_reporting_enabled: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            script: "latin".into(),
            show_translation: true,
            offset_ms: 0,
            transcribe_enabled: true,
            transcribe_language: String::new(),
            transcribe_model: String::new(),
            display_mode: "full".into(),
            vocal_isolation: false,
            crash_reporting_enabled: false,
        }
    }
}

/// The track currently playing, so commands like translation can find its
/// cached cues. Set as each `track` is resolved.
#[derive(Clone, Default)]
pub(crate) struct CurTrack {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) key: String,
}

pub(crate) fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub(crate) fn load_prefs(app: &AppHandle) -> Prefs {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn save_prefs(app: &AppHandle, prefs: &Prefs) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(prefs) {
            let _ = std::fs::write(p, s);
        }
    }
}

/// Drops the overlay's always-on-top for the lifetime of the guard, restoring
/// it on drop (success, error, or an early return — RAII covers every path a
/// plain "restore at the end" would miss).
///
/// The overlay is `alwaysOnTop: true` by design, so ANY other top-level
/// window this app opens — a browser tab (see spotify.rs, the original use
/// of this pattern), a native file/folder picker (open_local_files /
/// open_local_folder) — opens BEHIND it, invisible and unclickable, unless
/// this runs first. Not a hang: the app is waiting on a dialog the user
/// cannot see or click, which reads as "stopped responding" from the
/// outside — this shape of bug is exactly what failed Microsoft Store
/// certification's 10.1.2.10 functionality check on media import (the
/// picker in open_local_files/open_local_folder had no guard until this).
pub(crate) struct AlwaysOnTopGuard {
    window: Option<tauri::WebviewWindow>,
}

impl AlwaysOnTopGuard {
    pub(crate) fn engage(app: &tauri::AppHandle) -> Self {
        let window = app.get_webview_window("main");
        if let Some(w) = &window {
            let _ = w.set_always_on_top(false);
        }
        AlwaysOnTopGuard { window }
    }
}

impl Drop for AlwaysOnTopGuard {
    fn drop(&mut self) {
        if let Some(w) = &self.window {
            let _ = w.set_always_on_top(true);
        }
    }
}
