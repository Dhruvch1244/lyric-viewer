//! Lyric Overlay — Tauri backend.
//!
//! This is the Rust replacement for the Electron main process. It owns the
//! things the webview cannot do itself: the transparent always-on-top overlay
//! window, SMTC "now playing" detection, persisted preferences, and (in later
//! phases) wallpaper mode, the updater and the tray.
//!
//! The renderer talks to it through `window.player` (see tauri-shim.js), which
//! maps onto the `#[tauri::command]` functions and the events emitted here.

mod align;
mod artwork;
mod audio;
mod attribute;
mod kugou;
mod llm;
mod lyrics;
mod mood;
mod netease;
mod presets;
mod translate;
mod transliterate;
#[cfg(windows)]
mod wallpaper;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// True while the app is playing a local file itself. The SMTC watcher stands
/// down so its "no session" idle doesn't clear a locally-playing track.
static LOCAL_ACTIVE: AtomicBool = AtomicBool::new(false);

/// True while the overlay is reparented behind the desktop. Gates the pointer-
/// forwarding loop, which is the only way a window under the icons gets clicks.
#[cfg(windows)]
static WALLPAPER_ATTACHED: AtomicBool = AtomicBool::new(false);

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
            // While a local file is playing, ignore SMTC entirely — otherwise its
            // "no session" idle would clear the track the app is playing itself.
            if LOCAL_ACTIVE.load(Ordering::Relaxed) {
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
        let song = if artist.is_empty() { title.clone() } else { format!("{title} — {artist}") };
        set_tray_tooltip(&app, &format!("Lyric Overlay\n{song}"));

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
                    payload["transliterationAvailable"] = json!(llm::is_available());
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
        // LRCLIB first, then NetEase, then Kugou — each only runs when the
        // previous missed, so a song LRCLIB knows costs one request.
        let found = lyrics::fetch_synced(&track)
            .or_else(|| netease::fetch_synced(&track))
            .or_else(|| kugou::fetch_synced(&track));
        match found {
            Some((cues, source)) => {
                let cue_texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
                let payload = json!({
                    "title": title,
                    "artist": artist,
                    "cues": cues,
                    "cuesDevanagari": Value::Null,
                    "cuesEnglish": Value::Null,
                    "source": source,
                    "status": "ok",
                    "indic": false,
                    "hasWordTimings": false,
                    "transliterationAvailable": llm::is_available(),
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
fn artwork_choice_path(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("artwork");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{key}.json")))
}

fn resolve_artwork(app: AppHandle, title: String, artist: String, duration_ms: i64) {
    std::thread::spawn(move || {
        let key = track_key(&artist, &title);
        // A hand-picked cover wins over the automatic sources.
        if let Some(path) = artwork_choice_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if let Some(data) = v.get("data").and_then(|d| d.as_str()) {
                        let _ = app.emit(
                            "artwork",
                            json!({ "track": { "title": title, "artist": artist }, "artwork": data, "chosen": true }),
                        );
                        return;
                    }
                }
            }
        }
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
fn set_script(
    script: String,
    state: State<Mutex<Prefs>>,
    cur: State<Mutex<CurTrack>>,
    app: AppHandle,
) -> Value {
    {
        let mut p = state.lock().unwrap();
        p.script = script.clone();
        save_prefs(&app, &p);
    }
    if script != "devanagari" {
        return json!({ "status": "ok" });
    }
    // Switching to Devanagari: transliterate the current track's cued lyrics
    // (cache-first), the same on-demand path the renderer's अ button expects.
    let key = cur.lock().unwrap().key.clone();
    if key.is_empty() {
        return json!({ "status": "error", "message": "nothing playing" });
    }
    if !llm::is_available() {
        return json!({ "status": "error", "message": "no LLM provider configured" });
    }
    let Some(path) = lyrics_cache_path(&app, &key) else {
        return json!({ "status": "error", "message": "no cache" });
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return json!({ "status": "error", "message": "lyrics not cached" });
    };
    let Ok(mut cached) = serde_json::from_str::<Value>(&text) else {
        return json!({ "status": "error", "message": "cache unreadable" });
    };
    if let Some(deva) = cached.get("cuesDevanagari") {
        if deva.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            return json!({ "status": "ok", "cues": deva });
        }
    }
    let cues: Vec<lyrics::Cue> = cached
        .get("cues")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    match transliterate::to_devanagari(&cues) {
        Some(deva) => {
            let val = serde_json::to_value(&deva).unwrap_or(Value::Null);
            cached["cuesDevanagari"] = val.clone();
            let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
            json!({ "status": "ok", "cues": val })
        }
        None => json!({ "status": "error", "message": "transliteration failed" }),
    }
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
        match wallpaper::attach(hwnd) {
            Ok(()) => WALLPAPER_ATTACHED.store(true, Ordering::Relaxed),
            Err(e) => eprintln!("[wallpaper] attach failed: {e}"),
        }
    } else if new_mode != "wallpaper" && old_mode == "wallpaper" {
        WALLPAPER_ATTACHED.store(false, Ordering::Relaxed);
        if let Err(e) = wallpaper::detach(hwnd) {
            eprintln!("[wallpaper] detach failed: {e}");
        }
    }
}

/// Forward the real cursor to the renderer while in wallpaper mode. A window
/// under the desktop icons receives no clicks — Windows routes them to the
/// desktop — so we poll the cursor + left button at 30Hz and let the renderer
/// synthesise the events (see onWallpaperPointer). Only while attached, and only
/// when the cursor is over the desktop (not another app's window).
#[cfg(windows)]
fn start_pointer_forwarding(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(33));
        if !WALLPAPER_ATTACHED.load(Ordering::Relaxed) {
            continue;
        }
        let Some(hwnd) = window_hwnd(&app) else { continue };
        let Some((x, y)) = wallpaper::cursor_pos() else { continue };
        if !wallpaper::is_cursor_over_desktop(hwnd, x, y) {
            continue;
        }
        let (_down, pressed) = wallpaper::mouse_state();
        let _ = app.emit("wallpaper-pointer", json!({ "x": x, "y": y, "clicked": pressed }));
    });
}

