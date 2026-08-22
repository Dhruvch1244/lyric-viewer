//! Lyric lookup, caching, mood/attribution, translation/transcription
//! finalization, and the pre-sync bulk import. The largest command group —
//! everything here ultimately reads or writes the per-track lyrics cache
//! file under `%APPDATA%/.../lyrics/<key>.json`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::jobs::{self, CancelToken, Lane, Priority, Runnable};
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
    jobs::submit(
        MoodJob {
            app: app.clone(),
            title: title.to_string(),
            artist: artist.to_string(),
            key: key.to_string(),
            cue_texts,
        },
        Priority::Now,
    );
}

/// The I/O-lane job behind `resolve_mood`. I/O and not CPU despite the name:
/// `mood::analyze` is an LLM round trip, so this waits on a socket.
struct MoodJob {
    app: AppHandle,
    title: String,
    artist: String,
    key: String,
    cue_texts: Vec<String>,
}

impl Runnable for MoodJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("mood:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let MoodJob { app, title, artist, key, cue_texts } = *self;
        if cancel.cancelled() {
            return;
        }
        let Some(m) = crate::mood::analyze(&cue_texts) else { return };
        let mood_val = json!({ "mood": m.mood, "hue": m.hue, "energy": m.energy, "palette": m.palette });
        // Merge the mood into the lyrics cache so it runs once per song.
        //
        // Written even when cancelled, deliberately: the LLM call is already
        // paid for and the file is keyed by track, so caching it means the
        // song is instant next time. Only the *emit* below is withheld — a
        // stale palette repainting the song that is actually playing now is
        // the visible bug, and it is the emit that causes it, not the write.
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                    cached["mood"] = mood_val.clone();
                    let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
                }
            }
        }
        if cancel.cancelled() {
            return;
        }
        let mut payload = mood_val;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("mood", payload);
    }
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
    jobs::submit(
        AttributionJob {
            app: app.clone(),
            title: title.to_string(),
            artist: artist.to_string(),
            key: key.to_string(),
            cue_texts,
        },
        Priority::Now,
    );
}

/// The I/O-lane job behind `resolve_attribution` — like `MoodJob`, an LLM
/// round trip rather than local computation.
///
/// A separate job from `MoodJob` even though both fire at the same moment and
/// both merge into the same cache file: they are independent LLM calls, so one
/// failing or being skipped must not suppress the other. Distinct dedup keys,
/// shared track key, so a single `cancel_track` still stops both.
struct AttributionJob {
    app: AppHandle,
    title: String,
    artist: String,
    key: String,
    cue_texts: Vec<String>,
}

impl Runnable for AttributionJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("attribution:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let AttributionJob { app, title, artist, key, cue_texts } = *self;
        if cancel.cancelled() {
            return;
        }
        let Some((artists, singers)) = crate::attribute::attribute_lines(&cue_texts, &title, &artist) else {
            return;
        };
        let attr = json!({ "artists": artists, "singers": singers });
        // Cached even when cancelled — same reasoning as `MoodJob::run`.
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                    cached["attribution"] = attr.clone();
                    let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
                }
            }
        }
        if cancel.cancelled() {
            return;
        }
        let mut payload = attr;
        payload["track"] = json!({ "title": title, "artist": artist });
        let _ = app.emit("attribution", payload);
    }
}

/// Resolve lyrics for a track and emit `lyrics` events. Cache-first: a song
/// heard before replays instantly and offline.
///
/// The fetch itself is a job on the engine's I/O lane, so a track change
/// cancels it (`jobs::cancel_track`) instead of leaving a doomed lookup racing
/// the new song's. What is NOT deferred is the `CurTrack`/tray update below:
/// that is state, not I/O, and other commands (`request_translation`,
/// `finalize_transcription`) read it immediately — it must not sit behind a
/// queue, however short.
pub(crate) fn resolve_lyrics(app: AppHandle, title: String, artist: String, duration_ms: i64) {
    let key = track_key(&artist, &title);
    // Abandon the previous song's outstanding lookups before starting this
    // one's. Every track-change path reaches here, so this is the one place
    // that needs to know.
    jobs::set_current_track(&key);
    if let Some(st) = app.try_state::<Mutex<CurTrack>>() {
        *st.lock().unwrap() = CurTrack { title: title.clone(), artist: artist.clone(), key: key.clone() };
    }
    let song = if artist.is_empty() { title.clone() } else { format!("{title} — {artist}") };
    set_tray_tooltip(&app, &format!("Lyric Overlay\n{song}"));

    // Phase 2: record this play and warm the cache for whatever usually
    // follows it. Queued behind the current song's own lookup by priority, so
    // it can never delay the words the user is waiting for right now.
    jobs::submit(
        SpeculateJob {
            app: app.clone(),
            current: crate::history::Play {
                key: key.clone(),
                title: title.clone(),
                artist: artist.clone(),
                duration_ms,
            },
        },
        Priority::Next,
    );

    jobs::submit(LyricsJob { app, title, artist, duration_ms, key }, Priority::Now);
}

/// The I/O-lane job behind `resolve_lyrics`.
struct LyricsJob {
    app: AppHandle,
    title: String,
    artist: String,
    duration_ms: i64,
    key: String,
}

