//! Phase 7 (JOB-ENGINE.md §5.7/§7): a persisted list of watched library
//! folders, a background scan that keeps an on-disk index of what's in them
//! current, and two Idle-lane backfills over whatever the scan finds:
//! per-file audio DSP (beat/key/structure/loudness, the same pass
//! `analyze_local_file` runs on demand) and a synced-lyrics lookup (the same
//! `warm_lyrics_cache` the local-queue lookahead uses) — so a watched file's
//! shape AND its lyrics are both known before it's ever pressed play on, the
//! same way a `Next`/`Idle`-precomputed streamed track is (§7.2).
//!
//! The two are deliberately separate jobs on separate lanes: DSP is CPU-bound
//! (`Lane::Cpu`), a lyrics lookup is a network round trip (`Lane::Io`) — one
//! job doing both would sit on a CPU-lane thread for the network wait, which
//! is exactly what the lane split exists to avoid.
//!
//! What this does NOT do: diarization (§5.8) is a separate, still-exploratory
//! piece of work gated on this and phase 6, not part of it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::lyrics_cmds::{track_key, warm_lyrics_cache};
use crate::commands::playback::{analyze_local_file_value, AUDIO_EXTS};
use crate::jobs::{self, CancelToken, Lane, Priority, Runnable};

/// How often the background thread re-scans the watched folders. Library
/// contents change on human timescales (copying in an album, deleting a
/// folder) — same reasoning as `start_power_watcher`'s 2s poll, just wider
/// since a full folder walk is real disk I/O and there is no interaction to
/// react to quickly here the way there is for wallpaper power state.
const SCAN_INTERVAL_SECS: u64 = 60;

/// One file's last-seen shape, enough to tell "unchanged" from "re-encoded /
/// replaced" without hashing the whole library on every scan, plus whether
/// each Idle-lane backfill has covered it at that shape yet.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct LibraryEntry {
    pub(crate) size: u64,
    pub(crate) modified_ms: i64,
    /// Whether `library-analysis/<hash>.json` holds a result for this file AT
    /// THIS `size`/`modified_ms`. `diff_index` resets this to `false` whenever
    /// either changes, since a stale analysis is worse than an absent one —
    /// same reasoning as `beats.rs`'s "no grid" over a wrong one.
    #[serde(default)]
    pub(crate) analyzed: bool,
    /// Whether a synced-lyrics lookup has been attempted for this file at
    /// this shape — regardless of whether it found anything. A miss is not
    /// retried on every scan tick; the file changing (a different edit, or a
    /// genuinely different song under the same name) is what earns it
    /// another attempt.
    #[serde(default)]
    pub(crate) lyrics_synced: bool,
}

/// path (as given by `std::fs`, not canonicalised — see `scan_folder`) → entry.
type Index = BTreeMap<String, LibraryEntry>;

fn index_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("library-index.json"))
}

/// Where one file's durable analysis summary lives — `library-analysis/`
/// rather than folded into the index itself, so the index (re-read/re-
/// written on every scan tick) stays small even once thousands of tracks
/// have real DSP results attached. Hashed the same way `lyrics_cmds::
/// track_key` names a lyrics cache file, just over the path instead of
/// artist|title — a real path can contain characters no filesystem accepts.
fn analysis_cache_path(app: &AppHandle, path: &str) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("library-analysis");
    let _ = std::fs::create_dir_all(&dir);
    let mut hash: u64 = 5381;
    for b in path.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    Some(dir.join(format!("{hash:016x}.json")))
}

