//! Everything that didn't earn its own file: provider/local-CLI status, tray
//! tooltip + notification reporting, crash log access, the SMTC resync
//! replay, the wallpaper interactive-surface lift, and the MilkDrop preset
//! catalogue/thumbnail commands (thin wrappers over presets.rs).

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::tray::{notify, set_tray_tooltip};

#[cfg(windows)]
use std::sync::atomic::Ordering;
#[cfg(windows)]
use tauri::Manager;
#[cfg(windows)]
use crate::state::Prefs;

#[tauri::command]
pub(crate) fn get_provider_status() -> Value {
    json!({ "provider": crate::llm::active_provider() })
}

/// Which local developer CLIs (Claude/Gemini/Ollama/`gh models`/Antigravity)
/// are installed right now, for the local-AI picker under the 🔑 panel.
#[tauri::command]
pub(crate) fn localcli_detect() -> Value {
    crate::localcli::detect()
}

/// The user's current local-CLI consent: `{consented, id}`.
#[tauri::command]
pub(crate) fn localcli_status() -> Value {
    crate::localcli::consent()
}

/// Record (or clear, or decline) the user's local-CLI choice.
#[tauri::command]
pub(crate) fn localcli_consent(id: Option<String>) -> Value {
    crate::localcli::set_consent(id.as_deref());
    crate::localcli::consent()
}

#[tauri::command]
pub(crate) fn report_jobs(payload: Value, cur: State<Mutex<crate::state::CurTrack>>, app: AppHandle) {
    let jobs = payload
        .get("jobs")
        .and_then(|j| j.as_array())
        .map(|arr| arr.iter().filter_map(|j| j.get("label").and_then(|l| l.as_str())).collect::<Vec<_>>().join(" · "))
        .unwrap_or_default();
    let song = {
        let c = cur.lock().unwrap_or_else(|e| e.into_inner());
        if c.title.is_empty() {
            "Nothing playing".to_string()
        } else if c.artist.is_empty() {
            c.title.clone()
        } else {
            format!("{} — {}", c.title, c.artist)
        }
    };
    let text = if jobs.is_empty() { format!("Lyric Overlay\n{song}") } else { format!("Lyric Overlay\n{song}\n{jobs}") };
    set_tray_tooltip(&app, &text);

    // A job worth interrupting for raises an actual notification — the HUD
    // chip that reports progress lives inside a bar that stays invisible
    // until the cursor moves, so minutes of background work could finish
    // with nothing on screen having said it started. Only transcription
    // today: it is the one job whose result changes what you'll see next
    // play, everything else is routine and would just be noise.
    if let Some(finished) = payload.get("finished") {
        if finished.get("id").and_then(|v| v.as_str()) == Some("transcribe") {
            if let Some(label) = finished.get("label").and_then(|v| v.as_str()) {
                notify(&app, label);
            }
        }
    }
}

/// Renderer-side error reporting into the same local crash log a Rust panic
/// lands in (see crashlog.rs) — a `window.onerror`/`unhandledrejection` in
/// renderer.js calls this so a JS-side crash is visible too, not just a
/// backend one. Fire-and-forget from the JS side; nothing here can itself
/// fail in a way worth surfacing back to a page that just errored.
#[tauri::command]
pub(crate) fn report_client_error(app: AppHandle, message: String) {
    crate::crashlog::append_client_error(&app, &message);
}

/// Reveal the local crash log in the file manager, for the "Open crash log"
/// button in the 🔑 panel — a user hitting a real bug can attach it by hand
/// to an email, same as the existing AI-content report flow next to it.
#[tauri::command]
pub(crate) fn open_crash_log(app: AppHandle) -> Value {
    let Some(path) = crate::crashlog::ensure_and_path(&app) else {
        return json!({ "status": "error", "message": "could not resolve the log path" });
    };
    use tauri_plugin_opener::OpenerExt;
    match app.opener().reveal_item_in_dir(&path) {
        Ok(()) => json!({ "status": "ok" }),
        Err(e) => json!({ "status": "error", "message": e.to_string() }),
    }
}