#[cfg(not(windows))]
fn start_pointer_forwarding(_app: AppHandle) {}

#[cfg(not(windows))]
fn apply_wallpaper(_app: &AppHandle, _old_mode: &str, _new_mode: &str) {}

/// Apply a display mode: persist it, enter/leave wallpaper, resize, and tell the
/// renderer. Shared by the command and the Ctrl+Alt+M hotkey.
fn set_mode(app: &AppHandle, mode: &str) {
    let old_mode = match app.try_state::<Mutex<Prefs>>() {
        Some(st) => {
            let mut p = st.lock().unwrap();
            let old = p.display_mode.clone();
            p.display_mode = mode.to_string();
            save_prefs(app, &p);
            old
        }
        None => String::new(),
    };
    // Wallpaper wants the full monitor; bar/strip resize; leaving wallpaper
    // detaches first so the window is a normal top-level again before resizing.
    apply_wallpaper(app, &old_mode, mode);
    let size_mode = if mode == "wallpaper" { "full" } else { mode };
    size_overlay(app, size_mode);
    let _ = app.emit("display-mode", json!({ "mode": mode, "insets": {} }));
}

#[tauri::command]
fn set_display_mode(mode: String, app: AppHandle) {
    set_mode(&app, &mode);
}

/// Start native WASAPI loopback capture of the system output. Returns true
/// optimistically; the renderer confirms real audio by waiting for the first
/// `native-audio` frame and otherwise falls back to getDisplayMedia.
#[tauri::command]
fn start_audio_capture(app: AppHandle) -> bool {
    audio::start_capture(app);
    true
}

#[tauri::command]
fn stop_audio_capture() {
    audio::stop_capture();
}