impl Runnable for LyricsJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("lyrics:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let LyricsJob { app, title, artist, duration_ms, key } = *self;

        // Disk cache hit → replay immediately, offline.
        if let Some(path) = lyrics_cache_path(&app, &key) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                    // Short window, but a real one: the disk read is fast, not
                    // instant, and this branch is what queues MoodJob and
                    // AttributionJob. Bailing here stops them being registered
                    // under a track the user has already skipped past — once
                    // registered after `cancel_track` has run, nothing would
                    // ever cancel them.
                    if cancel.cancelled() {
                        return;
                    }
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
        //
        // The cancel checks between sources are the whole point of running
        // this on the engine: skipping tracks used to leave every doomed
        // lookup running to completion, and — worse — emitting its result over
        // the song that was actually playing by then. A cancelled job now
        // stops at the next source boundary and emits nothing.
        let mut found = None;
        if !cancel.cancelled() {
            found = crate::lyrics::fetch_synced(&track);
        }
        if found.is_none() && !cancel.cancelled() {
            found = crate::netease::fetch_synced(&track);
        }
        if found.is_none() && !cancel.cancelled() {
            found = crate::kugou::fetch_synced(&track);
        }
        if cancel.cancelled() {
            return;
        }
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
                if cancel.cancelled() {
                    return;
                }
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
    }
}

/* --------------------------------------------- phase 3: native inference --- */

/// Job ids for the sidecar. Only needs to be unique within a run — the sidecar
/// is spawned per job and never sees two.
static INFERENCE_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Transcribe a local audio file in the inference sidecar.
///
/// The local-file case needs no PCM over IPC: Rust already decodes these
/// files for `analyze_local_file`, so the samples never leave the backend.
/// The SMTC case reaches the same pipeline through
/// `stop_native_song_recording` below, which taps the WASAPI loopback thread
/// instead of decoding a file — see JOB-ENGINE section 7.10.
///
/// Returns immediately; the result arrives as `transcribe-progress` events and
/// a cached lyrics file, exactly as the WebView path's does.
#[tauri::command]
pub(crate) fn transcribe_local_file(app: AppHandle, track: Value, path: String) -> Value {
    if !crate::inference::available() {
        return json!({ "status": "unavailable", "message": "inference sidecar not installed" });
    }
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    let queued = jobs::submit(NativeTranscribeJob { app, track, path, key }, Priority::Now);
    json!({ "status": if queued { "queued" } else { "already-running" } })
}

/// The Inference-lane job behind `transcribe_local_file`.
struct NativeTranscribeJob {
    app: AppHandle,
    track: Value,
    path: String,
    key: String,
}

impl Runnable for NativeTranscribeJob {
    /// The lane that exists for exactly this: concurrency 1, below-normal
    /// threads. Two transcriptions at once thrash cache and memory for no
    /// throughput gain.
    fn lane(&self) -> Lane {
        Lane::Inference
    }

    fn dedup_key(&self) -> String {
        format!("transcribe:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let NativeTranscribeJob { app, track, path, key } = *self;

        let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "decoding" }));
        let Some((samples, rate)) = crate::analysis::decode_to_mono(&path) else {
            let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "error", "message": "cannot decode file" }));
            return;
        };
        if cancel.cancelled() {
            return;
        }
        run_native_transcription(app, track, key, samples, rate, None, cancel);
    }
}

/// Shared by every native transcription entry point once each has produced
/// its own `(samples, rate)` — a local file decodes them, a native song
/// recording (see `NativeSongRecordingJob`) reads them straight back from
/// disk with no decode step at all. From here on the pipeline cannot tell
/// which one it was fed: download models if needed, journal the attempt so a
/// crash does not lose it, run the sidecar, and finalize.
fn run_native_transcription(
    app: AppHandle,
    track: Value,
    key: String,
    samples: Vec<f32>,
    rate: u32,
    language: Option<String>,
    cancel: &CancelToken,
) {
    let job_id = INFERENCE_JOB_ID.fetch_add(1, Ordering::SeqCst);
    let pcm = crate::inference::resample_to_16k(&samples, rate);
    drop(samples); // the pre-resample original can be several times the resampled size

    // Find out what this actually is, while the audio is in hand (JOB-ENGINE
    // §5.1). Only fires on metadata that looks browser-shaped and only when a
    // key is configured, so on a normal library it costs nothing.
    let identified = identify_from_audio(&app, &track, &pcm);

    // First transcription on a fresh install: the models directory is empty,
    // and nothing else in the app ever populates it. This is a one-time
    // ~82 MB fetch, cached on disk after — the same shape whisper.js already
    // has for the WASM path, not new behaviour. Asked about (model_consent.rs)
    // before it starts, not after: `allow` blocks this Inference-lane thread
    // until the renderer answers a `model-consent-needed` prompt, or resolves
    // instantly if a decision (or nothing missing) is already on record.
    if let Some(models_dir) = crate::inference::model_dir(&app) {
        let missing = crate::models::missing_files(&models_dir);
        if !crate::model_consent::allow(&app, &missing) {
            let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "model-declined" }));
            return;
        }

        let progress_app = app.clone();
        let progress_track = track.clone();
        let ensured = crate::models::ensure_speech(
            &models_dir,
            |file, pct| {
                let _ = progress_app.emit(
                    "transcribe-progress",
                    json!({ "track": progress_track, "stage": "downloading-model", "file": file, "pct": pct }),
                );
            },
            &|| cancel.cancelled(),
        );
        if let Err(message) = ensured {
            if message != "cancelled" {
                log::warn!("model download failed: {message}");
                let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "error", "message": message }));
            }
            return;
        }
    }

    // Journal the attempt before the sidecar can write anything, so a crash
    // between here and the matching `finish` below leaves a row pointing at a
    // real, resumable PCM file — see journal.rs.
    let t = track_from_value(&track);
    let predicted_pcm_path = crate::inference::pcm_temp_path(job_id);
    let journal_id = app
        .try_state::<crate::journal::Journal>()
        .and_then(|j| j.start(&key, &t.artist, &t.title, t.duration_ms, &predicted_pcm_path.to_string_lossy(), language.as_deref()));

    let progress_track = track.clone();
    let progress_app = app.clone();
    let result = crate::inference::transcribe(&app, job_id, &pcm, language, cancel, move |stage, pct| {
        let _ = progress_app.emit(
            "transcribe-progress",
            json!({ "track": progress_track, "stage": format!("{stage:?}").to_lowercase(), "pct": pct }),
        );
    });

    if let Some(id) = journal_id {
        if let Some(j) = app.try_state::<crate::journal::Journal>() {
            j.finish(id);
        }
    }

    match result {
        Ok(cues) => {
            let cues = crate::inference::to_lyric_cues(cues);
            if cues.is_empty() {
                let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "empty" }));
                return;
            }
            // Straight into the existing finaliser: alignment to the real
            // plain lyrics, LLM correction, caching and the done event are
            // all identical whether the cues came from a local file, a
            // native recording, or the WebView — duplicating any of it would
            // be how those start disagreeing.
            let mut payload = json!({ "track": track, "cues": cues });
            if let Some(id) = identified {
                payload["identified"] = json!({ "artist": id.artist, "title": id.title, "mbid": id.mbid });
            }
            let _ = finalize_transcription(app, payload);
        }
        Err(message) => {
            log::warn!("native transcription failed: {message}");
            let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "error", "message": message }));
        }
    }
}