/// Serializes every read-modify-write of the index against the backfill
/// job's own writes (`mark_analyzed`) — those run one per file across the CPU
/// lane's several worker threads, so without this two finishing at once could
/// clobber each other's `analyzed: true`. The lock only ever guards a JSON
/// load/save, never the DSP itself, so contention costs microseconds against
/// analysis work measured in the hundreds of milliseconds (§7.12).
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn load_index(app: &AppHandle) -> Index {
    index_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_index(app: &AppHandle, index: &Index) {
    let Some(path) = index_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(index) {
        let _ = std::fs::write(path, s);
    }
}

fn entry_for(path: &Path) -> Option<LibraryEntry> {
    let meta = std::fs::metadata(path).ok()?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(LibraryEntry { size: meta.len(), modified_ms, analyzed: false, lyrics_synced: false })
}

/// Recursive folder walk collecting audio files. Manual rather than a crate
/// (`walkdir` etc.) — the rest of this codebase reaches for `std` first and
/// pulls in a dependency only when there's real work `std` can't do; a
/// bounded-depth directory walk isn't that. Symlinks are not followed, so a
/// self-referential link cannot recurse forever.
fn scan_folder(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 12 {
        return; // implausibly deep for a music library; a cycle guard either way
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            scan_folder(&path, out, depth + 1);
        } else if file_type.is_file() {
            let is_audio = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false);
            if is_audio {
                out.push(path);
            }
        }
    }
}

/// The actual diff logic, pulled out from `rescan` so it's testable without a
/// real `AppHandle` — mirrors `correct.rs`'s split between the pure merge and
/// the network call around it.
///
/// `existing` is consumed and returned rather than mutated in place: the
/// caller (`rescan`) needs the freshly-loaded index either way, and taking
/// ownership here means this function can't accidentally be called against a
/// stale borrow of it.
fn diff_index(mut existing: Index, watched: &[PathBuf], found: &[PathBuf]) -> (Index, usize, usize) {
    // Entries whose file no longer sits under any watched folder — the folder
    // was removed, or the file itself was deleted/moved out from under it.
    existing.retain(|path, _| {
        let p = Path::new(path);
        watched.iter().any(|w| p.starts_with(w)) && p.exists()
    });

    let mut added = 0usize;
    let mut updated = 0usize;
    for path in found {
        let Some(fresh) = entry_for(path) else { continue };
        let key = path.to_string_lossy().to_string();
        match existing.get(&key) {
            Some(entry) if entry.size == fresh.size && entry.modified_ms == fresh.modified_ms => {}
            Some(_) => {
                updated += 1;
                existing.insert(key, fresh);
            }
            None => {
                added += 1;
                existing.insert(key, fresh);
            }
        }
    }
    (existing, added, updated)
}

/// Re-scan every watched folder, diff against the persisted index, save the
/// result, emit `library-changed` if anything moved, and queue whatever is
/// unanalysed for the Idle-lane backfill. Used both for the periodic
/// background pass and for the immediate scan a folder gets the moment it's
/// added — so `add_library_folder` doesn't leave the UI showing zero tracks
/// until the next `SCAN_INTERVAL_SECS` tick.
pub(crate) fn rescan(app: &AppHandle, folders: &[String]) {
    let watched: Vec<PathBuf> = folders.iter().map(PathBuf::from).collect();
    let mut found = Vec::new();
    for folder in &watched {
        scan_folder(folder, &mut found, 0);
    }

    let index = {
        let _guard = INDEX_LOCK.lock().unwrap();
        let (index, added, updated) = diff_index(load_index(app), &watched, &found);
        save_index(app, &index);
        let _ = app.emit(
            "library-changed",
            json!({ "trackCount": index.len(), "added": added, "updated": updated }),
        );
        index
    };

    queue_backfill(app, &index);
}

/// Submit the Idle-lane backfill jobs for whatever the index doesn't already
/// cover at its current size/mtime — one `LibraryAnalyzeJob` per unanalysed
/// file (`Lane::Cpu`) and one `LibraryLyricsJob` per file with no lyrics
/// lookup attempted yet (`Lane::Io`). One job per file rather than one job
/// for the whole backlog — unlike `PresyncJob`'s single serial loop (which
/// exists to be polite to a network API's rate), each file here is
/// independent work with nothing to be polite to *across* files, so this
/// should actually use both lanes' worker threads rather than tie up one of
/// them running everything serially. Each job dedupes on its own path, so
/// calling this again while a scan's earlier backfill is still in flight
/// queues nothing twice.
fn queue_backfill(app: &AppHandle, index: &Index) {
    for (path, entry) in index {
        if !entry.analyzed {
            jobs::submit(LibraryAnalyzeJob { app: app.clone(), path: path.clone() }, Priority::Idle);
        }
        if !entry.lyrics_synced {
            jobs::submit(LibraryLyricsJob { app: app.clone(), path: path.clone() }, Priority::Idle);
        }
    }
}

