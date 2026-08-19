//! Lyric lookup, caching, mood/attribution, translation/transcription
//! finalization, and the pre-sync bulk import. The largest command group —
//! everything here ultimately reads or writes the per-track lyrics cache
//! file under `%APPDATA%/.../lyrics/<key>.json`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{AlwaysOnTopGuard, CurTrack};
use crate::tray::set_tray_tooltip;

/// Filename-safe cache key for a track (djb2 hash of normalised artist+title).
pub(crate) fn track_key(artist: &str, title: &str) -> String {
    let base = format!("{}|{}", artist.to_lowercase().trim(), title.to_lowercase().trim());
    let mut hash: u64 = 5381;
    for b in base.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("{hash:016x}")
}

pub(crate) fn lyrics_cache_path(app: &AppHandle, key: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("lyrics");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(format!("{key}.json")))
}

/// A lyrics::Track from the renderer's {title, artist, durationMs} object.
pub(crate) fn track_from_value(v: &Value) -> crate::lyrics::Track {
    crate::lyrics::Track {
        title: v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        artist: v.get("artist").and_then(|a| a.as_str()).unwrap_or("").to_string(),
        duration_ms: v.get("durationMs").and_then(|d| d.as_i64()).unwrap_or(0),
    }
}

/// Plain (unsynced) lyrics from LRCLIB's plain catalogue, force-aligned to a
/// Whisper transcription's timing by align.rs, never shown as-is.
///
/// Genius (genius.rs) used to be a second source here. Pulled from this hot
/// path: its own module doc confirms genius.com's search endpoint is behind
/// a Cloudflare JS challenge on every request, so calling it here bought
/// nothing but a bounded-timeout network round trip on every LRCLIB-plain
/// miss. The module and its tests stay in the tree — revive the call if
/// Genius's posture or a legitimate access path ever changes.
pub(crate) fn fetch_plain_any(track: &crate::lyrics::Track) -> Option<String> {
    crate::lyrics::fetch_plain(track)
}