/// Identify what is really playing, from the audio rather than the metadata
/// (JOB-ENGINE §5.1).
///
/// Placed on the transcription path on purpose, and not as a job of its own:
/// this is the one moment the app already has a song's worth of decoded PCM in
/// memory, so identification is a fingerprint pass and one request rather than
/// a second recording. It is also the moment it is worth the most — a
/// transcription with a garbage title finds no real lyrics to align to, so
/// Whisper's mishearings get cached as *the* lyrics for that song.
///
/// Returns `None` far more often than not, and every one of those is normal:
/// no key configured, metadata that already looks fine, too little audio, or
/// nothing confident enough in the index. A failure here never fails the
/// transcription — the worst case is the behaviour that exists today.
fn identify_from_audio(app: &AppHandle, track: &Value, pcm: &[f32]) -> Option<crate::acoustid::Identified> {
    if !crate::acoustid::available() {
        return None;
    }
    let t = track_from_value(track);
    if !crate::acoustid::worth_identifying(&t) {
        return None;
    }

    let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "identifying" }));
    let fp = match crate::fingerprint::compute(pcm, crate::inference::SAMPLE_RATE) {
        Ok(fp) => fp,
        Err(e) => {
            log::info!("not fingerprinting: {e}");
            return None;
        }
    };
    // AcoustID scores on duration too, and it wants the WHOLE track's, not the
    // excerpt the fingerprint covers. Zero when SMTC did not report one, which
    // the lookup tolerates.
    let duration_secs = (t.duration_ms.max(0) / 1000) as u32;
    match crate::acoustid::identify(&fp, duration_secs) {
        Ok(Some(id)) => {
            log::info!("identified '{}' as '{} - {}' (score {:.2})", t.title, id.artist, id.title, id.score);
            let _ = app.emit(
                "transcribe-progress",
                json!({ "track": track, "stage": "identified", "artist": id.artist, "title": id.title }),
            );
            Some(id)
        }
        Ok(None) => {
            log::info!("acoustid had nothing confident for '{}'", t.title);
            None
        }
        Err(e) => {
            log::warn!("acoustid lookup failed: {e}");
            None
        }
    }
}

/* -------------------------------------------------- diarization --- */

/// Diarize a local audio file: who is singing, from the audio itself
/// (ROADMAP.md §5.8, `sidecar/src/diarize.rs`) rather than guessed from
/// lyric text (`attribute.rs`). Not yet called automatically by anything —
/// see `attribute::refine_with_diarization`'s doc comment for why an
/// already-synced song has no audio in hand at the point attribution runs
/// today. Callable by hand (or from a future UI action) against any local
/// file in the meantime; the result is cached the same way mood/attribution
/// are, so a second call on the same track is instant.
///
/// Returns immediately; the result arrives as a `diarized` event.
#[tauri::command]
pub(crate) fn diarize_local_file(app: AppHandle, track: Value, path: String) -> Value {
    if !crate::inference::available() {
        return json!({ "status": "unavailable", "message": "inference sidecar not installed" });
    }
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    let queued = jobs::submit(DiarizeJob { app, track, path, key }, Priority::Now);
    json!({ "status": if queued { "queued" } else { "already-running" } })
}

/// The Inference-lane job behind `diarize_local_file`. Same lane as
/// transcription (concurrency 1) — both load an ONNX graph into a spawned
/// sidecar process, and running two at once would double an already
/// significant memory footprint for no throughput gain.
struct DiarizeJob {
    app: AppHandle,
    track: Value,
    path: String,
    key: String,
}

impl Runnable for DiarizeJob {
    fn lane(&self) -> Lane {
        Lane::Inference
    }

