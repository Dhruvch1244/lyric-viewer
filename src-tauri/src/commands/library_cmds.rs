//! Commands for the watched-folder library list (JOB-ENGINE.md §5.7, phase 7
//! first cut — see `library.rs`'s module doc for what this pass does and does
//! not cover).

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::state::{save_prefs, AlwaysOnTopGuard, Prefs};

/// Pick a folder and add it to the watch list. Same picker + always-on-top
/// guard shape as `open_local_folder` — see that command's doc for why
/// `(async)` and the guard are both load-bearing, not stylistic.
#[tauri::command(async)]
pub(crate) fn add_library_folder(app: AppHandle, state: State<Mutex<Prefs>>) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let _surfaced = AlwaysOnTopGuard::engage(&app);
    let mut builder = app.dialog().file();
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let Some(folder) = builder.blocking_pick_folder() else {
        return json!({ "status": "cancelled" });
    };
    let Ok(dir) = folder.into_path() else {
        return json!({ "status": "error", "message": "could not resolve that folder path" });
    };
    let path = dir.to_string_lossy().to_string();

    let folders = {
        let mut p = state.lock().unwrap_or_else(|e| e.into_inner());
        if !p.library_folders.iter().any(|f| f == &path) {
            p.library_folders.push(path.clone());
        }
        save_prefs(&app, &p);
        p.library_folders.clone()
    };

    // Scan immediately rather than waiting for the next background tick, so
    // adding a folder shows a real track count right away.
    crate::library::rescan(&app, &folders);
    json!({ "status": "ok", "folders": crate::library::folder_summaries(&app, &folders) })
}

#[tauri::command]
pub(crate) fn remove_library_folder(path: String, app: AppHandle, state: State<Mutex<Prefs>>) -> Value {
    let folders = {
        let mut p = state.lock().unwrap_or_else(|e| e.into_inner());
        p.library_folders.retain(|f| f != &path);
        save_prefs(&app, &p);
        p.library_folders.clone()
    };
    crate::library::forget_folder(&app, &path);
    json!({ "status": "ok", "folders": crate::library::folder_summaries(&app, &folders) })
}

#[tauri::command]
pub(crate) fn get_library_folders(app: AppHandle, state: State<Mutex<Prefs>>) -> Value {
    let folders = state.lock().unwrap_or_else(|e| e.into_inner()).library_folders.clone();
    json!(crate::library::folder_summaries(&app, &folders))
}
