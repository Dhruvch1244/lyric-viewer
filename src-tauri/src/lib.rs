//! Lyric Overlay — Tauri backend.
//!
//! This is the Rust replacement for the Electron main process. It owns the
//! things the webview cannot do itself: the transparent always-on-top overlay
//! window, SMTC "now playing" detection, persisted preferences, and (in later
//! phases) wallpaper mode, the updater and the tray.
//!
//! The renderer talks to it through `window.player` (see tauri-shim.js), which
//! maps onto the `#[tauri::command]` functions and the events emitted here.

mod artwork;
mod attribute;
mod llm;
mod lyrics;
mod mood;
mod translate;
#[cfg(windows)]
mod wallpaper;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// The PowerShell 5.1 SMTC poller, embedded so it needs no resource-path
/// resolution and works identically in `tauri dev` and a bundled install. It is
/// written to a temp file at startup and spawned from there.
const SMTC_POLL_PS1: &str = include_str!("../../src/main/smtc-poll.ps1");

// ---------------------------------------------------------------- preferences

/// Persisted user preferences. Field names map to the camelCase the renderer
/// reads (see `get_prefs`/`get_offset`/`get_transcribe_config`).
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Prefs {
    script: String,
    show_translation: bool,
    offset_ms: i64,
    transcribe_enabled: bool,
    transcribe_language: String,
    transcribe_model: String,
    display_mode: String,
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
        }
    }
}

/// The track currently playing, so commands like translation can find its
/// cached cues. Set as each `track` is resolved.
#[derive(Clone, Default)]
struct CurTrack {
    title: String,
    artist: String,
    key: String,
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn load_prefs(app: &AppHandle) -> Prefs {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &Prefs) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(prefs) {
            let _ = std::fs::write(p, s);
        }
    }
}

// ------------------------------------------------------------- SMTC watcher

/// One SMTC sample as emitted by smtc-poll.ps1.
#[derive(Deserialize)]
struct SmtcMessage {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    session: Option<SmtcSession>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SmtcSession {
    #[serde(default)]
    source_app: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    position_ms: i64,
    #[serde(default)]
    end_ms: i64,
    #[serde(default)]
    staleness_ms: i64,
}

/// Best-effort current position, projecting past SMTC's stale `positionMs` while
/// playing — mirrors `estimatePositionMs` in the old smtc.js.
fn estimate_position(s: &SmtcSession) -> i64 {
    if s.status != "Playing" {
        return s.position_ms;
    }
    let staleness = if s.staleness_ms >= 0 && s.staleness_ms < 30_000 {
        s.staleness_ms
    } else {
        0
    };
    let projected = s.position_ms + staleness;
    if s.end_ms > 0 {
        projected.min(s.end_ms)
    } else {
        projected
    }
}

/// Spawn the PowerShell poller and stream SMTC state to the webview as
/// `track` / `tick` / `idle` events. Runs on its own thread for the app's life.
fn start_smtc(app: AppHandle) {
    // Materialise the embedded script so PowerShell has a real file to run.
    let script_path = std::env::temp_dir().join("lyric-overlay-smtc-poll.ps1");
    if let Err(err) = std::fs::write(&script_path, SMTC_POLL_PS1) {
        eprintln!("[smtc] could not write poller script: {err}");
        return;
    }

    std::thread::spawn(move || {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .args(["-IntervalMs", "250"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

        // Don't flash a console window (the app is windows_subsystem = "windows").
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                eprintln!("[smtc] failed to spawn powershell: {err}");
                return;
            }
        };

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => return,
        };

        let mut current_key: Option<String> = None;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: SmtcMessage = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(_) => continue, // ignore banner/noise lines
            };
            if !msg.ok {
                if let Some(e) = msg.error {
                    eprintln!("[smtc] {e}");
                }
                continue;
            }

            match msg.session {
                None => {
                    if current_key.is_some() {
                        current_key = None;
                        let _ = app.emit("idle", ());
                    }
                }
                Some(s) => {
                    let title = s.title.clone().unwrap_or_default();
                    let artist = s.artist.clone().unwrap_or_default();
                    let key = format!("{artist} {title}");
                    if current_key.as_deref() != Some(&key) {
                        current_key = Some(key);
                        let _ = app.emit(
                            "track",
                            json!({
                                "title": title,
                                "artist": artist,
                                "album": s.album.clone().unwrap_or_default(),
                                "sourceApp": s.source_app,
                                "durationMs": s.end_ms,
                            }),
                        );
                        // Kick off the lyric + artwork lookups for the new song.
                        resolve_lyrics(app.clone(), title.clone(), artist.clone(), s.end_ms);
                        resolve_artwork(app.clone(), title.clone(), artist.clone(), s.end_ms);
                    }
                    let _ = app.emit(
                        "tick",
                        json!({
                            "status": s.status,
                            "positionMs": estimate_position(&s),
                            "durationMs": s.end_ms,
                        }),
                    );
                }
            }
        }
    });
}

