//! Window sizing/display mode (full/bar/strip/wallpaper), native audio
//! capture start/stop, and local file playback (open, read, decode+measure).

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{save_prefs, AlwaysOnTopGuard, Prefs, LOCAL_ACTIVE};
use crate::watchers::apply_wallpaper;

/// Size the overlay to fill a monitor — the fullscreen transparent overlay
/// the app expects. Display-mode variants (bar/strip) resize from here.
///
/// Wallpaper mode targets whichever monitor the cursor is on at the moment
/// it's entered, not always the primary display — on a multi-monitor setup
/// where you work on a secondary screen, "wallpaper" meant "the desktop I
/// never look at" otherwise. Every other mode keeps the simpler, established
/// primary-monitor default (the window has no drag region, so it can never
/// end up elsewhere on its own).
fn size_overlay(app: &AppHandle, mode: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let wallpaper_monitor = (mode == "wallpaper")
        .then(|| win.cursor_position().ok())
        .flatten()
        .and_then(|pos| win.monitor_from_point(pos.x, pos.y).ok().flatten());
    let monitor = match wallpaper_monitor.or_else(|| win.primary_monitor().ok().flatten()) {
        Some(m) => m,
        None => return,
    };
    let size = *monitor.size();
    let pos = *monitor.position();

    let (w, h, y) = match mode {
        // A thin bar across the top.
        "bar" => (size.width, 140u32.min(size.height), pos.y),
        // A taskbar-height strip pinned to the bottom.
        "strip" => {
            let strip_h = 96u32.min(size.height);
            (size.width, strip_h, pos.y + size.height as i32 - strip_h as i32)
        }
        // full (and wallpaper, until that phase lands): the whole monitor.
        _ => (size.width, size.height, pos.y),
    };

    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
}

/// Strip is a 96px click-through edge along the taskbar — nothing in it is
/// interactive (no chip, panel, or control fits at that height; see the CSS
/// comment on `.mode-compact`), so the whole window stops intercepting input
/// rather than trying to hit-test individual elements. Every other mode gets
/// normal input back. This is a real OS-level property (WS_EX_TRANSPARENT
/// under the hood) — CSS `pointer-events` cannot do this, since the window
/// itself has to decline the click before it ever reaches page content.
fn apply_click_through(app: &AppHandle, mode: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(mode == "strip");
    }
}

/// Apply a display mode: persist it, enter/leave wallpaper, resize, set
/// click-through, and tell the renderer. Shared by the command, the
/// Ctrl+Alt+M wallpaper hotkey, and the Ctrl+Alt+D cycle hotkey.
pub(crate) fn set_mode(app: &AppHandle, mode: &str) {
    let old_mode = match app.try_state::<Mutex<Prefs>>() {
        Some(st) => {
            let mut p = st.lock().unwrap_or_else(|e| e.into_inner());
            let old = p.display_mode.clone();
            p.display_mode = mode.to_string();
            save_prefs(app, &p);
            old
        }
        None => String::new(),
    };
    // Wallpaper wants the full monitor; bar/strip resize; leaving wallpaper
    // detaches first so the window is a normal top-level again before resizing.
    // size_overlay is passed the real mode string (not translated to "full")
    // because entering wallpaper mode needs to know that, specifically, to
    // pick the cursor's monitor instead of always the primary one — its
    // layout math treats "wallpaper" and "full" identically either way.
    apply_wallpaper(app, &old_mode, mode);
    size_overlay(app, mode);
    apply_click_through(app, mode);
    let _ = app.emit("display-mode", json!({ "mode": mode, "insets": {} }));
}

/// Cycle Full → Bar → Strip → Full — the keyboard escape hatch strip mode
/// specifically needs, since it deliberately has no clickable UI at all (see
/// apply_click_through). Wallpaper is a separate toggle (Ctrl+Alt+M) and
/// always exits back to Full here rather than joining the cycle, so this key
/// also doubles as a general "get me back to normal" from any mode.
pub(crate) fn cycle_display_mode(app: &AppHandle) {
    let Some(st) = app.try_state::<Mutex<Prefs>>() else { return };
    let current = st.lock().unwrap_or_else(|e| e.into_inner()).display_mode.clone();
    let next = match current.as_str() {
        "full" => "bar",
        "bar" => "strip",
        _ => "full",
    };
    set_mode(app, next);
}

/// Start native WASAPI loopback capture of the system output. Returns true
/// optimistically; the renderer confirms real audio by waiting for the first
/// `native-audio` frame and otherwise falls back to getDisplayMedia.
#[tauri::command]
pub(crate) fn start_audio_capture(app: AppHandle) -> bool {
    crate::audio::start_capture(app);
    true
}