    fn dedup_key(&self) -> String {
        format!("diarize:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let DiarizeJob { app, track, path, key } = *self;
        let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "decoding" }));
        let Some((samples, rate)) = crate::analysis::decode_to_mono(&path) else {
            let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "error", "message": "cannot decode file" }));
            return;
        };
        if cancel.cancelled() {
            return;
        }
        let pcm = crate::inference::resample_to_16k(&samples, rate);
        drop(samples);

        let Some(models_dir) = crate::inference::diarization_model_dir(&app) else {
            let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "error", "message": "no model directory" }));
            return;
        };
        let missing = crate::models::missing_diarization_files(&models_dir);
        if !crate::model_consent::allow(&app, &missing) {
            let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "model-declined" }));
            return;
        }
        let progress_app = app.clone();
        let progress_track = track.clone();
        let ensured = crate::models::ensure_diarization(
            &models_dir,
            |file, pct| {
                let _ = progress_app.emit(
                    "diarize-progress",
                    json!({ "track": progress_track, "stage": "downloading-model", "file": file, "pct": pct }),
                );
            },
            &|| cancel.cancelled(),
        );
        if let Err(message) = ensured {
            if message != "cancelled" {
                log::warn!("diarization model download failed: {message}");
                let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "error", "message": message }));
            }
            return;
        }
        if cancel.cancelled() {
            return;
        }

        let job_id = INFERENCE_JOB_ID.fetch_add(1, Ordering::SeqCst);
        let progress_app = app.clone();
        let progress_track = track.clone();
        let result = crate::inference::diarize(&app, job_id, &pcm, cancel, move |pct| {
            let _ = progress_app.emit("diarize-progress", json!({ "track": progress_track, "stage": "diarizing", "pct": pct }));
        });

        match result {
            Ok(spans) => {
                let spans_val: Vec<Value> =
                    spans.iter().map(|s| json!({ "startMs": s.start_ms, "endMs": s.end_ms, "speaker": s.speaker })).collect();
                if let Some(path) = lyrics_cache_path(&app, &key) {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if let Ok(mut cached) = serde_json::from_str::<Value>(&text) {
                            cached["diarization"] = json!(spans_val);
                            let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
                        }
                    }
                }
                let _ = app.emit("diarized", json!({ "track": track, "spans": spans_val }));
            }
            Err(message) => {
                if message != "cancelled" {
                    let _ = app.emit("diarize-progress", json!({ "track": track, "stage": "error", "message": message }));
                }
            }
        }
    }
}

/* --------------------------------------- native SMTC song recording --- */

/// Stop the native song recording (`start_native_song_recording`) and
/// transcribe what was captured.
///
/// This is the SMTC-playback counterpart to `transcribe_local_file` — same
/// pipeline from here on, different source for the samples. It replaces
/// `src/renderer/capture.js` + `transcribeAudio`'s WebView Whisper pass: that
/// path recorded PCM in a `ScriptProcessorNode` and pushed the whole
/// multi-megabyte `Float32Array` across Tauri's IPC to get it into Rust at
/// all. This has nothing to push — the backend captured the audio itself, so
/// only a file path crosses the boundary (JOB-ENGINE §7.7's opening line).
///
/// `track` is the song that was JUST playing (the renderer's `listeningTrack`,
/// captured before the track actually changed — this command fires on the
/// change itself, the same "flush on the way out" shape `flushTranscription`
/// already had).
#[tauri::command]
pub(crate) fn stop_native_song_recording(app: AppHandle, track: Value, language: Option<String>) -> Value {
    let Some((path, rate)) = crate::audio::stop_recording() else {
        return json!({ "status": "too-short" });
    };
    if !crate::inference::available() {
        let _ = std::fs::remove_file(&path);
        return json!({ "status": "unavailable", "message": "inference sidecar not installed" });
    }
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    let queued = jobs::submit(NativeSongRecordingJob { app, track, path, rate, language, key }, Priority::Now);
    json!({ "status": if queued { "queued" } else { "already-running" } })
}

/// The Inference-lane job behind `stop_native_song_recording`.
struct NativeSongRecordingJob {
    app: AppHandle,
    track: Value,
    path: std::path::PathBuf,
    rate: u32,
    language: Option<String>,
    key: String,
}

impl Runnable for NativeSongRecordingJob {
    fn lane(&self) -> Lane {
        Lane::Inference
    }

    fn dedup_key(&self) -> String {
        // Same prefix `NativeTranscribeJob` uses for the same track: a local
        // file and a native recording of the same song are the same job as
        // far as dedup is concerned, and only one should ever run.
        format!("transcribe:{}", self.key)
    }

    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let NativeSongRecordingJob { app, track, path, rate, language, key } = *self;
        let _ = app.emit("transcribe-progress", json!({ "track": track, "stage": "decoding" }));

        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                let _ =
                    app.emit("transcribe-progress", json!({ "track": track, "stage": "error", "message": format!("cannot read recording: {e}") }));
                return;
            }
        };
        // The raw native-rate file was only ever meant to survive this one
        // read — the resample below produces the copy that actually
        // proceeds, and nothing else references this path.
        let _ = std::fs::remove_file(&path);

        let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        if cancel.cancelled() {
            return;
        }
        run_native_transcription(app, track, key, samples, rate, language, cancel);
    }
}

/* ------------------------------------------------ journal: resume path --- */