/// Flip one entry's `analyzed` flag once its analysis is written to disk —
/// under `INDEX_LOCK` since several of these can race across the CPU lane's
/// worker threads. Silently drops the update if the entry's on-disk shape
/// moved on since this job started (size/mtime no longer match `expect`): the
/// file changed again mid-analysis, so this job's result is already stale and
/// the next scan will queue a fresh one rather than wrongly marking it done.
fn mark_analyzed(app: &AppHandle, path: &str, expect: &LibraryEntry) {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut index = load_index(app);
    if let Some(entry) = index.get_mut(path) {
        if entry.size == expect.size && entry.modified_ms == expect.modified_ms {
            entry.analyzed = true;
            save_index(app, &index);
        }
    }
}

/// Same shape as `mark_analyzed`, for the lyrics lookup. Set regardless of
/// whether `warm_lyrics_cache` actually found anything — a miss is a real
/// answer (LRCLIB/NetEase/Kugou don't have this song under this guessed
/// title), not a reason to re-hit those services on every scan tick forever.
fn mark_lyrics_synced(app: &AppHandle, path: &str, expect: &LibraryEntry) {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut index = load_index(app);
    if let Some(entry) = index.get_mut(path) {
        if entry.size == expect.size && entry.modified_ms == expect.modified_ms {
            entry.lyrics_synced = true;
            save_index(app, &index);
        }
    }
}

/// A watched file's guessed title, the same way `playback::local_item` guesses
/// one for the queue: the filename stem, no artist. It is what
/// `open_local_folder`/`LocalPlayer` already play a file under, so a lyrics
/// lookup made under this name is exactly as good a guess as the one that
/// would run anyway the moment this file is actually pressed play on — this
/// backfill just makes that guess ahead of time instead of at that moment.
fn guessed_title(path: &str) -> String {
    Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

/// The Idle-lane job behind `queue_backfill`: the same DSP pass
/// `analyze_local_file` runs on demand, run ahead of time and persisted.
///
/// `track()` is left as `None` — this is background work on files that are
/// not necessarily playing (most of them, almost always), so a track change
/// must not cancel it, matching `PresyncJob`'s same reasoning.
struct LibraryAnalyzeJob {
    app: AppHandle,
    path: String,
}

impl Runnable for LibraryAnalyzeJob {
    fn lane(&self) -> Lane {
        Lane::Cpu
    }

    fn dedup_key(&self) -> String {
        format!("library-analyze:{}", self.path)
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let LibraryAnalyzeJob { app, path } = *self;
        if cancel.cancelled() {
            return;
        }
        let Some(expect) = entry_for(Path::new(&path)) else { return }; // gone since it was queued
        let full = analyze_local_file_value(&path);
        if full.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return; // symphonia couldn't decode it — nothing to persist, don't loop retrying every scan
        }

        // Strip the per-window envelope (`windowMs`/`level`/`bass`/`treble`/
        // `onsets`): live-reactive data the renderer wants during THIS play,
        // not a durable summary — keeping it would multiply this cache's size
        // by the sample count of every song in the library for no reason a
        // cold backfill needs. `beats`/`key`/`sectionStartsMs`/`loudness`/
        // `durationMs` are what a future "start already known" read wants.
        let mut summary = full;
        if let Some(obj) = summary.as_object_mut() {
            for field in ["windowMs", "level", "bass", "treble", "onsets"] {
                obj.remove(field);
            }
        }

        if let Some(cache_path) = analysis_cache_path(&app, &path) {
            let _ = std::fs::write(cache_path, serde_json::to_string(&summary).unwrap_or_default());
        }
        mark_analyzed(&app, &path, &expect);
    }
}

/// The Idle-lane job behind `queue_backfill`'s lyrics half: the same
/// `warm_lyrics_cache` the local-queue lookahead (`PrecomputeJob` in
/// `lyrics_cmds.rs`) uses, run for a watched file instead of a queued one.
/// Writing to the shared lyrics cache is what makes this file's "lyrics"
/// badge in the Library panel (`list_synced`) light up without it ever
/// having been played, and what makes pressing play on it later take the
/// instant cache-hit path instead of a live lookup.
///
/// `track()` is `None` for the same reason `LibraryAnalyzeJob`'s is: this is
/// background work on files that are not necessarily playing, so a track
/// change must not cancel it.
struct LibraryLyricsJob {
    app: AppHandle,
    path: String,
}