#[tauri::command]
pub(crate) fn stop_audio_capture() {
    crate::audio::stop_capture();
}

/// Begin recording the active loopback capture for later transcription — see
/// `audio.rs`'s module doc for why this exists (no whole-song PCM over IPC
/// for SMTC playback). Requires `start_audio_capture` to already be on, same
/// as `native-audio` frames do; returns false if it is not, or if a
/// recording is already running.
///
/// The sidecar check is here rather than only at `stop_native_song_recording`
/// on purpose: false is what makes `listen.js` record the song in the WebView
/// instead, and it has to be answered before the song plays. Recording a whole
/// track and only then discovering there is nothing to transcribe it with
/// would cost the user the one play the WebView path could have learned from.
#[tauri::command]
pub(crate) fn start_native_song_recording() -> bool {
    crate::inference::available() && crate::audio::start_recording()
}

/// Abandon the active recording without transcribing it — real (correctly
/// timed) lyrics turned up for this song, or the user skipped past it.
#[tauri::command]
pub(crate) fn discard_native_song_recording() {
    crate::audio::discard_recording();
}

/// Declare whether anything is consuming the time-domain waveform.
///
/// Only MilkDrop reads it, and it is three quarters of the emitted frame, so
/// the renderer switches it off whenever no consumer has asked recently. See
/// `audio.rs`'s module doc.
#[tauri::command]
pub(crate) fn set_audio_waveform(enabled: bool) {
    crate::audio::set_waveform(enabled);
}

/// The renderer is about to play a local file: announce it as the track (so
/// lyrics + art load) and stand the SMTC watcher down.
#[tauri::command]
pub(crate) fn set_local_track(track: Value, app: AppHandle) {
    LOCAL_ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
    let title = track.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let artist = track.get("artist").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let duration = track.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0);
    let _ = app.emit("track", json!({ "title": title, "artist": artist, "album": "", "sourceApp": "local", "durationMs": duration }));
    crate::commands::lyrics_cmds::resolve_lyrics(app.clone(), title.clone(), artist.clone(), duration);
    crate::commands::artwork_cmds::resolve_artwork(app.clone(), title, artist, duration);
}

#[tauri::command]
pub(crate) fn end_local_playback(app: AppHandle) {
    LOCAL_ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("idle", ());
}

/// Decode + measure a local file natively (off the UI thread), returning the
/// per-window energy envelopes + bass onsets the renderer feeds into the heat
/// map and tempo estimator — so a local song's shape is known on the first play
/// with no Web Audio decode stalling the opening frames.
///
/// Also returns `beats`: a whole-song beat grid from `beats.rs`. That is a
/// second pass over the same samples (an STFT the envelope analysis does not
/// need), and it is worth it — the renderer's live estimator drifts by
/// construction and was measured reading a 138 BPM track as 174. It is also
/// cheap: 30 s of audio tracks in 0.02 s in a release build, so a four-minute
/// song costs on the order of 0.15 s, against a decode that already happened.
/// Absent when the track has no steady beat, which the renderer must treat as
/// "no grid" rather than "zero BPM".
///
/// And `key`, from `key.rs`, on the same terms: absent when nothing is
/// decisive enough to name. Both are optional by design — a tracker or a
/// detector that always answers is worse than one that sometimes does not.
///
/// A plain function, not the command itself, so `library.rs`'s Idle-lane
/// backfill (JOB-ENGINE.md §7.16) can run the exact same analysis a live
/// `analyze_local_file` call would, rather than a second implementation that
/// could drift from this one.
pub(crate) fn analyze_local_file_value(path: &str) -> Value {
    let (samples, sample_rate) = match crate::analysis::decode_to_mono(path) {
        Some(pair) => pair,
        None => return json!({ "ok": false }),
    };
    let a = crate::analysis::analyse_samples(&samples, sample_rate);
    let mut out = serde_json::to_value(&a).unwrap_or(json!({}));
    out["ok"] = json!(true);
    out["durationMs"] = json!((samples.len() as f64 / sample_rate as f64) * 1000.0);
    if let Some(beats) = crate::beats::track(&samples, sample_rate) {
        log::info!("beat grid: {:.1} BPM, {} beats, confidence {:.2}", beats.bpm, beats.beats_ms.len(), beats.confidence);
        out["beats"] = serde_json::to_value(&beats).unwrap_or(Value::Null);
    }
    if let Some(key) = crate::key::detect(&samples, sample_rate) {
        log::info!("key: {} (margin {:.2})", key.label, key.confidence);
        out["key"] = serde_json::to_value(&key).unwrap_or(Value::Null);
    }
    if let Some(starts) = crate::structure::detect(&samples, sample_rate) {
        log::info!("structure: {} section(s)", starts.len());
        out["sectionStartsMs"] = json!(starts);
    }
    if let Some(l) = crate::loudness::measure(&samples, sample_rate) {
        log::info!("loudness: {:.1} LUFS, gain {:.2}", l.lufs, l.gain);
        out["loudness"] = serde_json::to_value(&l).unwrap_or(Value::Null);
    }
    out
}