// ------------------------------------------------------------- lyric lookup

/// Filename-safe cache key for a track (djb2 hash of normalised artist+title).
fn track_key(artist: &str, title: &str) -> String {
    let base = format!("{}|{}", artist.to_lowercase().trim(), title.to_lowercase().trim());
    let mut hash: u64 = 5381;
    for b in base.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("{hash:016x}")
}

fn lyrics_cache_path(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("lyrics");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{key}.json")))
}

/// Resolve lyrics for a track and emit `lyrics` events. Cache-first: a song
/// heard before replays instantly and offline. Runs on its own thread so the
/// network call never stalls SMTC position ticks.
fn resolve_lyrics(app: AppHandle, title: String, artist: String, duration_ms: i64) {
    std::thread::spawn(move || {
        let key = track_key(&artist, &title);

        // Remember what's playing so translation/other commands can find its cues.
        if let Some(st) = app.try_state::<Mutex<CurTrack>>() {
            *st.lock().unwrap() = CurTrack { title: title.clone(), artist: artist.clone(), key: key.clone() };
        }

        // Disk cache hit → replay immediately, offline.
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                    let cue_texts = cue_texts_of(&cached);
                    let cached_mood = cached.get("mood").cloned();
                    let cached_attr = cached.get("attribution").cloned();
                    let mut payload = cached;
                    payload["track"] = json!({ "title": title, "artist": artist });
                    payload["origin"] = json!("disk");
                    payload["translationAvailable"] = json!(llm::is_available());
                    let _ = app.emit("lyrics", payload);
                    resolve_mood(&app, &title, &artist, &key, cue_texts.clone(), cached_mood);
                    resolve_attribution(&app, &title, &artist, &key, cue_texts, cached_attr);
                    return;
                }
            }
        }

        let _ = app.emit(
            "lyrics",
            json!({ "track": { "title": title, "artist": artist }, "cues": [], "status": "searching" }),
        );

        let track = lyrics::Track { title: title.clone(), artist: artist.clone(), duration_ms };
        match lyrics::fetch_synced(&track) {
            Some((cues, source)) => {
                let cue_texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
                let payload = json!({
                    "cues": cues,
                    "cuesDevanagari": Value::Null,
                    "cuesEnglish": Value::Null,
                    "source": source,
                    "status": "ok",
                    "indic": false,
                    "hasWordTimings": false,
                    "transliterationAvailable": false,
                    "translationAvailable": llm::is_available(),
                });
                // Persist the raw result (without the per-emit track/origin fields).
                if let Some(path) = lyrics_cache_path(&app, &key) {
                    let _ = std::fs::write(&path, serde_json::to_string(&payload).unwrap_or_default());
                }
                let mut out = payload;
                out["track"] = json!({ "title": title, "artist": artist });
                out["origin"] = json!("network");
                let _ = app.emit("lyrics", out);
                // Upgrade the hash palette to a mood-driven one, and work out who
                // sings which line (both LLM, both cached, no-ops without a key).
                resolve_mood(&app, &title, &artist, &key, cue_texts.clone(), None);
                resolve_attribution(&app, &title, &artist, &key, cue_texts, None);
            }
            None => {
                let _ = app.emit(
                    "lyrics",
                    json!({
                        "track": { "title": title, "artist": artist },
                        "cues": [], "status": "not-found", "indic": false,
                        "plainAvailable": false, "origin": "network",
                    }),
                );
            }
        }
    });
}

