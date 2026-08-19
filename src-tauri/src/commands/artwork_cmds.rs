//! Cover art: automatic fetch on track change, the "choose a different
//! cover" candidate grid, and remembering a hand-picked choice per track.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::lyrics_cmds::{track_from_value, track_key};

/// Fetch cover art for a track and emit it to the renderer, on its own thread.
/// The renderer uses the image as the blurred backdrop and derives a palette
/// from it, so a miss simply leaves the hash-palette wash in place.
pub(crate) fn artwork_choice_path(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("artwork");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{key}.json")))
}

pub(crate) fn resolve_artwork(app: AppHandle, title: String, artist: String, duration_ms: i64) {
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
        let track = crate::lyrics::Track { title: title.clone(), artist: artist.clone(), duration_ms };
        if let Some(art) = crate::artwork::fetch_artwork(&track) {
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

/// Cover-art options for the "choose a different cover" grid (thumbnails inlined).
#[tauri::command]
pub(crate) fn artwork_candidates(app: AppHandle, track: Value) -> Value {
    let t = track_from_value(&track);
    // Off the command thread: this fans out to three sources + thumbnails.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(crate::artwork::fetch_candidates(&t));
    });
    let candidates = rx.recv().unwrap_or(json!([]));
    let _ = app;
    json!({ "candidates": candidates })
}

/// Download and remember a hand-picked cover; emit it as the current artwork.
#[tauri::command]
pub(crate) fn choose_artwork(payload: Value, app: AppHandle) -> Value {
    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let url = payload.get("url").or_else(|| payload.get("fullUrl")).and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return json!({ "status": "error", "message": "no image url" });
    }
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    match crate::artwork::fetch_one(url) {
        Some(data) => {
            if let Some(path) = artwork_choice_path(&app, &key) {
                let _ = std::fs::write(&path, serde_json::to_string(&json!({ "url": url, "data": data })).unwrap_or_default());
            }
            let _ = app.emit("artwork", json!({ "track": { "title": t.title, "artist": t.artist }, "artwork": data, "chosen": true }));
            json!({ "status": "ok" })
        }
        None => json!({ "status": "error", "message": "could not download that cover" }),
    }
}

/// Forget a hand-picked cover and go back to the automatic pick.
#[tauri::command]
pub(crate) fn clear_artwork_choice(track: Value, app: AppHandle) {
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    if let Some(path) = artwork_choice_path(&app, &key) {
        let _ = std::fs::remove_file(path);
    }
    resolve_artwork(app.clone(), t.title, t.artist, t.duration_ms);
}