/// Nudge (delta != 0) or set (absolute) the sync offset, persist, and mirror it
/// to the renderer's offset chip. Backs the Ctrl+Alt+Left/Right/0 hotkeys.
fn change_offset(app: &AppHandle, delta: i64, absolute: Option<i64>) {
    let Some(st) = app.try_state::<Mutex<Prefs>>() else { return };
    let value = {
        let mut p = st.lock().unwrap();
        p.offset_ms = absolute.unwrap_or(p.offset_ms + delta);
        save_prefs(app, &p);
        p.offset_ms
    };
    let _ = app.emit("offset", json!({ "offsetMs": value }));
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

/// Last-known auto-update state, mirrored to the renderer's update card.
struct UpdateStore(Mutex<Value>);

/// Check GitHub for a newer signed release; store + emit the result. Silent on
/// no-update / no-network (the card only appears when there is something to say).
fn check_for_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        if let Ok(Some(update)) = updater.check().await {
            let state = json!({ "available": true, "version": update.version, "status": "available" });
            if let Some(st) = app.try_state::<UpdateStore>() {
                *st.0.lock().unwrap() = state.clone();
            }
            let _ = app.emit("update-state", state);
        }
    });
}

/// Download and install the pending update, then restart into it.
fn install_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        if let Ok(Some(update)) = updater.check().await {
            let _ = app.emit("update-state", json!({ "status": "downloading" }));
            if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                app.restart();
            } else {
                let _ = app.emit("update-state", json!({ "status": "error" }));
            }
        }
    });
}

#[tauri::command]
fn get_update_state(store: State<UpdateStore>) -> Value {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
fn update_action(action: String, app: AppHandle) {
    match action.as_str() {
        "check" => check_for_update(app),
        "install" => install_update(app),
        _ => {} // dismiss: nothing to do
    }
}

/// Every song with cached synced lyrics, for the library panel. Reads the
/// title/artist persisted alongside each cached lyric.
#[tauri::command]
fn list_synced(app: AppHandle) -> Value {
    let Some(dir) = app.path().app_config_dir().ok().map(|d| d.join("lyrics")) else {
        return json!([]);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return json!([]) };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let has_cues = v.get("cues").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
        if title.is_empty() || !has_cues {
            continue;
        }
        out.push(json!({
            "title": title,
            "artist": v.get("artist").and_then(|a| a.as_str()).unwrap_or(""),
            "source": v.get("source"),
        }));
    }
    out.sort_by(|a, b| {
        a["title"].as_str().unwrap_or("").to_lowercase().cmp(&b["title"].as_str().unwrap_or("").to_lowercase())
    });
    json!(out)
}

#[tauri::command]
fn milkdrop_catalogue(app: AppHandle) -> Value {
    json!(presets::catalogue(&app))
}

#[tauri::command]
fn milkdrop_preset(app: AppHandle, name: String) -> Value {
    presets::preset(&app, &name).unwrap_or(Value::Null)
}

#[tauri::command]
fn milkdrop_thumb_get(app: AppHandle, names: Vec<String>) -> Value {
    presets::thumbs_get(&app, &names)
}

#[tauri::command]
fn milkdrop_thumb_put(app: AppHandle, name: String, data_url: String) -> bool {
    presets::thumb_put(&app, &name, &data_url)
}

#[tauri::command]
fn milkdrop_thumb_clear(app: AppHandle) -> bool {
    presets::thumbs_clear(&app)
}

fn keys_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("keys.json"))
}

/// Load any API keys saved via the 🔑 panel into the process environment, so
/// llm.rs (which reads env) picks them up alongside real environment variables.
fn load_api_keys(app: &AppHandle) {
    let Some(path) = keys_path(app) else { return };
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&text) else { return };
    for (k, v) in map {
        if let Some(s) = v.as_str() {
            if std::env::var(&k).is_err() {
                std::env::set_var(&k, s);
            }
        }
    }
}