/// The lyric texts from a cached `lyrics` payload, for re-running mood analysis.
fn cue_texts_of(payload: &Value) -> Vec<String> {
    payload
        .get("cues")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("text").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Emit the mood-driven palette for a track. A cached mood emits immediately;
/// otherwise the LLM analyses the lyrics once, the result is merged back into the
/// lyrics cache file, and it is emitted. No-op when no provider is configured.
fn resolve_mood(
    app: &AppHandle,
    title: &str,
    artist: &str,
    key: &str,
    cue_texts: Vec<String>,
    cached_mood: Option<Value>,
) {
    if let Some(m) = cached_mood {
        let mut payload = m;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("mood", payload);
        return;
    }
    let app = app.clone();
    let (title, artist, key) = (title.to_string(), artist.to_string(), key.to_string());
    std::thread::spawn(move || {
        let Some(m) = mood::analyze(&cue_texts) else { return };
        let mood_val = json!({
            "mood": m.mood, "hue": m.hue, "energy": m.energy, "palette": m.palette,
        });
        // Merge the mood into the lyrics cache so it runs once per song.
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                    cached["mood"] = mood_val.clone();
                    let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
                }
            }
        }
        let mut payload = mood_val;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("mood", payload);
    });
}

/// Emit per-line singer attribution. A cached answer emits immediately;
/// otherwise the LLM works it out once (multi-artist tracks only), the result
/// is merged into the lyrics cache, and it is emitted. No-op without a provider.
fn resolve_attribution(
    app: &AppHandle,
    title: &str,
    artist: &str,
    key: &str,
    cue_texts: Vec<String>,
    cached: Option<Value>,
) {
    if let Some(a) = cached {
        let mut payload = a;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("attribution", payload);
        return;
    }
    let app = app.clone();
    let (title, artist, key) = (title.to_string(), artist.to_string(), key.to_string());
    std::thread::spawn(move || {
        let Some((artists, singers)) = attribute::attribute_lines(&cue_texts, &title, &artist) else {
            return;
        };
        let attr = json!({ "artists": artists, "singers": singers });
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                    cached["attribution"] = attr.clone();
                    let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
                }
            }
        }
        let mut payload = attr;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("attribution", payload);
    });
}

/// Fetch cover art for a track and emit it to the renderer, on its own thread.
/// The renderer uses the image as the blurred backdrop and derives a palette
/// from it, so a miss simply leaves the hash-palette wash in place.
fn resolve_artwork(app: AppHandle, title: String, artist: String, duration_ms: i64) {
    std::thread::spawn(move || {
        let track = lyrics::Track { title: title.clone(), artist: artist.clone(), duration_ms };
        if let Some(art) = artwork::fetch_artwork(&track) {
            let _ = app.emit(
                "artwork",
                json!({
                    "track": { "title": title, "artist": artist },
                    "artwork": art.data_uri,
                    "artistName": art.artist_name,
                    "chosen": false,
                }),
            );
        }
    });
}

// ------------------------------------------------------------- window sizing

