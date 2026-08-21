//! Local library indexing (JOB-ENGINE §5.7/Phase 7).
//!
//! Before this, `analyze_local_file` — the decode + `beats`/`key`/`structure`/
//! `loudness` pass `commands::playback` runs for local playback — ran fresh on
//! *every* play of *every* local file, with nothing cached: a four-minute song
//! paid the same ~0.15s DSP cost (on top of the decode) the tenth time it
//! played as the first. This module gives that pass a cache
//! (`journal::Journal::{get,put}_local_analysis`, keyed on path + mtime/size so
//! a file that changed on disk is never served a stale answer), and a way to
//! pay the cost ahead of time: `index_folder` submits one `Idle`-lane job per
//! audio file, so a folder opened once has every file's analysis already on
//! disk by the time any of them actually plays.
//!
//! Deliberately NOT a filesystem watcher. `index_folder` runs off the same
//! enumeration `open_local_folder` already does when the user picks a folder —
//! there is no persisted list of "watched" folders, and no `notify`-crate
//! watch thread picking up files dropped in later. That is a real, larger
//! feature (persisted folder list, a settings surface to manage it, live
//! filesystem events) and a deliberate scope cut, not an oversight: the
//! payoff this phase's own description is after — "every local file starts
//! with full analysis... already on disk" — is fully delivered for any folder
//! the user has opened at least once, which is the same folder(s) local
//! playback already only ever sees.

use serde_json::{json, Value};

use crate::jobs::{CancelToken, Lane, Runnable};
use crate::journal::Journal;
use tauri::{AppHandle, Manager};

/// `(mtime as unix seconds, size in bytes)`, the freshness key the cache is
/// keyed on. `None` if the file cannot be stat'd (gone, no permission) —
/// callers treat that as "nothing to cache against" rather than guessing.
fn file_stat(path: &str) -> Option<(i64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((mtime, meta.len()))
}

/// The actual decode + DSP pass: `analysis.rs` for the energy envelope,
/// `beats`/`key`/`structure`/`loudness` for the rest. Pure — no cache read or
/// write here, so both the cache-checking caller below and a future caller
/// that wants to force a re-analysis can use it directly. `None` only when
/// the file cannot be decoded at all.
fn analyze(path: &str) -> Option<Value> {
    let (samples, sample_rate) = crate::analysis::decode_to_mono(path)?;
    let a = crate::analysis::analyse_samples(&samples, sample_rate);
    let mut out = serde_json::to_value(&a).unwrap_or(json!({}));
    out["ok"] = json!(true);
    out["durationMs"] = json!((samples.len() as f64 / sample_rate as f64) * 1000.0);
    if let Some(beats) = crate::beats::track(&samples, sample_rate) {
        log::info!("beat grid ({path}): {:.1} BPM, {} beats, confidence {:.2}", beats.bpm, beats.beats_ms.len(), beats.confidence);
        out["beats"] = serde_json::to_value(&beats).unwrap_or(Value::Null);
    }
    if let Some(key) = crate::key::detect(&samples, sample_rate) {
        log::info!("key ({path}): {} (margin {:.2})", key.label, key.confidence);
        out["key"] = serde_json::to_value(&key).unwrap_or(Value::Null);
    }
    if let Some(starts) = crate::structure::detect(&samples, sample_rate) {
        log::info!("structure ({path}): {} section(s)", starts.len());
        out["sectionStartsMs"] = json!(starts);
    }
    if let Some(l) = crate::loudness::measure(&samples, sample_rate) {
        log::info!("loudness ({path}): {:.1} LUFS, gain {:.2}", l.lufs, l.gain);
        out["loudness"] = serde_json::to_value(&l).unwrap_or(Value::Null);
    }
    Some(out)
}

/// The cache-first path `commands::playback::analyze_local_file` and
/// `LocalIndexJob` both call: a fresh cache hit skips the decode entirely; a
/// miss (or a stale entry) runs `analyze` and, on success, writes the result
/// back so the next call — interactive or background — is instant.
pub(crate) fn analyze_cached(app: &AppHandle, path: &str) -> Value {
    let Some((mtime, size)) = file_stat(path) else {
        return json!({ "ok": false });
    };
    let journal = app.try_state::<Journal>();
    if let Some(j) = &journal {
        if let Some(cached) = j.get_local_analysis(path, mtime, size) {
            return cached;
        }
    }
    let result = analyze(path).unwrap_or(json!({ "ok": false }));
    if result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(j) = &journal {
            j.put_local_analysis(path, mtime, size, &result);
        }
    }
    result
}

/// One file's `Idle`-lane pre-analysis. Untracked (`track()` returns `None`,
/// the same choice the pre-sync bulk import made in Phase 2) — this is work
/// for files that are not playing, often not even queued, so a track change
/// must never cancel it the way it cancels the playing song's own lookups.
struct LocalIndexJob {
    app: AppHandle,
    path: String,
}

impl Runnable for LocalIndexJob {
    fn lane(&self) -> Lane {
        Lane::Cpu
    }
    fn dedup_key(&self) -> String {
        format!("local-index:{}", self.path)
    }
    fn run(self: Box<Self>, cancel: &CancelToken) {
        if cancel.cancelled() {
            return;
        }
        // Cache check happens inside analyze_cached, so a file indexed by a
        // previous session (or by actually being played since) costs one
        // stat call here, not a re-decode.
        let result = analyze_cached(&self.app, &self.path);
        if !result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            log::warn!("local library index: could not analyse {}", self.path);
        }
    }
}

/// Queue every audio file in `paths` for background pre-analysis at `Idle`
/// priority — behind whatever the playing track's own `Now`/`Next` work is,
/// so opening a large folder never competes with the song already playing.
/// Cheap to call on a folder already fully indexed: each job's first act is
/// the cache check above, so a re-open costs one stat per file, not a
/// re-decode.
pub(crate) fn index_folder(app: &AppHandle, paths: &[std::path::PathBuf]) {
    for path in paths {
        let path = path.to_string_lossy().to_string();
        crate::jobs::submit(LocalIndexJob { app: app.clone(), path }, crate::jobs::Priority::Idle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_stat_is_none_for_a_path_that_does_not_exist() {
        assert!(file_stat("/no/such/file/anywhere.mp3").is_none());
    }

    #[test]
    fn file_stat_reports_the_real_size() {
        let dir = std::env::temp_dir().join(format!("lib-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("probe.bin");
        std::fs::write(&file, b"twelve bytes").unwrap();
        let (_, size) = file_stat(file.to_str().unwrap()).expect("stat should succeed on a real file");
        assert_eq!(size, 12);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn analyze_on_a_non_audio_file_fails_closed() {
        let dir = std::env::temp_dir().join(format!("lib-test-na-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-audio.mp3");
        std::fs::write(&file, b"this is not an mp3").unwrap();
        assert!(analyze(file.to_str().unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