/// Persist an API key from the 🔑 panel and apply it immediately.
#[tauri::command]
fn set_api_key(name: String, value: String, app: AppHandle) {
    if name.is_empty() {
        return;
    }
    std::env::set_var(&name, &value);
    if let Some(path) = keys_path(&app) {
        let mut map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Map<String, Value>>(&t).ok())
            .unwrap_or_default();
        if value.is_empty() {
            map.remove(&name);
        } else {
            map.insert(name, Value::String(value));
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&map).unwrap_or_default());
    }
}

#[tauri::command]
fn save_beatmap(_payload: Value) {}

#[tauri::command]
fn save_heatmap(_payload: Value) {}

/// Update the tray tooltip with the current song + any background work, so the
/// chromeless overlay has somewhere that says what it is doing.
fn set_tray_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

#[tauri::command]
fn report_jobs(payload: Value, cur: State<Mutex<CurTrack>>, app: AppHandle) {
    let jobs = payload
        .get("jobs")
        .and_then(|j| j.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|j| j.get("label").and_then(|l| l.as_str()))
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .unwrap_or_default();
    let song = {
        let c = cur.lock().unwrap();
        if c.title.is_empty() {
            "Nothing playing".to_string()
        } else if c.artist.is_empty() {
            c.title.clone()
        } else {
            format!("{} — {}", c.title, c.artist)
        }
    };
    let text = if jobs.is_empty() {
        format!("Lyric Overlay\n{song}")
    } else {
        format!("Lyric Overlay\n{song}\n{jobs}")
    };
    set_tray_tooltip(&app, &text);
}

/// Auto-transcription (Whisper) is the one remaining feature: in Electron it ran
/// through onnxruntime-node in the main process; the chosen Tauri path runs it
/// in the webview via transformers.js (WASM/WebGPU), which is a later phase.
/// Until then, report it cleanly so the record→transcribe UI resolves instead of
/// waiting on a promise that never settles.
#[tauri::command]
fn transcribe_audio(app: AppHandle, payload: Value) -> Value {
    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let _ = app.emit(
        "transcribe-progress",
        json!({ "track": track, "stage": "error", "message": "transcription is not available yet in this build" }),
    );
    json!({ "status": "unavailable" })
}

/// Re-emit a transcription progress update from the webview's Whisper run, so it
/// reaches the renderer's existing onTranscribeProgress handler.
#[tauri::command]
fn report_transcribe_progress(app: AppHandle, data: Value) {
    let _ = app.emit("transcribe-progress", data);
}

/// Finalise a webview Whisper result: align the raw transcription to the real
/// plain lyrics where they exist (the correct words on the transcription's
/// clock), cache it as normal synced lyrics for the next play, and report done.
#[tauri::command]
fn finalize_transcription(app: AppHandle, payload: Value) -> Value {
    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let t = track_from_value(&track);
    let raw_cues: Vec<lyrics::Cue> = payload
        .get("cues")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if raw_cues.is_empty() {
        let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "empty" }));
        return json!({ "status": "empty" });
    }
    let key = track_key(&t.artist, &t.title);

    // Prefer the real words on the transcription's timing when we can anchor
    // enough of them; otherwise keep the honest raw transcription.
    let mut final_cues = raw_cues.clone();
    let mut source = "whisper";
    if let Some(plain) = lyrics::fetch_plain(&t) {
        let lines = align::split_plain_lyrics(&plain);
        let (aligned, coverage) = align::align_lyrics(&lines, &raw_cues, t.duration_ms);
        if coverage >= 0.35 && !aligned.is_empty() {
            final_cues = aligned;
            source = "lrclib-plain+whisper";
            let _ = app.emit(
                "transcribe-progress",
                json!({ "track": track, "stage": "aligned", "coverage": (coverage * 100.0).round() }),
            );
        }
    }

    let lines = final_cues.len();
    let payload_out = json!({
        "title": t.title, "artist": t.artist,
        "cues": final_cues,
        "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
        "source": { "name": source },
        "status": "ok", "indic": false, "hasWordTimings": false,
    });
    if let Some(path) = lyrics_cache_path(&app, &key) {
        let _ = std::fs::write(&path, serde_json::to_string(&payload_out).unwrap_or_default());
    }
    let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "done", "lines": lines }));
    json!({ "status": "ok", "lines": lines })
}