/// The lyric texts from a cached `lyrics` payload, for re-running mood analysis.
fn cue_texts_of(payload: &Value) -> Vec<String> {
    payload
        .get("cues")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|c| c.get("text").and_then(|t| t.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

/// Emit the mood-driven palette for a track. A cached mood emits immediately;
/// otherwise the LLM analyses the lyrics once, the result is merged back into the
/// lyrics cache file, and it is emitted. No-op when no provider is configured.
fn resolve_mood(app: &AppHandle, title: &str, artist: &str, key: &str, cue_texts: Vec<String>, cached_mood: Option<Value>) {
    if let Some(m) = cached_mood {
        let mut payload = m;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("mood", payload);
        return;
    }
    let app = app.clone();
    let (title, artist, key) = (title.to_string(), artist.to_string(), key.to_string());
    std::thread::spawn(move || {
        let Some(m) = crate::mood::analyze(&cue_texts) else { return };
        let mood_val = json!({ "mood": m.mood, "hue": m.hue, "energy": m.energy, "palette": m.palette });
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
fn resolve_attribution(app: &AppHandle, title: &str, artist: &str, key: &str, cue_texts: Vec<String>, cached: Option<Value>) {
    if let Some(a) = cached {
        let mut payload = a;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("attribution", payload);
        return;
    }
    let app = app.clone();
    let (title, artist, key) = (title.to_string(), artist.to_string(), key.to_string());
    std::thread::spawn(move || {
        let Some((artists, singers)) = crate::attribute::attribute_lines(&cue_texts, &title, &artist) else {
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

/// Resolve lyrics for a track and emit `lyrics` events. Cache-first: a song
/// heard before replays instantly and offline. Runs on its own thread so the
/// network call never stalls SMTC position ticks.
pub(crate) fn resolve_lyrics(app: AppHandle, title: String, artist: String, duration_ms: i64) {
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
                    payload["translationAvailable"] = json!(crate::llm::is_available());
                    payload["transliterationAvailable"] = json!(crate::llm::is_available());
                    let _ = app.emit("lyrics", payload);
                    resolve_mood(&app, &title, &artist, &key, cue_texts.clone(), cached_mood);
                    resolve_attribution(&app, &title, &artist, &key, cue_texts, cached_attr);
                    return;
                }
            }
        }

        let _ = app.emit("lyrics", json!({ "track": { "title": title, "artist": artist }, "cues": [], "status": "searching" }));

        let track = crate::lyrics::Track { title: title.clone(), artist: artist.clone(), duration_ms };
        // LRCLIB first, then NetEase, then Kugou — each only runs when the
        // previous missed, so a song LRCLIB knows costs one request.
        let found = crate::lyrics::fetch_synced(&track)
            .or_else(|| crate::netease::fetch_synced(&track))
            .or_else(|| crate::kugou::fetch_synced(&track));
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
                    "transliterationAvailable": crate::llm::is_available(),
                    "translationAvailable": crate::llm::is_available(),
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
                // No synced lyrics anywhere — check whether at least the real
                // words exist (LRCLIB plain, then Genius) so the status line
                // can say "timing needed" instead of a flat "not found" when
                // there's actually something for a Whisper pass to align to.
                let plain_available = fetch_plain_any(&track).is_some();
                let _ = app.emit(
                    "lyrics",
                    json!({
                        "track": { "title": title, "artist": artist },
                        "cues": [], "status": "not-found", "indic": false,
                        "plainAvailable": plain_available, "origin": "network",
                    }),
                );
            }
        }
    });
}

/// Manual escape hatch for when every auto-fetch source (LRCLIB/NetEase/
/// Kugou) misses or mismatches and Whisper hasn't run (or can't — an
/// instrumental section, a language it botches): let the user pick a real
/// `.lrc` file themselves. LyricsX and lyricoverlay.com both offer this;
/// this app had no equivalent even though the parser it needs already
/// existed (parse_lrc, shared with the real fetch sources).
///
/// Cached with an object `source` (`{"name": "manual"}`), the same shape
/// every real fetch uses — so `finalize_transcription`'s already-synced
/// guard treats it exactly like a genuine LRCLIB hit: never silently
/// overwritten by a lower-accuracy Whisper pass, but still eligible for the
/// same real per-word-timing upgrade an LRCLIB track gets.
#[tauri::command]
pub(crate) fn import_lyrics(track: Value, app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let t = track_from_value(&track);
    if t.title.is_empty() {
        return json!({ "status": "error", "message": "no track playing" });
    }
    // Same fix as open_local_files: without dropping always-on-top first,
    // the picker opens invisibly behind the overlay.
    let _surfaced = AlwaysOnTopGuard::engage(&app);
    let mut builder = app.dialog().file().add_filter("Lyric files", &["lrc", "txt"]);
    if let Some(win) = app.get_webview_window("main") {
        builder = builder.set_parent(&win);
    }
    let Some(picked) = builder.blocking_pick_file() else {
        return json!({ "status": "cancelled" });
    };
    let Ok(path) = picked.into_path() else {
        return json!({ "status": "error", "message": "could not resolve that file path" });
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return json!({ "status": "error", "message": "could not read that file" });
    };
    let cues = crate::lyrics::parse_lrc(&text);
    if cues.is_empty() {
        return json!({ "status": "error", "message": "no timed [mm:ss.xx] lines found in that file" });
    }
    let key = track_key(&t.artist, &t.title);
    let lines = cues.len();
    let payload = json!({
        "title": t.title, "artist": t.artist,
        "cues": cues,
        "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
        "source": { "name": "manual" },
        "status": "ok", "indic": false, "hasWordTimings": false,
    });
    if let Some(cache_path) = lyrics_cache_path(&app, &key) {
        let _ = std::fs::write(&cache_path, serde_json::to_string(&payload).unwrap_or_default());
    }
    let mut out = payload;
    out["track"] = json!({ "title": t.title, "artist": t.artist });
    out["origin"] = json!("manual");
    out["transliterationAvailable"] = json!(crate::llm::is_available());
    out["translationAvailable"] = json!(crate::llm::is_available());
    let _ = app.emit("lyrics", out);
    json!({ "status": "ok", "lines": lines })
}

/// Forget an imported `.lrc` and go back to the automatic sources.
#[tauri::command]
pub(crate) fn clear_manual_lyrics(track: Value, app: AppHandle) {
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    if let Some(path) = lyrics_cache_path(&app, &key) {
        let _ = std::fs::remove_file(path);
    }
    resolve_lyrics(app.clone(), t.title, t.artist, t.duration_ms);
}

/// Translate the current track's cached lyrics to English (LLM). Returns the
/// cues directly (the renderer awaits this) and caches them for next time.
#[tauri::command]
pub(crate) fn request_translation(app: AppHandle, state: State<Mutex<CurTrack>>) -> Value {
    let cur = state.lock().unwrap().clone();
    if cur.key.is_empty() {
        return json!({ "status": "error", "message": "nothing playing" });
    }
    if !crate::llm::is_available() {
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

    let cues: Vec<crate::lyrics::Cue> = cached.get("cues").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    if cues.is_empty() {
        return json!({ "status": "error", "message": "no lyrics to translate" });
    }

    match crate::translate::to_english(&cues) {
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

/// Merge fields into a track's on-disk cache record, creating it if absent.
/// Mirrors Electron's `llmCache.merge` — only the given keys are touched, so
/// lyrics, a beat map and a heat map can each land independently as they're
/// learned, without clobbering each other.
fn merge_track_cache(app: &AppHandle, key: &str, patch: &Value) {
    let Some(path) = lyrics_cache_path(app, key) else { return };
    let mut cached: Value =
        std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
    if let (Some(obj), Some(patch_obj)) = (cached.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
}

/// A track's title/artist out of the `{track, beatmap|heatmap}` payload
/// shape tauri-shim.js sends, or None if either is missing.
fn track_name_from_payload(payload: &Value) -> Option<(&str, &str)> {
    let t = payload.get("track")?.as_object()?;
    let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let artist = t.get("artist").and_then(|v| v.as_str()).unwrap_or("");
    if title.is_empty() && artist.is_empty() {
        return None;
    }
    Some((title, artist))
}

/// Persist a beat map the renderer learned from live audio, keyed by track —
/// "learn once, replay next time" needs this to actually land on disk.
#[tauri::command]
pub(crate) fn save_beatmap(payload: Value, app: AppHandle) -> Value {
    let beatmap = payload.get("beatmap").cloned();
    let (Some((title, artist)), Some(beatmap)) = (track_name_from_payload(&payload), beatmap) else {
        return json!({ "status": "ignored" });
    };
    let key = track_key(artist, title);
    merge_track_cache(&app, &key, &json!({ "beatmap": beatmap, "title": title, "artist": artist }));
    json!({ "status": "ok" })
}

/// Persist the heat map (energy arc binned against position) the renderer
/// learned from live audio, keyed by track. Separate from the beat map
/// because it's learned at a different rate and answers a different
/// question — storing the arc is what makes it a property of the SONG
/// rather than of one playthrough.
#[tauri::command]
pub(crate) fn save_heatmap(payload: Value, app: AppHandle) -> Value {
    let heatmap = payload.get("heatmap").cloned();
    let has_bins = heatmap.as_ref().and_then(|h| h.get("bins")).map(|b| b.is_array()).unwrap_or(false);
    let (Some((title, artist)), Some(heatmap)) = (track_name_from_payload(&payload), heatmap) else {
        return json!({ "status": "ignored" });
    };
    if !has_bins {
        return json!({ "status": "ignored" });
    }
    let key = track_key(artist, title);
    merge_track_cache(&app, &key, &json!({ "heatmap": heatmap, "title": title, "artist": artist }));
    json!({ "status": "ok" })
}

/// Every song with cached synced lyrics, for the library panel. Reads the
/// title/artist persisted alongside each cached lyric.
#[tauri::command]
pub(crate) fn list_synced(app: AppHandle) -> Value {
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
    out.sort_by_key(|v: &Value| v["title"].as_str().unwrap_or("").to_lowercase());
    json!(out)
}

/// Auto-transcription (Whisper) is the one remaining feature: in Electron it ran
/// through onnxruntime-node in the main process; the chosen Tauri path runs it
/// in the webview via transformers.js (WASM/WebGPU), which is a later phase.
/// Until then, report it cleanly so the record→transcribe UI resolves instead of
/// waiting on a promise that never settles.
#[tauri::command]
pub(crate) fn transcribe_audio(app: AppHandle, payload: Value) -> Value {
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
pub(crate) fn report_transcribe_progress(app: AppHandle, data: Value) {
    let _ = app.emit("transcribe-progress", data);
}

/// A cached lyrics payload's `source` is a bare string ("whisper",
/// "lrclib-plain+whisper", or "whisper+llm") only when THIS function
/// produced it; every real fetch (LRCLIB/NetEase/Kugou) stores an object.
/// Used to tell "already has the correct synced lyrics" apart from "was
/// itself transcribed".
fn source_is_whisper_derived(source: &Value) -> bool {
    matches!(source.as_str(), Some("whisper") | Some("lrclib-plain+whisper") | Some("whisper+llm"))
}

/// Finalise a webview Whisper result: align the raw transcription to the real
/// plain lyrics where they exist (the correct words on the transcription's
/// clock), cache it as normal synced lyrics for the next play, and report done.
///
/// `hasWordTimings` on the output payload reflects whether ANY line actually
/// got measured per-word timing out of align_lyrics — not every line does
/// (see its word-count-match guard), so a track can be `true` with only a
/// partial `cue.words` coverage across its lines. A track with `false` makes
/// the renderer listen-and-transcribe again next play (see
/// `beginTranscriptionListen` in renderer.js), on the theory that another
/// pass might anchor lines the first one didn't. `already_synced` below is
/// the guard against re-deriving a track that has real (non-Whisper) synced
/// lyrics already — without it this would silently overwrite LRCLIB-correct
/// lyrics with a Whisper-accuracy version on every single play.
#[tauri::command]
pub(crate) fn finalize_transcription(app: AppHandle, payload: Value) -> Value {
    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let t = track_from_value(&track);
    let raw_cues: Vec<crate::lyrics::Cue> = payload.get("cues").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    if raw_cues.is_empty() {
        let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "empty" }));
        return json!({ "status": "empty" });
    }
    let key = track_key(&t.artist, &t.title);

    if let Some(path) = lyrics_cache_path(&app, &key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<Value>(&text) {
                let has_cues = existing.get("cues").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
                let already_synced = has_cues && !source_is_whisper_derived(existing.get("source").unwrap_or(&Value::Null));
                if already_synced {
                    let existing_has_words = existing.get("hasWordTimings").and_then(|v| v.as_bool()).unwrap_or(false);
                    if existing_has_words {
                        let _ = app.emit(
                            "transcribe-progress",
                            json!({ "track": track, "stage": "done", "lines": 0, "skipped": "already-synced" }),
                        );
                        return json!({ "status": "skipped", "reason": "already-synced" });
                    }
                    // Real synced text (LRCLIB/NetEase/Kugou), just no per-word
                    // timing yet — this is exactly what beginTranscriptionListen
                    // in renderer.js is fishing for. Attach words to the trusted
                    // line text/timing rather than falling through to the
                    // whisper-only path below, which would replace both with a
                    // lower-accuracy transcription (the exact bug 0.30.0 fixed).
                    let existing_cues: Vec<crate::lyrics::Cue> =
                        existing.get("cues").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                    let merged = crate::align::attach_word_timings(existing_cues, &raw_cues, t.duration_ms);
                    let upgraded_lines = merged.iter().filter(|c| c.words.is_some()).count();
                    if upgraded_lines > 0 {
                        let mut updated = existing.clone();
                        updated["cues"] = serde_json::to_value(&merged).unwrap_or(Value::Null);
                        updated["hasWordTimings"] = json!(true);
                        let _ = std::fs::write(&path, serde_json::to_string(&updated).unwrap_or_default());
                        let _ = app.emit(
                            "transcribe-progress",
                            json!({ "track": track, "stage": "words-added", "lines": upgraded_lines, "total": merged.len() }),
                        );
                        return json!({ "status": "ok", "lines": upgraded_lines });
                    }
                    // Nothing anchored cleanly this pass — leave the cache
                    // untouched (still correct, just still line-level) so the
                    // renderer's hasWordTimings stays false and tries again on
                    // a future play, same retry semantics as the whisper-only
                    // path below.
                    let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "align-weak" }));
                    return json!({ "status": "skipped", "reason": "no-anchors" });
                }
            }
        }
    }

    // Prefer the real words on the transcription's timing when we can anchor
    // enough of them; otherwise keep the honest raw transcription.
    let mut final_cues = raw_cues.clone();
    let mut source = "whisper";
    if let Some(plain) = fetch_plain_any(&t) {
        let lines = crate::align::split_plain_lyrics(&plain);
        let (aligned, coverage) = crate::align::align_lyrics(&lines, &raw_cues, t.duration_ms);
        if coverage >= 0.35 && !aligned.is_empty() {
            final_cues = aligned;
            source = "lrclib-plain+whisper";
            let _ =
                app.emit("transcribe-progress", json!({ "track": track, "stage": "aligned", "coverage": (coverage * 100.0).round() }));
        }
    }

    // LLM correction — the "brain" half of the ear/brain split. Deliberately
    // guarded on source == "whisper": if the block above anchored real
    // LRCLIB lyrics onto Whisper's clock, the words are already correct and
    // asking a model to "correct" them can only make them wrong. Runs
    // exactly when there is nothing but what Whisper itself heard, which is
    // also when it is worth the most.
    if source == "whisper" {
        let (corrected, changed) = crate::correct::correct_transcript(&final_cues, &t.title, &t.artist, |batch, batches| {
            let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "correcting", "batch": batch, "batches": batches }));
        });
        if changed > 0 {
            final_cues = corrected;
            source = "whisper+llm";
            let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "corrected", "changed": changed }));
        }
    }

    let lines = final_cues.len();
    let has_word_timings = final_cues.iter().any(|c| c.words.is_some());
    let payload_out = json!({
        "title": t.title, "artist": t.artist,
        "cues": final_cues,
        "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
        "source": { "name": source },
        "status": "ok", "indic": false, "hasWordTimings": has_word_timings,
    });
    if let Some(path) = lyrics_cache_path(&app, &key) {
        let _ = std::fs::write(&path, serde_json::to_string(&payload_out).unwrap_or_default());
    }
    let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "done", "lines": lines }));
    json!({ "status": "ok", "lines": lines })
}

