//! Preferences: the persisted settings panel (script, translation, transcribe
//! config, autostart, sync offset) and the 🔑 panel's API key store.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::lyrics_cmds::lyrics_cache_path;
use crate::state::{save_prefs, CurTrack, Prefs, CRASH_REPORTING_ENABLED};

#[tauri::command]
pub(crate) fn get_prefs(state: State<Mutex<Prefs>>) -> Value {
    let p = state.lock().unwrap();
    json!({
        "script": p.script,
        "showTranslation": p.show_translation,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "crashReportingEnabled": p.crash_reporting_enabled,
    })
}

/// Toggle opt-in remote crash reporting (see crashlog.rs). Off by default;
/// this is the only thing that can turn it on, and it always stays a
/// deliberate, visible choice in the 🔑 panel — never inferred, never turned
/// on for the user.
#[tauri::command]
pub(crate) fn set_crash_reporting(enabled: bool, state: State<Mutex<Prefs>>, app: AppHandle) {
    let mut p = state.lock().unwrap();
    p.crash_reporting_enabled = enabled;
    save_prefs(&app, &p);
    CRASH_REPORTING_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub(crate) fn get_offset(state: State<Mutex<Prefs>>) -> Value {
    json!({ "offsetMs": state.lock().unwrap().offset_ms })
}

#[tauri::command]
pub(crate) fn set_offset(value_ms: i64, state: State<Mutex<Prefs>>, app: AppHandle) -> i64 {
    {
        let mut p = state.lock().unwrap();
        p.offset_ms = value_ms;
        save_prefs(&app, &p);
    }
    let _ = app.emit("offset", json!({ "offsetMs": value_ms }));
    value_ms
}

/// Nudge (delta != 0) or set (absolute) the sync offset, persist, and mirror it
/// to the renderer's offset chip. Backs the Ctrl+Alt+Left/Right/0 hotkeys.
pub(crate) fn change_offset(app: &AppHandle, delta: i64, absolute: Option<i64>) {
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
pub(crate) fn set_script(script: String, state: State<Mutex<Prefs>>, cur: State<Mutex<CurTrack>>, app: AppHandle) -> Value {
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
    if !crate::llm::is_available() {
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
    let cues: Vec<crate::lyrics::Cue> = cached.get("cues").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    match crate::transliterate::to_devanagari(&cues) {
        Ok(deva) => {
            let val = serde_json::to_value(&deva).unwrap_or(Value::Null);
            cached["cuesDevanagari"] = val.clone();
            let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
            json!({ "status": "ok", "cues": val })
        }
        Err(message) => json!({ "status": "error", "message": message }),
    }
}

#[tauri::command]
pub(crate) fn set_show_translation(show: bool, state: State<Mutex<Prefs>>, app: AppHandle) {
    let mut p = state.lock().unwrap();
    p.show_translation = show;
    save_prefs(&app, &p);
}

#[tauri::command]
pub(crate) fn get_display_mode(state: State<Mutex<Prefs>>) -> String {
    state.lock().unwrap().display_mode.clone()
}

#[tauri::command]
pub(crate) fn set_display_mode(mode: String, app: AppHandle) {
    crate::commands::playback::set_mode(&app, &mode);
}

/// Toggle "launch on Windows startup". Registered as a no-op returning `false`
/// on the Store build: MSIX packages declare startup via the AppX StartupTask
/// extension instead of a registry Run key, so the registry-based plugin is
/// only wired in for the standalone (NSIS) build — see the updater's same
/// `store` gating for the reasoning.
#[cfg(not(feature = "store"))]
#[tauri::command]
pub(crate) fn set_autostart(enabled: bool, app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled { mgr.enable() } else { mgr.disable() }.is_ok()
}

#[cfg(feature = "store")]
#[tauri::command]
pub(crate) fn set_autostart(_enabled: bool, _app: AppHandle) -> bool {
    false
}

#[cfg(not(feature = "store"))]
#[tauri::command]
pub(crate) fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(feature = "store")]
#[tauri::command]
pub(crate) fn get_autostart(_app: AppHandle) -> bool {
    false
}

#[tauri::command]
pub(crate) fn get_transcribe_config(state: State<Mutex<Prefs>>) -> Value {
    let p = state.lock().unwrap();
    json!({
        "enabled": p.transcribe_enabled,
        "language": p.transcribe_language,
        "model": p.transcribe_model,
        "vocalIsolation": p.vocal_isolation,
    })
}

#[tauri::command]
pub(crate) fn set_transcribe_config(cfg: Value, state: State<Mutex<Prefs>>, app: AppHandle) {
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
    if let Some(v) = cfg.get("vocalIsolation").and_then(|v| v.as_bool()) {
        p.vocal_isolation = v;
    }
    save_prefs(&app, &p);
}

fn keys_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("keys.json"))
}

/// Load any API keys saved via the 🔑 panel into the process environment, so
/// llm.rs (which reads env) picks them up alongside real environment variables.
pub(crate) fn load_api_keys(app: &AppHandle) {
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
pub(crate) fn set_api_key(name: String, value: String, app: AppHandle) -> Value {
    // Returns a status object rather than unit, and that is load-bearing: the
    // renderer's `res.status === 'ok'` check (saveApiKey in renderer.js) threw
    // on `null.status` back when this returned unit, so every save reported
    // "save failed" while actually succeeding. Keep the shape.
    if name.is_empty() {
        return json!({ "status": "error", "message": "no key name" });
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
    json!({ "status": "ok", "provider": crate::llm::active_provider() })
}