/// Submit one `Idle`-priority job per row the journal swept at startup.
///
/// Called once, from `lib.rs`'s `setup`, with exactly the rows
/// `journal::Journal::take_stale` returned — each already removed from the
/// table, so a resume that itself fails will not be retried at the next
/// startup too. `Idle` because nothing here is what the user is waiting on;
/// there may not even be anything playing yet.
pub(crate) fn resume_stale_transcriptions(app: AppHandle, stale: Vec<crate::journal::StaleJob>) {
    for job in stale {
        if !std::path::Path::new(&job.pcm_path).is_file() {
            // The crash happened before write_pcm finished, or something else
            // already cleaned the temp file up. Nothing to resume.
            log::info!("skipping stale transcription for {} — its PCM file is gone", job.track_key);
            continue;
        }
        jobs::submit(ResumeTranscribeJob { app: app.clone(), job }, Priority::Idle);
    }
}

/// The Inference-lane job behind `resume_stale_transcriptions`.
struct ResumeTranscribeJob {
    app: AppHandle,
    job: crate::journal::StaleJob,
}

impl Runnable for ResumeTranscribeJob {
    fn lane(&self) -> Lane {
        Lane::Inference
    }

    fn dedup_key(&self) -> String {
        format!("transcribe:{}", self.job.track_key)
    }

    fn track(&self) -> Option<String> {
        // Deliberately NOT `Some(self.job.track_key.clone())`. A track()
        // dedup key is also what `cancel_track` uses to stop everything
        // queued for the song a user just skipped past — but this job is for
        // a song that (almost certainly) is not what's playing now, and
        // tying it to that track identity would let an ordinary skip cancel a
        // resume that has nothing to do with the skip. `dedup_key` above
        // still stops it racing a FRESH transcription of the same track,
        // which is the dedup guarantee that actually matters here.
        None
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let ResumeTranscribeJob { app, job } = *self;
        let job_id = INFERENCE_JOB_ID.fetch_add(1, Ordering::SeqCst);

        if let Some(models_dir) = crate::inference::model_dir(&app) {
            let missing = crate::models::missing_files(&models_dir);
            if !crate::model_consent::allow(&app, &missing) {
                let _ = std::fs::remove_file(&job.pcm_path);
                return;
            }
            let ensured = crate::models::ensure_speech(&models_dir, |_, _| {}, &|| cancel.cancelled());
            if let Err(message) = ensured {
                if message != "cancelled" {
                    log::warn!("resumed transcription for {} could not fetch models: {message}", job.track_key);
                }
                let _ = std::fs::remove_file(&job.pcm_path);
                return;
            }
        }

        let pcm_path = std::path::PathBuf::from(&job.pcm_path);
        let result = crate::inference::transcribe_existing_pcm(&app, job_id, pcm_path, job.language.clone(), cancel, |_, _| {});

        match result {
            Ok(cues) => {
                let cues = crate::inference::to_lyric_cues(cues);
                if cues.is_empty() {
                    log::info!("resumed transcription for {} produced no cues", job.track_key);
                    return;
                }
                let track = json!({ "title": job.title, "artist": job.artist, "durationMs": job.duration_ms });
                let payload = json!({ "track": track, "cues": cues });
                // Quiet: see finalize_transcription_inner's doc for why a
                // resumed job must not emit transcribe-progress.
                let _ = finalize_transcription_inner(&app, payload, true);
                log::info!("resumed transcription for {} finished and was cached silently", job.track_key);
            }
            Err(message) => {
                if message != "cancelled" {
                    log::warn!("resumed transcription for {} failed: {message}", job.track_key);
                }
            }
        }
    }
}

/* ------------------------------------------------- phase 2: precompute --- */

/// Fetch and cache a track's synced lyrics without emitting anything.
///
/// The emit is what makes this different from `LyricsJob`, and the difference
/// is the whole safety argument for speculating at all: a precomputed song is
/// not the song playing, so pushing a `lyrics` event for it would replace the
/// words on screen with a different song's. Writing only to the cache means a
/// wrong guess costs one wasted request and can never be seen.
///
/// Returns whether anything was newly cached. `pub(crate)` so `library.rs`'s
/// watched-folder backfill can warm the same cache for files that are not
/// queued or playing — see `LibraryLyricsJob`.
pub(crate) fn warm_lyrics_cache(app: &AppHandle, title: &str, artist: &str, key: &str, cancel: &CancelToken) -> bool {
    // Already on disk — the common case once a library has been played
    // through, and the reason this is cheap to run on every track change.
    if let Some(path) = lyrics_cache_path(app, key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                if cached.get("cues").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
                    return false;
                }
            }
        }
    }
    if cancel.cancelled() {
        return false;
    }

    let track = crate::lyrics::Track { title: title.to_string(), artist: artist.to_string(), duration_ms: 0 };
    let mut found = crate::lyrics::fetch_synced(&track);
    if found.is_none() && !cancel.cancelled() {
        found = crate::netease::fetch_synced(&track);
    }
    if found.is_none() && !cancel.cancelled() {
        found = crate::kugou::fetch_synced(&track);
    }

    match found {
        Some((cues, source)) if !cues.is_empty() => {
            // Written in exactly the shape `LyricsJob`'s disk-cache branch
            // expects, so a precomputed song takes the instant path when it
            // does start — that path is the entire point of this.
            let payload = json!({
                "title": title, "artist": artist, "cues": cues,
                "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
                "source": source, "status": "ok", "indic": false, "hasWordTimings": false,
            });
            if let Some(path) = lyrics_cache_path(app, key) {
                let _ = std::fs::write(&path, serde_json::to_string(&payload).unwrap_or_default());
            }
            true
        }
        _ => false,
    }
}