#[tauri::command]
fn wallpaper_interact(_on: bool) {}

/// A lyrics::Track from the renderer's {title, artist, durationMs} object.
fn track_from_value(v: &Value) -> lyrics::Track {
    lyrics::Track {
        title: v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        artist: v.get("artist").and_then(|a| a.as_str()).unwrap_or("").to_string(),
        duration_ms: v.get("durationMs").and_then(|d| d.as_i64()).unwrap_or(0),
    }
}

/// Cover-art options for the "choose a different cover" grid (thumbnails inlined).
#[tauri::command]
fn artwork_candidates(app: AppHandle, track: Value) -> Value {
    let t = track_from_value(&track);
    // Off the command thread: this fans out to three sources + thumbnails.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(artwork::fetch_candidates(&t));
    });
    let candidates = rx.recv().unwrap_or(json!([]));
    let _ = app;
    json!({ "candidates": candidates })
}

/// Download and remember a hand-picked cover; emit it as the current artwork.
#[tauri::command]
fn choose_artwork(payload: Value, app: AppHandle) -> Value {
    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let url = payload.get("url").or_else(|| payload.get("fullUrl")).and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return json!({ "status": "error", "message": "no image url" });
    }
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    match artwork::fetch_one(url) {
        Some(data) => {
            if let Some(path) = artwork_choice_path(&app, &key) {
                let _ = std::fs::write(&path, serde_json::to_string(&json!({ "url": url, "data": data })).unwrap_or_default());
            }
            let _ = app.emit(
                "artwork",
                json!({ "track": { "title": t.title, "artist": t.artist }, "artwork": data, "chosen": true }),
            );
            json!({ "status": "ok" })
        }
        None => json!({ "status": "error", "message": "could not download that cover" }),
    }
}

/// Forget a hand-picked cover and go back to the automatic pick.
#[tauri::command]
fn clear_artwork_choice(track: Value, app: AppHandle) {
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    if let Some(path) = artwork_choice_path(&app, &key) {
        let _ = std::fs::remove_file(path);
    }
    resolve_artwork(app.clone(), t.title, t.artist, t.duration_ms);
}

/// The renderer is about to play a local file: announce it as the track (so
/// lyrics + art load) and stand the SMTC watcher down.
#[tauri::command]
fn set_local_track(track: Value, app: AppHandle) {
    LOCAL_ACTIVE.store(true, Ordering::Relaxed);
    let title = track.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let artist = track.get("artist").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let duration = track.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0);
    let _ = app.emit(
        "track",
        json!({ "title": title, "artist": artist, "album": "", "sourceApp": "local", "durationMs": duration }),
    );
    resolve_lyrics(app.clone(), title.clone(), artist.clone(), duration);
    resolve_artwork(app.clone(), title, artist, duration);
}

#[tauri::command]
fn end_local_playback(app: AppHandle) {
    LOCAL_ACTIVE.store(false, Ordering::Relaxed);
    let _ = app.emit("idle", ());
}

/// Audio file extensions the pickers and folder scan accept.
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma"];

/// One queue item from a file path: {localPath, title (filename stem), artist}.
fn local_item(path: &std::path::Path) -> Value {
    let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    json!({ "localPath": path.to_string_lossy(), "title": title, "artist": "" })
}

#[tauri::command]
fn open_local_files(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio", AUDIO_EXTS)
        .blocking_pick_files();
    match picked {
        Some(paths) => json!(paths
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| local_item(&p))
            .collect::<Vec<_>>()),
        None => json!([]),
    }
}

#[tauri::command]
fn open_local_folder(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return json!([]);
    };
    let Ok(dir) = folder.into_path() else { return json!([]) };
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut paths: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
                    .unwrap_or(false)
            })
            .collect();
        paths.sort();
        items = paths.iter().map(|p| local_item(p)).collect();
    }
    json!(items)
}