/// Size the overlay to fill the primary monitor — the fullscreen transparent
/// overlay the app expects. Display-mode variants (bar/strip) resize from here.
fn size_overlay(app: &AppHandle, mode: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let monitor = match win.primary_monitor() {
        Ok(Some(m)) => m,
        _ => return,
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

// ----------------------------------------------------------------- commands

#[tauri::command]
fn get_prefs(state: State<Mutex<Prefs>>) -> Value {
    let p = state.lock().unwrap();
    json!({
        "script": p.script,
        "showTranslation": p.show_translation,
        "appVersion": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn get_offset(state: State<Mutex<Prefs>>) -> Value {
    json!({ "offsetMs": state.lock().unwrap().offset_ms })
}

#[tauri::command]
fn set_offset(value_ms: i64, state: State<Mutex<Prefs>>, app: AppHandle) -> i64 {
    {
        let mut p = state.lock().unwrap();
        p.offset_ms = value_ms;
        save_prefs(&app, &p);
    }
    let _ = app.emit("offset", json!({ "offsetMs": value_ms }));
    value_ms
}

#[tauri::command]
fn set_script(script: String, state: State<Mutex<Prefs>>, app: AppHandle) {
    let mut p = state.lock().unwrap();
    p.script = script;
    save_prefs(&app, &p);
}

#[tauri::command]
fn set_show_translation(show: bool, state: State<Mutex<Prefs>>, app: AppHandle) {
    let mut p = state.lock().unwrap();
    p.show_translation = show;
    save_prefs(&app, &p);
}

#[tauri::command]
fn get_display_mode(state: State<Mutex<Prefs>>) -> String {
    state.lock().unwrap().display_mode.clone()
}

/// The overlay's native window handle as a raw isize, for the wallpaper FFI.
#[cfg(windows)]
fn window_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

/// Enter or leave wallpaper mode as the display mode changes. Reparenting the
/// overlay behind the desktop icons is the whole feature; on any failure it
/// stays a normal overlay (the attach/detach return Err rather than panic).
#[cfg(windows)]
fn apply_wallpaper(app: &AppHandle, old_mode: &str, new_mode: &str) {
    let Some(hwnd) = window_hwnd(app) else { return };
    if new_mode == "wallpaper" && old_mode != "wallpaper" {
        if let Err(e) = wallpaper::attach(hwnd) {
            eprintln!("[wallpaper] attach failed: {e}");
        }
    } else if new_mode != "wallpaper" && old_mode == "wallpaper" {
        if let Err(e) = wallpaper::detach(hwnd) {
            eprintln!("[wallpaper] detach failed: {e}");
        }
    }
}

#[cfg(not(windows))]
fn apply_wallpaper(_app: &AppHandle, _old_mode: &str, _new_mode: &str) {}

#[tauri::command]
fn set_display_mode(mode: String, state: State<Mutex<Prefs>>, app: AppHandle) {
    let old_mode = {
        let mut p = state.lock().unwrap();
        let old = p.display_mode.clone();
        p.display_mode = mode.clone();
        save_prefs(&app, &p);
        old
    };
    // Wallpaper wants the full monitor; bar/strip resize; leaving wallpaper
    // detaches first so the window is a normal top-level again before resizing.
    apply_wallpaper(&app, &old_mode, &mode);
    let size_mode = if mode == "wallpaper" { "full" } else { &mode };
    size_overlay(&app, size_mode);
    let _ = app.emit("display-mode", json!({ "mode": mode, "insets": {} }));
}

#[tauri::command]
fn get_transcribe_config(state: State<Mutex<Prefs>>) -> Value {
    let p = state.lock().unwrap();
    json!({
        "enabled": p.transcribe_enabled,
        "language": p.transcribe_language,
        "model": p.transcribe_model,
    })
}

#[tauri::command]
fn set_transcribe_config(cfg: Value, state: State<Mutex<Prefs>>, app: AppHandle) {
    let mut p = state.lock().unwrap();
    if let Some(v) = cfg.get("enabled").and_then(|v| v.as_bool()) {
        p.transcribe_enabled = v;
    }
    if let Some(v) = cfg.get("language").and_then(|v| v.as_str()) {
        p.transcribe_language = v.to_string();
    }
    if let Some(v) = cfg.get("model").and_then(|v| v.as_str()) {
        p.transcribe_model = v.to_string();
    }
    save_prefs(&app, &p);
}

/// Translate the current track's cached lyrics to English (LLM). Returns the
/// cues directly (the renderer awaits this) and caches them for next time.
#[tauri::command]
fn request_translation(app: AppHandle, state: State<Mutex<CurTrack>>) -> Value {
    let cur = state.lock().unwrap().clone();
    if cur.key.is_empty() {
        return json!({ "status": "error", "message": "nothing playing" });
    }
    if !llm::is_available() {
        return json!({ "status": "error", "message": "no LLM provider configured" });
    }
    let Some(path) = lyrics_cache_path(&app, &cur.key) else {
        return json!({ "status": "error", "message": "no cache dir" });
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return json!({ "status": "error", "message": "lyrics not cached yet" });
    };
    let Ok(mut cached) = serde_json::from_str::<Value>(&text) else {
        return json!({ "status": "error", "message": "cache unreadable" });
    };

    // Already translated in a prior session — return it, no second request.
    if let Some(en) = cached.get("cuesEnglish") {
        if en.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            return json!({ "status": "ok", "cues": en, "language": cached.get("language").cloned().unwrap_or(json!("unknown")) });
        }
    }

    let cues: Vec<lyrics::Cue> = cached
        .get("cues")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if cues.is_empty() {
        return json!({ "status": "error", "message": "no lyrics to translate" });
    }

    match translate::to_english(&cues) {
        Some((language, en_cues)) => {
            let en_val = serde_json::to_value(&en_cues).unwrap_or(Value::Null);
            cached["cuesEnglish"] = en_val.clone();
            cached["language"] = json!(language);
            let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
            json!({ "status": "ok", "cues": en_val, "language": language })
        }
        None => json!({ "status": "error", "message": "translation failed" }),
    }
}

// --- commands whose backends land in later phases. Real signatures so the
//     shim never falls back; benign values until the port fills them in.

#[tauri::command]
fn get_provider_status() -> Value {
    json!({ "provider": llm::active_provider() })
}

#[tauri::command]
fn get_update_state() -> Value {
    json!({ "available": false })
}

#[tauri::command]
fn list_synced() -> Value {
    json!([])
}

#[tauri::command]
fn milkdrop_catalogue() -> Value {
    json!([])
}

#[tauri::command]
fn set_api_key(_name: String, _value: String) {}

#[tauri::command]
fn save_beatmap(_payload: Value) {}

#[tauri::command]
fn save_heatmap(_payload: Value) {}

#[tauri::command]
fn report_jobs(_payload: Value) {}

#[tauri::command]
fn wallpaper_interact(_on: bool) {}

#[tauri::command]
fn end_local_playback() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted prefs into shared state.
            let prefs = load_prefs(&handle);
            let mode = prefs.display_mode.clone();
            app.manage(Mutex::new(prefs));
            app.manage(Mutex::new(CurTrack::default()));

            // Fill the primary monitor at the remembered display mode.
            size_overlay(&handle, &mode);

            // Begin streaming "now playing" from Windows.
            start_smtc(handle.clone());

            // Restore a persisted wallpaper mode after the window has painted a
            // frame, on the main thread (reparenting touches the UI window).
            if mode == "wallpaper" {
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let h3 = h2.clone();
                    let _ = h2.run_on_main_thread(move || {
                        apply_wallpaper(&h3, "full", "wallpaper");
                    });
                });
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_prefs,
            get_offset,
            set_offset,
            set_script,
            set_show_translation,
            get_display_mode,
            set_display_mode,
            get_transcribe_config,
            set_transcribe_config,
            request_translation,
            get_provider_status,
            get_update_state,
            list_synced,
            milkdrop_catalogue,
            set_api_key,
            save_beatmap,
            save_heatmap,
            report_jobs,
            wallpaper_interact,
            end_local_playback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