/// Warm the cache for one specific track the caller already knows is coming.
///
/// Used by the local-file queue lookahead, where there is no guessing involved
/// — `LocalPlayer` owns the queue, so the next entries are simply known.
struct PrecomputeJob {
    app: AppHandle,
    title: String,
    artist: String,
    key: String,
}

impl Runnable for PrecomputeJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("precompute:{}", self.key)
    }

    /// Belongs to the track it is fetching *for*, not the one playing. That
    /// matters: `set_current_track` cancels the track being left behind, so
    /// filing speculation under the song it is about means arriving at that
    /// song never cancels the work done to prepare for it.
    fn track(&self) -> Option<String> {
        Some(self.key.clone())
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let PrecomputeJob { app, title, artist, key } = *self;
        warm_lyrics_cache(&app, &title, &artist, &key, cancel);
    }
}

/// Record the current play, then warm the cache for whatever usually follows
/// it — the SMTC half of Phase 2, where no queue is visible to read.
struct SpeculateJob {
    app: AppHandle,
    current: crate::history::Play,
}

impl Runnable for SpeculateJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("speculate:{}", self.current.key)
    }

    /// Deliberately untracked. It does two things that both want to survive a
    /// track change: recording the play, which is the data the predictor is
    /// built from and must not be dropped when a song is skipped early; and
    /// warming a cache, which produces no visible output, so a stale run
    /// wastes one request and nothing else.
    fn track(&self) -> Option<String> {
        None
    }

    fn run(self: Box<Self>, _cancel: &CancelToken) {
        let SpeculateJob { app, current } = *self;
        let key = current.key.clone();
        crate::history::record_play(&app, current);

        let Some(next) = crate::history::predict_next(&app, &key) else { return };
        // Hands off to `PrecomputeJob` rather than warming the cache inline,
        // so both routes to speculation share one dedup key. During local
        // playback both are live at once — the queue lookahead and this — and
        // they often agree on the same song; going through the engine means
        // the second one is dropped instead of duplicating the fetch.
        jobs::submit(
            PrecomputeJob { app, title: next.title, artist: next.artist, key: next.key },
            Priority::Next,
        );
    }
}

/// Warm the lyrics cache for tracks the renderer knows are coming — the local
/// player's queue lookahead. Fire-and-forget; nothing is emitted and the
/// renderer is not told when it finishes, because there is nothing to show.
///
/// Submitted at `Next`, so the playing song's own lookup always wins the lane.
#[tauri::command]
pub(crate) fn precompute_tracks(app: AppHandle, tracks: Vec<Value>) -> Value {
    let mut queued = 0;
    for t in tracks.iter().take(PRECOMPUTE_LOOKAHEAD) {
        let track = track_from_value(t);
        if track.title.is_empty() {
            continue;
        }
        let key = track_key(&track.artist, &track.title);
        if jobs::submit(
            PrecomputeJob { app: app.clone(), title: track.title, artist: track.artist, key },
            Priority::Next,
        ) {
            queued += 1;
        }
    }
    json!({ "status": "ok", "queued": queued })
}

/// How far down the queue to look. Two is enough to cover the gap between one
/// song ending and the next starting even on a slow lookup, without spending
/// requests on a queue position the user is likely to skip past or re-order
/// before reaching.
const PRECOMPUTE_LOOKAHEAD: usize = 2;

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
/// `(async)` IS LOAD-BEARING, NOT DECORATION. Tauri runs a command without the
/// `async` keyword **on the main thread** unless it is declared
/// `#[tauri::command(async)]`, and `blocking_pick_file` is documented as
/// "should NOT be used when running on the main thread" because it waits on
/// the event loop that the main thread is the one pumping. Sync + blocking
/// picker = the main thread waiting on itself: the whole app freezes with no
/// dialog ever shown. `(async)` moves this body to a worker thread, where the
/// blocking picker is exactly the "other contexts" its docs sanction.
#[tauri::command(async)]
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

/// Forget an imported `.lrc` (or a hand-picked search result — same cache
/// file, `clear_manual_lyrics` doesn't need to know which put it there) and
/// go back to the automatic sources.
#[tauri::command]
pub(crate) fn clear_manual_lyrics(track: Value, app: AppHandle) {
    let t = track_from_value(&track);
    let key = track_key(&t.artist, &t.title);
    if let Some(path) = lyrics_cache_path(&app, &key) {
        let _ = std::fs::remove_file(path);
    }
    resolve_lyrics(app.clone(), t.title, t.artist, t.duration_ms);
}