impl Runnable for LibraryLyricsJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("library-lyrics:{}", self.path)
    }

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let LibraryLyricsJob { app, path } = *self;
        if cancel.cancelled() {
            return;
        }
        let Some(expect) = entry_for(Path::new(&path)) else { return }; // gone since it was queued
        let title = guessed_title(&path);
        if title.is_empty() {
            return;
        }
        let key = track_key("", &title);
        warm_lyrics_cache(&app, &title, "", &key, cancel);
        mark_lyrics_synced(&app, &path, &expect);
    }
}

/// Track counts per watched folder, for a settings panel — total found, how
/// many the audio backfill has reached, and how many the lyrics backfill has
/// (e.g. "88/142 lyrics synced"). Read fresh from disk rather than threaded
/// through, since this is called rarely (opening a settings panel), not from
/// the hot path.
pub(crate) fn folder_summaries(app: &AppHandle, folders: &[String]) -> Vec<Value> {
    let index = load_index(app);
    folders
        .iter()
        .map(|f| {
            let entries: Vec<&LibraryEntry> = index.iter().filter(|(k, _)| Path::new(k).starts_with(f)).map(|(_, v)| v).collect();
            let analyzed = entries.iter().filter(|e| e.analyzed).count();
            let lyrics_synced = entries.iter().filter(|e| e.lyrics_synced).count();
            json!({
                "path": f,
                "trackCount": entries.len(),
                "analyzedCount": analyzed,
                "lyricsSyncedCount": lyrics_synced,
            })
        })
        .collect()
}

/// Drop every index entry under `folder` — called when a folder is removed
/// from the watch list, so a stale count doesn't linger until the next scan
/// happens to walk (and thus correct) it.
pub(crate) fn forget_folder(app: &AppHandle, folder: &str) {
    let _guard = INDEX_LOCK.lock().unwrap();
    let mut index = load_index(app);
    let prefix = PathBuf::from(folder);
    index.retain(|path, _| !Path::new(path).starts_with(&prefix));
    save_index(app, &index);
}