/// Read a local file's raw bytes. Returned as a binary Response, which the
/// webview receives as an ArrayBuffer for `new Blob([raw])` playback + decode.
#[tauri::command]
fn read_local_file(file_path: String) -> tauri::ipc::Response {
    let bytes = std::fs::read(&file_path).unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// Show the overlay if hidden, hide it if shown; tell the renderer either way
/// so its render loop parks/resumes (see the onVisibility handler).
fn toggle_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let visible = win.is_visible().unwrap_or(true);
    if visible {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("overlay-visibility", json!({ "visible": !visible }));
}

/// Build the system-tray icon + menu (Show/hide, Quit). The overlay has no
/// window chrome and hides on a hotkey, so the tray is the only thing that says
/// it is running. A failure here is non-fatal — the app runs without a tray.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    let toggle = MenuItem::with_id(app, "toggle", "Show / hide overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Lyric Overlay")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_overlay(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                toggle_overlay(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Register the global hotkeys: Ctrl+Alt+Left/Right/0 nudge the sync offset,
/// Ctrl+Alt+H shows/hides the overlay.
fn register_hotkeys(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if !shortcut.mods.contains(ctrl_alt) {
                return;
            }
            match shortcut.key {
                Code::ArrowLeft => change_offset(app, -100, None),
                Code::ArrowRight => change_offset(app, 100, None),
                Code::Digit0 => change_offset(app, 0, Some(0)),
                Code::KeyH => toggle_overlay(app),
                _ => {}
            }
        })
        .build();

    if app.plugin(plugin).is_err() {
        return;
    }
    let gs = app.global_shortcut();
    for code in [Code::ArrowLeft, Code::ArrowRight, Code::Digit0, Code::KeyH] {
        let _ = gs.register(Shortcut::new(Some(ctrl_alt), code));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The getDisplayMedia share-picker bypass for loopback audio is set via the
    // window's `additionalBrowserArgs` in tauri.conf.json — that is the path wry
    // actually passes to WebView2 (the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env
    // var is ignored once wry sets args through the API).

    // The GitHub self-updater is compiled in for the standalone (NSIS) build
    // only. The Microsoft Store build (`--features store`) is a read-only
    // package updated by the Store itself, so the updater plugin is omitted
    // there — which also makes check_for_update()/install_update() silent
    // no-ops via their `app.updater()` guards.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(feature = "store"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = build_tray(&handle);
            register_hotkeys(&handle);

            // Load persisted prefs into shared state. Desktop/wallpaper mode was
            // removed; coerce any saved value so no one boots into a mode that no
            // longer exists (and could trap the UI behind the desktop icons).
            let mut prefs = load_prefs(&handle);
            if prefs.display_mode == "wallpaper" {
                prefs.display_mode = "full".into();
            }
            let mode = prefs.display_mode.clone();
            app.manage(Mutex::new(prefs));
            app.manage(Mutex::new(CurTrack::default()));
            app.manage(UpdateStore(Mutex::new(json!({ "available": false }))));

            // Apply any keys saved via the 🔑 panel, then check for an update.
            load_api_keys(&handle);
            check_for_update(handle.clone());

            // Fill the primary monitor at the remembered display mode.
            size_overlay(&handle, &mode);

            // Begin streaming "now playing" from Windows.
            start_smtc(handle.clone());

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
            start_audio_capture,
            stop_audio_capture,
            get_transcribe_config,
            set_transcribe_config,
            request_translation,
            get_provider_status,
            get_update_state,
            update_action,
            list_synced,
            milkdrop_catalogue,
            milkdrop_preset,
            milkdrop_thumb_get,
            milkdrop_thumb_put,
            milkdrop_thumb_clear,
            set_api_key,
            save_beatmap,
            save_heatmap,
            report_jobs,
            wallpaper_interact,
            artwork_candidates,
            choose_artwork,
            clear_artwork_choice,
            open_local_files,
            open_local_folder,
            read_local_file,
            set_local_track,
            end_local_playback,
            transcribe_audio,
            report_transcribe_progress,
            finalize_transcription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