/// Free-text search against LRCLIB, for the manual lyrics-search panel — a
/// second escape hatch alongside `import_lyrics`'s "pick a .lrc file" for
/// exactly the same two situations: automatic lookup found nothing, or it
/// found the wrong song (a cover, a remix, a same-titled different track).
///
/// Unscored and unfiltered, unlike `resolve_lyrics`'s automatic path — this
/// is a person reading trackName/artistName/album and deciding for
/// themselves, so nothing here should quietly reject a candidate the way the
/// automatic scorer does. `hasSynced`/`hasPlain` let the panel show which
/// results actually have timing before anything is picked, without shipping
/// every candidate's full lyric text just to answer that.
#[tauri::command]
pub(crate) fn search_lyrics(query: String) -> Value {
    let Some(results) = crate::lyrics::search(&query) else {
        return json!({ "status": "error", "message": "search failed — check your connection" });
    };
    let candidates: Vec<Value> = results
        .iter()
        .map(|c| {
            json!({
                "id": c.get("id"),
                "title": c.get("trackName"),
                "artist": c.get("artistName"),
                "album": c.get("albumName"),
                "durationMs": c.get("duration").and_then(|d| d.as_f64()).map(|d| (d * 1000.0).round()),
                "instrumental": c.get("instrumental").and_then(|v| v.as_bool()).unwrap_or(false),
                "hasSynced": c.get("syncedLyrics").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false),
                "hasPlain": c.get("plainLyrics").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false),
            })
        })
        .collect();
    json!({ "status": "ok", "candidates": candidates })
}