/// Background thread: re-scan the watched folders every `SCAN_INTERVAL_SECS`.
/// Reads the folder list fresh from `Prefs` each tick rather than taking a
/// snapshot at startup, so `add_library_folder`/`remove_library_folder`
/// (which persist to the same `Prefs`) are picked up without restarting
/// anything — the same "no threads torn down and rebuilt" shape as the SMTC
/// and wallpaper watchers in watchers.rs.
pub(crate) fn start_library_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS));
        let Some(state) = app.try_state::<std::sync::Mutex<crate::state::Prefs>>() else { continue };
        let folders = state.lock().unwrap().library_folders.clone();
        if folders.is_empty() {
            continue;
        }
        rescan(&app, &folders);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh directory under the OS temp dir, unique per test run within
    /// this process — parallel `cargo test` threads must not collide.
    fn scratch_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("lyric-overlay-library-test-{name}-{n}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn scan_folder_finds_audio_files_and_ignores_everything_else() {
        let dir = scratch_dir("scan");
        write_file(&dir, "song.mp3", "x");
        write_file(&dir, "cover.jpg", "x");
        write_file(&dir, "notes.txt", "x");
        std::fs::create_dir(dir.join("sub")).unwrap();
        write_file(&dir.join("sub"), "deeper.flac", "x");

        let mut found = Vec::new();
        scan_folder(&dir, &mut found, 0);
        let names: Vec<String> = found.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).collect();

        assert_eq!(found.len(), 2, "expected exactly the .mp3 and the nested .flac, got {names:?}");
        assert!(names.contains(&"song.mp3".to_string()));
        assert!(names.contains(&"deeper.flac".to_string()));
    }

    #[test]
    fn scan_folder_is_case_insensitive_on_extension() {
        let dir = scratch_dir("case");
        write_file(&dir, "LOUD.MP3", "x");
        let mut found = Vec::new();
        scan_folder(&dir, &mut found, 0);
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_depth_limit_stops_a_pathological_walk() {
        // Not a real-world library shape, but a guard against a future bug
        // (or a symlink loop slipping past the is_symlink check some other
        // way) turning a folder add into an unbounded recursion.
        let dir = scratch_dir("depth");
        let mut cur = dir.clone();
        for i in 0..20 {
            cur = cur.join(format!("d{i}"));
            std::fs::create_dir(&cur).unwrap();
        }
        write_file(&cur, "buried.mp3", "x");
        let mut found = Vec::new();
        scan_folder(&dir, &mut found, 0);
        assert!(found.is_empty(), "20 levels deep should have been cut off by the depth guard");
    }

    #[test]
    fn a_new_file_is_reported_as_added() {
        let dir = scratch_dir("added");
        let path = write_file(&dir, "a.mp3", "hello");
        let (index, added, updated) = diff_index(Index::new(), std::slice::from_ref(&dir), std::slice::from_ref(&path));
        assert_eq!(added, 1);
        assert_eq!(updated, 0);
        assert!(index.contains_key(&path.to_string_lossy().to_string()));
    }

    #[test]
    fn an_unchanged_file_is_reported_as_neither() {
        let dir = scratch_dir("unchanged");
        let path = write_file(&dir, "a.mp3", "hello");
        let entry = entry_for(&path).unwrap();
        let mut existing = Index::new();
        existing.insert(path.to_string_lossy().to_string(), entry);

        let (_, added, updated) = diff_index(existing, std::slice::from_ref(&dir), std::slice::from_ref(&path));
        assert_eq!((added, updated), (0, 0));
    }

    #[test]
    fn a_changed_file_is_reported_as_updated_not_added() {
        let dir = scratch_dir("changed");
        let path = write_file(&dir, "a.mp3", "hello");
        let mut existing = Index::new();
        existing.insert(path.to_string_lossy().to_string(), LibraryEntry { size: 999, modified_ms: 1, analyzed: true, lyrics_synced: true });

        let (index, added, updated) = diff_index(existing, std::slice::from_ref(&dir), std::slice::from_ref(&path));
        assert_eq!((added, updated), (0, 1));
        let entry = index.get(&path.to_string_lossy().to_string()).unwrap();
        assert_eq!(entry.size, 5);
        assert!(!entry.analyzed, "a changed file's stale analysis must not survive as if it still applied");
        assert!(!entry.lyrics_synced, "a changed file's stale lyrics-synced flag must not survive either");
    }

    #[test]
    fn an_unchanged_files_analyzed_flag_survives_a_rescan() {
        let dir = scratch_dir("stays-analyzed");
        let path = write_file(&dir, "a.mp3", "hello");
        let mut existing = Index::new();
        let mut entry = entry_for(&path).unwrap();
        entry.analyzed = true;
        existing.insert(path.to_string_lossy().to_string(), entry);

        let (index, added, updated) = diff_index(existing, std::slice::from_ref(&dir), std::slice::from_ref(&path));
        assert_eq!((added, updated), (0, 0));
        assert!(index.get(&path.to_string_lossy().to_string()).unwrap().analyzed);
    }

    #[test]
    fn a_file_removed_from_disk_drops_out_of_the_index() {
        let dir = scratch_dir("removed");
        let gone = dir.join("gone.mp3"); // never actually written
        let mut existing = Index::new();
        existing.insert(gone.to_string_lossy().to_string(), LibraryEntry { size: 1, modified_ms: 1, analyzed: false, lyrics_synced: false });

        let (index, added, updated) = diff_index(existing, std::slice::from_ref(&dir), &[]);
        assert!(index.is_empty());
        assert_eq!((added, updated), (0, 0));
    }

    #[test]
    fn a_file_outside_every_watched_folder_is_dropped_even_if_it_still_exists() {
        // Simulates a folder being removed from the watch list: its files
        // still exist on disk, but no longer sit under any watched path.
        let dir = scratch_dir("unwatched");
        let path = write_file(&dir, "a.mp3", "hello");
        let mut existing = Index::new();
        existing.insert(path.to_string_lossy().to_string(), entry_for(&path).unwrap());

        let (index, _, _) = diff_index(existing, &[], &[]);
        assert!(index.is_empty());
    }
}