/// `(async)` IS LOAD-BEARING, NOT DECORATION — same reasoning as
/// `import_lyrics` in lyrics_cmds.rs. A command without the `async` keyword
/// runs on Tauri's main thread, and `analyze_local_file_value` is a full
/// symphonia decode plus four DSP passes (envelope/onset, beat tracking, key,
/// structure, loudness) over a whole song — tens of seconds in a debug build.
/// Without this, that work blocked the main thread for the duration, freezing
/// every other command (including totally unrelated ones) and the UI itself
/// for as long as it ran. `(async)` moves it to a worker thread.
#[tauri::command(async)]
pub(crate) fn analyze_local_file(path: String) -> Value {
    analyze_local_file_value(&path)
}

/// Audio file extensions the pickers and folder scan accept. Also the set
/// `library.rs`'s folder walk indexes — one list, so a format added to the
/// picker is automatically a format the library watcher notices too.
pub(crate) const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma"];

/// One queue item from a file path: {localPath, title (filename stem), artist}.
fn local_item(path: &std::path::Path) -> Value {
    let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    json!({ "localPath": path.to_string_lossy(), "title": title, "artist": "" })
}

/// `(async)` is required, not stylistic — see `import_lyrics` in
/// lyrics_cmds.rs for the full reasoning. Short version: a sync command runs
/// on the main thread, and a blocking picker called from the main thread
/// deadlocks against the event loop it is waiting on. This is the more likely
/// culprit behind the "media-import check reads as the app hanging" note
/// below than the always-on-top layering it was originally attributed to —
/// both are real, but only this one actually freezes the process.
#[tauri::command(async)]
pub(crate) fn open_local_files(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    // See AlwaysOnTopGuard: without dropping always-on-top first, this picker
    // opens invisibly behind the overlay — the exact bug that failed Store
    // certification's media-import check (it reads as the app hanging).
    let _surfaced = AlwaysOnTopGuard::engage(&app);
    let mut builder = app.dialog().file().add_filter("Audio", AUDIO_EXTS);
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let picked = builder.blocking_pick_files();
    match picked {
        Some(paths) => json!(paths.into_iter().filter_map(|p| p.into_path().ok()).map(|p| local_item(&p)).collect::<Vec<_>>()),
        None => json!([]),
    }
}

/// `(async)` for the same main-thread/blocking-picker deadlock as
/// `open_local_files` above.
#[tauri::command(async)]
pub(crate) fn open_local_folder(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let _surfaced = AlwaysOnTopGuard::engage(&app);
    let mut builder = app.dialog().file();
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let Some(folder) = builder.blocking_pick_folder() else {
        return json!([]);
    };
    let Ok(dir) = folder.into_path() else { return json!([]) };
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut paths: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()).map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str())).unwrap_or(false))
            .collect();
        paths.sort();
        items = paths.iter().map(|p| local_item(p)).collect();
    }
    json!(items)
}

/// Read a local file's raw bytes. Returned as a binary Response, which the
/// webview receives as an ArrayBuffer for `new Blob([raw])` playback + decode.
///
/// `(async)` for the same main-thread reason as `analyze_local_file` above —
/// a multi-minute FLAC is tens of megabytes, and a synchronous read of that
/// on a slow disk is exactly the kind of stall this pattern exists to avoid,
/// even though the common case (a small/cached file) is fast enough that
/// this bug was never the one actually measured.
#[tauri::command(async)]
pub(crate) fn read_local_file(file_path: String) -> tauri::ipc::Response {
    let bytes = std::fs::read(&file_path).unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_item_uses_the_filename_stem_as_title() {
        let item = local_item(std::path::Path::new("/music/Seedhe Maut - 101.mp3"));
        assert_eq!(item["title"], "Seedhe Maut - 101");
        assert_eq!(item["artist"], "");
    }

    #[test]
    fn local_item_handles_a_path_with_no_extension() {
        let item = local_item(std::path::Path::new("/music/untitled"));
        assert_eq!(item["title"], "untitled");
    }

    #[test]
    fn audio_exts_are_all_lowercase_for_the_case_insensitive_filter() {
        assert!(AUDIO_EXTS.iter().all(|e| e.to_lowercase() == *e));
    }
}