/// Apply one hand-picked search result to whichever track the renderer says
/// is current — NOT necessarily the title/artist LRCLIB reported for the
/// candidate. That is deliberate: the whole reason this exists is to let a
/// person correct a WRONG automatic match, so the fix has to land under the
/// track that is actually playing, the same way `import_lyrics` does.
///
/// Synced-only for now: this app's whole rendering path is built on
/// timestamped `Cue`s, and a plain-only pick would have nothing to line up
/// against the running clock. The panel still shows plain-only results (see
/// `search_lyrics`'s `hasPlain`) so a person can at least confirm LRCLIB has
/// the song, even though picking one here does nothing yet.
#[tauri::command]
pub(crate) fn choose_lyrics_candidate(track: Value, id: i64, app: AppHandle) -> Value {
    let t = track_from_value(&track);
    if t.title.is_empty() {
        return json!({ "status": "error", "message": "no track playing" });
    }
    let Some(entry) = crate::lyrics::get_by_id(id) else {
        return json!({ "status": "error", "message": "could not reach LRCLIB" });
    };
    let Some(synced) = entry.get("syncedLyrics").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return json!({ "status": "error", "message": "that result has no time-stamps" });
    };
    let cues = crate::lyrics::parse_lrc(synced);
    if cues.is_empty() {
        return json!({ "status": "error", "message": "that result's timestamps didn't parse" });
    }

    let key = track_key(&t.artist, &t.title);
    let lines = cues.len();
    let payload = json!({
        "title": t.title, "artist": t.artist,
        "cues": cues,
        "cuesDevanagari": Value::Null, "cuesEnglish": Value::Null,
        "source": {
            "name": "search",
            "id": id,
            "trackName": entry.get("trackName"),
            "artistName": entry.get("artistName"),
        },
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
        Ok((language, en_cues)) => {
            let en_val = serde_json::to_value(&en_cues).unwrap_or(Value::Null);
            cached["cuesEnglish"] = en_val.clone();
            cached["language"] = json!(language);
            let _ = std::fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
            json!({ "status": "ok", "cues": en_val, "language": language })
        }
        Err(message) => json!({ "status": "error", "message": message }),
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
///
/// `hasBeatmap`/`hasHeatmap` were never actually read here — `renderLibrary`
/// in renderer.js has always asked for `it.hasBeatmap`/`it.hasHeatmap`, and
/// since neither field was ever present in this output, `Boolean(undefined)`
/// silently made every card's beats/shape badge read as "no" even for a
/// track `save_beatmap`/`save_heatmap` really did persist a learned map for.
/// Same cache file, both fields — `merge_track_cache` (see `save_beatmap`)
/// writes `beatmap`/`heatmap` onto the exact record this reads.
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
            "hasCues": has_cues,
            "hasBeatmap": v.get("beatmap").is_some(),
            "hasHeatmap": v.get("heatmap").and_then(|h| h.get("bins")).map(|b| b.is_array()).unwrap_or(false),
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

/// The renderer's answer to `model-consent-needed` (model_consent.rs). Wakes
/// whichever Inference-lane job is blocked waiting for it, and — if
/// `remember` is set — persists the decision so the prompt never fires again.
#[tauri::command]
pub(crate) fn answer_model_consent(consent: bool, remember: bool, app: AppHandle) {
    crate::model_consent::answer(&app, consent, remember);
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
    finalize_transcription_inner(&app, payload, false)
}

/// The shared implementation behind `finalize_transcription`.
///
/// `quiet` suppresses every `transcribe-progress` emit while keeping every
/// cache write. This exists for exactly one caller: `resume_stale_jobs`,
/// finishing a transcription left over from a crash at the NEXT startup, for
/// a track that is almost certainly not the one now playing. `setStatus` in
/// the renderer is not track-scoped — it is a global one-line status
/// indicator — so an unsuppressed "matched real lyrics" or "fixed 3 misheard
/// lines" from a resumed background job would read as being about whatever
/// IS playing. Same asymmetry as Phase 2's precompute (§7.2): a cache write
/// nobody sees is safe, a status message about the wrong song is a visible
/// glitch.
fn finalize_transcription_inner(app: &AppHandle, payload: Value, quiet: bool) -> Value {
    macro_rules! emit {
        ($name:expr, $payload:expr) => {
            if !quiet {
                let _ = app.emit($name, $payload);
            }
        };
    }

    let track = payload.get("track").cloned().unwrap_or(Value::Null);
    let mut t = track_from_value(&track);
    let raw_cues: Vec<crate::lyrics::Cue> = payload.get("cues").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    if raw_cues.is_empty() {
        emit!("transcribe-progress", json!({ "track": track, "stage": "empty" }));
        return json!({ "status": "empty" });
    }
    let key = track_key(&t.artist, &t.title);

    // `identified` is what the AUDIO says this is (acoustid.rs), present only
    // when the player's own metadata looked browser-shaped and a lookup came
    // back confident. Applied strictly AFTER `key` is derived, which is the
    // whole subtlety: the cache key has to stay the one the *player's*
    // metadata produces, because that is what the next play of this song will
    // look up — the browser will report the same video title again. Everything
    // below wants the true names instead: the plain-lyric fetch, the LLM's
    // context for correction, and the title/artist written into the cached
    // payload and shown on screen.
    if let Some(id) = payload.get("identified") {
        let artist = id.get("artist").and_then(|a| a.as_str()).unwrap_or("").trim();
        let title = id.get("title").and_then(|t| t.as_str()).unwrap_or("").trim();
        if !artist.is_empty() && !title.is_empty() {
            t.artist = artist.to_string();
            t.title = title.to_string();
        }
    }

    if let Some(path) = lyrics_cache_path(app, &key) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<Value>(&text) {
                let has_cues = existing.get("cues").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
                let already_synced = has_cues && !source_is_whisper_derived(existing.get("source").unwrap_or(&Value::Null));
                if already_synced {
                    let existing_has_words = existing.get("hasWordTimings").and_then(|v| v.as_bool()).unwrap_or(false);
                    if existing_has_words {
                        emit!(
                            "transcribe-progress",
                            json!({ "track": track, "stage": "done", "lines": 0, "skipped": "already-synced" })
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
                        emit!(
                            "transcribe-progress",
                            json!({ "track": track, "stage": "words-added", "lines": upgraded_lines, "total": merged.len() })
                        );
                        return json!({ "status": "ok", "lines": upgraded_lines });
                    }
                    // Nothing anchored cleanly this pass — leave the cache
                    // untouched (still correct, just still line-level) so the
                    // renderer's hasWordTimings stays false and tries again on
                    // a future play, same retry semantics as the whisper-only
                    // path below.
                    emit!("transcribe-progress", json!({ "track": track, "stage": "align-weak" }));
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
            emit!("transcribe-progress", json!({ "track": track, "stage": "aligned", "coverage": (coverage * 100.0).round() }));
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
            emit!("transcribe-progress", json!({ "track": track, "stage": "correcting", "batch": batch, "batches": batches }));
        });
        if changed > 0 {
            final_cues = corrected;
            source = "whisper+llm";
            emit!("transcribe-progress", json!({ "track": track, "stage": "corrected", "changed": changed }));
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
    if let Some(path) = lyrics_cache_path(app, &key) {
        let _ = std::fs::write(&path, serde_json::to_string(&payload_out).unwrap_or_default());
    }
    emit!("transcribe-progress", json!({ "track": track, "stage": "done", "lines": lines }));
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
///
/// Queues the run and returns immediately. It used to do the whole list
/// inline, and — being a sync command, so running on the main thread — froze
/// the event loop for as long as that took: one network round trip plus 150ms
/// per track, which is minutes for a pasted album, let alone a playlist. The
/// renderer never used the return value for anything but an error toast; it
/// tracks progress through `presync-progress`, which is unchanged.
#[tauri::command]
pub(crate) fn presync_list(text: String, app: AppHandle) -> Value {
    let tracks: Vec<(String, String)> = text.lines().filter_map(parse_track_line).collect();
    let token = PRESYNC_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let total = tracks.len();

    if total == 0 {
        let _ = app.emit("presync-progress", json!({ "done": 0, "total": 0, "status": "done", "summary": "nothing to sync" }));
        return json!({ "status": "empty" });
    }

    jobs::submit(PresyncJob { app, tracks, token }, Priority::Idle);
    json!({ "status": "queued", "total": total })
}

/// The I/O-lane job behind `presync_list`.
///
/// ONE JOB FOR THE WHOLE LIST, not one per track. Fanning out would hand the
/// list to all six I/O workers at once and hammer LRCLIB with a couple of
/// hundred requests as fast as the socket allows; the serial loop with its
/// 150ms gap is the politeness this depends on to keep working at all. The
/// cost is that a long run occupies one of the six I/O slots for its whole
/// duration, which is why it is submitted at `Idle` — the playing song's
/// lyric, artwork, mood and attribution jobs are all `Now` and all overtake
/// it, and five slots remain free for them regardless.
///
/// `track()` is left as `None`: a pre-sync run is about songs that are *not*
/// playing, so a track change must not cancel it.
struct PresyncJob {
    app: AppHandle,
    tracks: Vec<(String, String)>,
    token: u64,
}

impl Runnable for PresyncJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    /// Keyed by token, so a fresh paste is never rejected as a duplicate of
    /// the run it is meant to supersede — the older run then sees the bumped
    /// `PRESYNC_TOKEN` at its next iteration and stops itself.
    fn dedup_key(&self) -> String {
        format!("presync:{}", self.token)
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let PresyncJob { app, tracks, token } = *self;
        let total = tracks.len();
        let (mut done, mut synced, mut cached, mut missed) = (0usize, 0usize, 0usize, 0usize);

        for (artist, title) in &tracks {
            if cancel.cancelled() || PRESYNC_TOKEN.load(Ordering::SeqCst) != token {
                return;
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
    }
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