/// Bumped on every `presync_list` call so an in-flight run can tell it has
/// been superseded by a newer paste and stop early instead of racing it.
static PRESYNC_TOKEN: AtomicU64 = AtomicU64::new(0);

/// Parse one pasted playlist line into (artist, title). Accepts
/// "Artist - Title" (hyphen or en/em dash); a line with no separator is
/// treated as a bare title.
fn parse_track_line(line: &str) -> Option<(String, String)> {
    let s = line.trim();
    if s.is_empty() {
        return None;
    }
    let re = regex::Regex::new(r"\s+[-\u{2013}\u{2014}]\s+").unwrap();
    if let Some(m) = re.find(s) {
        let artist = s[..m.start()].trim().to_string();
        let title = s[m.end()..].trim().to_string();
        return Some((artist, title));
    }
    Some((String::new(), s.to_string()))
}

/// Fetch + cache synced lyrics for a single pre-sync track, skipping ones
/// already on disk. Mirrors `resolve_lyrics`'s fetch chain, minus the SMTC
/// event emission — this runs ahead of any playback.
fn presync_one(app: &AppHandle, artist: &str, title: &str) -> &'static str {
    let key = track_key(artist, title);
    if let Some(path) = lyrics_cache_path(app, &key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                if cached.get("cues").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
                    return "cached";
                }
            }
        }
    }
    let track = crate::lyrics::Track { title: title.to_string(), artist: artist.to_string(), duration_ms: 0 };
    let found =
        crate::lyrics::fetch_synced(&track).or_else(|| crate::netease::fetch_synced(&track)).or_else(|| crate::kugou::fetch_synced(&track));
    match found {
        Some((cues, source)) if !cues.is_empty() => {
            let payload = json!({
                "title": title, "artist": artist, "cues": cues,
                "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
                "source": source, "status": "ok", "indic": false, "hasWordTimings": false,
            });
            if let Some(path) = lyrics_cache_path(app, &key) {
                let _ = std::fs::write(&path, serde_json::to_string(&payload).unwrap_or_default());
            }
            "ok"
        }
        _ => "not-found",
    }
}

