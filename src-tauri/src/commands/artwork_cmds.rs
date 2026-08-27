//! Cover art: automatic fetch on track change, the "choose a different
//! cover" candidate grid, and remembering a hand-picked choice per track.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::lyrics_cmds::{track_from_value, track_key};
use crate::jobs::{self, CancelToken, Lane, Priority, Runnable};

/// Fetch cover art for a track and emit it to the renderer, on its own thread.
/// The renderer uses the image as the blurred backdrop and derives a palette
/// from it, so a miss simply leaves the hash-palette wash in place.
pub(crate) fn artwork_choice_path(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("artwork");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{key}.json")))
}

/// Queue the cover-art lookup on the engine's I/O lane. Separate job from the
/// lyric fetch on purpose: they share a track (so one `cancel_track` stops
/// both) but not a dedup key, so a miss on one never suppresses the other.
pub(crate) fn resolve_artwork(app: AppHandle, title: String, artist: String, duration_ms: i64) {
    // Same canonicalization as resolve_lyrics (lyrics_cmds.rs) — both are
    // called back to back with the same raw title/artist (watchers.rs,
    // playback.rs) and must land on the same track_key, or lyrics and
    // artwork for one song split into two cache entries.
    let title = crate::lyrics::clean_title(&title);
    let artist = crate::lyrics::clean_artist(&artist);
    let key = track_key(&artist, &title);
    jobs::submit(ArtworkJob { app, title, artist, duration_ms, key }, Priority::Now);
}

struct ArtworkJob {
    app: AppHandle,
    title: String,
    artist: String,
    duration_ms: i64,
    key: String,
}

impl Runnable for ArtworkJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("artwork:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let ArtworkJob { app, title, artist, duration_ms, key } = *self;

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
        let art = crate::artwork::fetch_artwork(&track);
        // Checked after the fetch, not before the emit only: a stale cover
        // painted over the song that is actually playing is the visible bug
        // this prevents.
        if cancel.cancelled() {
            return;
        }
        if let Some(art) = art {
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
    }
}

/// Cover-art options for the "choose a different cover" grid (thumbnails inlined).
///
/// NOT a job on the engine, unlike every other fetch in this module: the
/// renderer awaits this one and paints the grid from its return value, and the
/// engine is fire-and-forget — jobs emit events, they have no reply channel.
/// `(async)` is the whole fix it needs.
///
/// It previously spawned a thread and then blocked on `rx.recv()`, which reads
/// as "off the command thread" but is not: the sync `#[tauri::command]` ran on
/// the main thread and then sat there waiting for a three-source network
/// fan-out plus thumbnail downloads to finish. Same defect as the file pickers
/// (see `import_lyrics`), minus the true deadlock — the event loop stalled for
/// the duration rather than forever. `(async)` puts the whole call on the
/// async runtime, so the helper thread and channel have nothing left to do.
#[tauri::command(async)]
pub(crate) fn artwork_candidates(app: AppHandle, track: Value) -> Value {
    let t = track_from_value(&track);
    let _ = app;
    json!({ "candidates": crate::artwork::fetch_candidates(&t) })
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