/// Replay the last-known SMTC sample as fresh `track`/`tick` events.
///
/// A song already playing when the app launches gets exactly ONE `track`
/// push — its key never changes again on its own, so nothing re-announces it
/// later. Tauri events are fire-and-forget with no queue for a listener that
/// attaches late, so if that single push lands before the webview has run
/// far enough to call `onTrack`, it is gone forever and the UI is stuck on
/// "waiting for playback" despite a real, unchanging session sitting right
/// there. The old PowerShell poller was slow enough (process spawn, script
/// parse, WinRT projection load) to always lose that race in the page's
/// favour by accident; the native poll here is fast enough to sometimes win
/// it, which is what actually surfaced this.
///
/// The frontend calls this once during boot, *after* `onTrack`/`onTick` are
/// already registered — so unlike the poll loop's own push, this one is
/// ordered by construction rather than by luck.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn resync_smtc(app: AppHandle, state: State<Mutex<Option<crate::smtc::Session>>>) {
    let sample = state.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(s) = sample {
        // A fresh Option<String> each call: this is a resync, not a diff
        // against whatever the poll loop's own `current_key` happens to be,
        // so `track` (and the lyric/artwork lookups it kicks off) fires every
        // time regardless of that loop's independent dedup state.
        let mut key = None;
        crate::watchers::emit_smtc_sample(&app, &s, &mut key);
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn resync_smtc() {}

/// Temporarily surface the wallpaper window as a real interactive overlay.
///
/// A window reparented behind the desktop icons gets no wheel, no drag and no
/// real focus — pointer forwarding only synthesizes clicks/hover, which is
/// unusable for a scrolling panel (library, MilkDrop browser, poster picker).
/// Rather than hand-rolling more forwarded event types, briefly lift the
/// whole window to the foreground while such a panel is open: every kind of
/// input then works because it is a normal top-level window again. It settles
/// back behind the icons when the panel closes. Mirrors Electron's
/// `setWallpaperInteractive`; the renderer drives this via `syncWallpaperInteract`.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn wallpaper_interact(on: bool, app: AppHandle, state: State<Mutex<Prefs>>) {
    use crate::state::{WALLPAPER_ATTACHED, WALLPAPER_SURFACED};
    use crate::watchers::window_hwnd;

    let is_wallpaper = state.lock().unwrap_or_else(|e| e.into_inner()).display_mode == "wallpaper";
    if !is_wallpaper || on == WALLPAPER_SURFACED.load(Ordering::Relaxed) {
        return;
    }
    let (Some(hwnd), Some(window)) = (window_hwnd(&app), app.get_webview_window("main")) else {
        return;
    };
    WALLPAPER_SURFACED.store(on, Ordering::Relaxed);

    if on {
        // Stopping forwarding is implicit: the loop in start_pointer_forwarding
        // skips every tick WALLPAPER_ATTACHED is false.
        WALLPAPER_ATTACHED.store(false, Ordering::Relaxed);
        if let Err(e) = crate::wallpaper::detach(hwnd) {
            eprintln!("[wallpaper] interact-detach failed: {e}");
        }
        let _ = window.set_always_on_top(true);
    } else {
        let _ = window.set_always_on_top(false);
        match crate::wallpaper::attach(hwnd) {
            Ok(()) => WALLPAPER_ATTACHED.store(true, Ordering::Relaxed),
            Err(e) => {
                // Could not settle back behind the icons; staying surfaced
                // beats the window vanishing behind everything else.
                eprintln!("[wallpaper] interact-reattach failed: {e}");
                let _ = window.set_always_on_top(true);
                WALLPAPER_SURFACED.store(true, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn wallpaper_interact(_on: bool) {}

#[tauri::command]
pub(crate) fn milkdrop_catalogue(app: AppHandle) -> Value {
    json!(crate::presets::catalogue(&app))
}

#[tauri::command]
pub(crate) fn milkdrop_preset(app: AppHandle, name: String) -> Value {
    crate::presets::preset(&app, &name).unwrap_or(Value::Null)
}

#[tauri::command]
pub(crate) fn milkdrop_thumb_get(app: AppHandle, names: Vec<String>) -> Value {
    crate::presets::thumbs_get(&app, &names)
}

#[tauri::command]
pub(crate) fn milkdrop_thumb_put(app: AppHandle, name: String, data_url: String) -> bool {
    crate::presets::thumb_put(&app, &name, &data_url)
}

#[tauri::command]
pub(crate) fn milkdrop_thumb_clear(app: AppHandle) -> bool {
    crate::presets::thumbs_clear(&app)
}

/// Aggregated listening stats for the Insights panel. `days` restricts to a
/// trailing window (e.g. 30/365); omitted covers the whole unlimited log.
#[tauri::command]
pub(crate) fn get_listening_stats(app: AppHandle, days: Option<i64>) -> Value {
    crate::stats::compute_stats(&app, days)
}

/// Erase the local listening-history log. See `stats.rs`'s module doc for why
/// this exists — unlimited local retention is a real record of listening
/// habits, so it must stay reversible on demand.
#[tauri::command]
pub(crate) fn clear_listening_history(app: AppHandle) {
    crate::stats::clear(&app);
}

/// "About this song" — wiki.rs's Wikipedia lookup, on demand (unlike
/// genre/mood/attribution, nobody wants this fetched for every song in the
/// background). Cached into the same per-track lyrics-cache file those use,
/// including a cached miss (`Value::Null`), so a song wiki genuinely has
/// nothing on is not re-searched every time the panel opens.
#[tauri::command]
pub(crate) fn get_song_info(app: AppHandle, title: String, artist: String) -> Value {
    use crate::commands::lyrics_cmds::{lyrics_cache_path, track_key};

    let key = track_key(&artist, &title);
    if let Some(path) = lyrics_cache_path(&app, &key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                if let Some(info) = cached.get("songInfo") {
                    return info.clone();
                }
            }
        }
    }

    let result = crate::wiki::song_info(&title, &artist)
        .map(|s| json!({ "title": s.title, "extract": s.extract, "thumbnail": s.thumbnail }))
        .unwrap_or(Value::Null);

    if let Some(path) = lyrics_cache_path(&app, &key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                cached["songInfo"] = result.clone();
                let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
            }
        }
    }
    result
}

/// "Similar songs" — stats.rs's on-demand match against the local listening
/// history, for the CURRENT track. Not cached (unlike genre/song-info):
/// unlike a Wikipedia extract, the right answer can change on every call as
/// more plays land in the log, and the scan itself is cheap (one JSONL read,
/// no network).
#[tauri::command]
pub(crate) fn get_similar_songs(app: AppHandle, title: String, artist: String) -> Value {
    use crate::commands::lyrics_cmds::track_key;

    let key = track_key(&artist, &title);
    crate::stats::similar_songs(&app, &key, 20)
}