/// Bulk pre-sync: fetch + cache synced lyrics for a pasted "Artist - Title"
/// list, so those songs play instantly and offline later. Runs sequentially
/// (politely — LRCLIB gets a short gap between requests) and streams
/// `presync-progress` events; a fresh call supersedes any run in flight.
#[tauri::command]
pub(crate) fn presync_list(text: String, app: AppHandle) -> Value {
    let tracks: Vec<(String, String)> = text.lines().filter_map(parse_track_line).collect();
    let token = PRESYNC_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let total = tracks.len();

    if total == 0 {
        let _ = app.emit("presync-progress", json!({ "done": 0, "total": 0, "status": "done", "summary": "nothing to sync" }));
        return json!({ "status": "empty" });
    }

    let (mut done, mut synced, mut cached, mut missed) = (0usize, 0usize, 0usize, 0usize);
    for (artist, title) in &tracks {
        if PRESYNC_TOKEN.load(Ordering::SeqCst) != token {
            return json!({ "status": "cancelled" });
        }
        let label = if artist.is_empty() { title.clone() } else { format!("{artist} - {title}") };
        let _ = app.emit("presync-progress", json!({ "done": done, "total": total, "status": "running", "current": label }));
        match presync_one(&app, artist, title) {
            "ok" => synced += 1,
            "cached" => cached += 1,
            _ => missed += 1,
        }
        done += 1;
        std::thread::sleep(std::time::Duration::from_millis(150)); // be polite to LRCLIB
    }

    let summary = format!("{synced} synced · {cached} already cached · {missed} not found");
    let _ = app.emit("presync-progress", json!({ "done": done, "total": total, "status": "done", "summary": summary }));
    json!({ "status": "ok", "synced": synced, "cached": cached, "missed": missed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_key_is_case_and_whitespace_insensitive() {
        assert_eq!(track_key("Seedhe Maut", "101"), track_key(" seedhe maut ", "101"));
        assert_eq!(track_key("Artist", "Title"), track_key("ARTIST", "TITLE"));
    }

    #[test]
    fn track_key_distinguishes_different_tracks() {
        assert_ne!(track_key("Artist", "Title One"), track_key("Artist", "Title Two"));
    }

    #[test]
    fn parse_track_line_splits_on_hyphen() {
        assert_eq!(parse_track_line("Seedhe Maut - 101"), Some(("Seedhe Maut".to_string(), "101".to_string())));
    }

    #[test]
    fn parse_track_line_splits_on_en_and_em_dash() {
        assert_eq!(parse_track_line("Artist \u{2013} Title"), Some(("Artist".to_string(), "Title".to_string())));
        assert_eq!(parse_track_line("Artist \u{2014} Title"), Some(("Artist".to_string(), "Title".to_string())));
    }

    #[test]
    fn parse_track_line_with_no_separator_is_a_bare_title() {
        assert_eq!(parse_track_line("Just A Title"), Some((String::new(), "Just A Title".to_string())));
    }

    #[test]
    fn parse_track_line_ignores_blank_lines() {
        assert_eq!(parse_track_line(""), None);
        assert_eq!(parse_track_line("   "), None);
    }

    #[test]
    fn parse_track_line_uses_the_first_separator_only() {
        // A title that itself contains " - " keeps the rest on the title side.
        assert_eq!(parse_track_line("Artist - Title - Remix"), Some(("Artist".to_string(), "Title - Remix".to_string())));
    }

    #[test]
    fn source_is_whisper_derived_matches_known_strings_only() {
        assert!(source_is_whisper_derived(&json!("whisper")));
        assert!(source_is_whisper_derived(&json!("lrclib-plain+whisper")));
        assert!(source_is_whisper_derived(&json!("whisper+llm")));
        assert!(!source_is_whisper_derived(&json!({ "name": "lrclib" })));
        assert!(!source_is_whisper_derived(&Value::Null));
    }

    #[test]
    fn cue_texts_of_extracts_text_in_order() {
        let payload = json!({ "cues": [{ "text": "first" }, { "text": "second" }, {}] });
        assert_eq!(cue_texts_of(&payload), vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn cue_texts_of_handles_a_missing_cues_field() {
        assert_eq!(cue_texts_of(&json!({})), Vec::<String>::new());
    }

    #[test]
    fn track_name_from_payload_reads_title_and_artist() {
        let payload = json!({ "track": { "title": "101", "artist": "Seedhe Maut" } });
        assert_eq!(track_name_from_payload(&payload), Some(("101", "Seedhe Maut")));
    }

    #[test]
    fn track_name_from_payload_rejects_a_fully_empty_track() {
        let payload = json!({ "track": { "title": "", "artist": "" } });
        assert_eq!(track_name_from_payload(&payload), None);
    }

    #[test]
    fn track_name_from_payload_rejects_a_missing_track() {
        assert_eq!(track_name_from_payload(&json!({})), None);
    }
}
