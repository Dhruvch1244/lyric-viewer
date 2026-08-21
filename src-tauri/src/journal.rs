//! The job journal (JOB-ENGINE §4, and the "not done" note in §7.1).
//!
//! §7.1 deferred this out of Phase 1 for two concrete reasons: every job that
//! existed then repaints the *playing* song, and nothing is playing at
//! startup, so replaying a journalled lyric/artwork/mood/attribution job
//! would push a previous session's result onto an idle overlay — worse than
//! losing it. And `Runnable` is a boxed trait object holding an `AppHandle`,
//! which cannot be serialized, so a real journal needs its own descriptor
//! shape rather than trying to persist the job type directly.
//!
//! Both are still true, and both are why this journal is scoped to exactly
//! one thing: **a transcription in flight when the app quits or crashes.**
//! It is the one job type worth resuming (§2.4) — a Whisper pass is minutes
//! of work, not a network round trip — and it is the one job type whose
//! result can be restored *safely*: a resumed transcription is written
//! straight into the track's cache file (`merge_track_cache`'s shape) with no
//! `lyrics` event, the same asymmetry Phase 2's precompute already relies on.
//! A wrong or late cache write is invisible; an emit to a UI showing nothing
//! is a visible glitch. See `resume` in `commands/lyrics_cmds.rs`.
//!
//! SCHEMA: one table, and **presence means incomplete**. A row is inserted
//! when a transcription starts and deleted the moment it finishes — success,
//! failure, or cancellation all delete it. So a row still present at the next
//! startup can only mean one thing: the process ended without running that
//! code, i.e. a crash or a kill, and its temp PCM file (deleted otherwise) is
//! still on disk, decoded and resampled, waiting for a decoder that never
//! got to run against it.
//!
//! WAL mode: concurrent readers with a single writer, which this workload
//! already is — the journal is written from the Inference lane and swept once
//! at startup, never both at once.
//!
//! SECOND TABLE, SAME FILE: `local_analysis` (JOB-ENGINE §5.7/§7). One row per
//! local file's `beats`/`key`/`sectionStartsMs`/`loudness` — the DSP suite
//! Phase 6 built, keyed on the file path plus its mtime/size so a file that
//! changed on disk after being analysed is correctly treated as stale rather
//! than serving a wrong answer for the wrong version of the file. Written by
//! both `analyze_local_file` (the interactive path, one file, on demand) and
//! the `Idle`-lane `LocalIndexJob` (`library.rs`, one per file in a folder just
//! opened) — the same cache, so whichever one gets there first is the one the
//! other reuses. This is the "SQLite replaces the JSON cache" §4 named,
//! finally with a second consumer to justify the table living here rather
//! than as its own file.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(crate) struct Journal(Mutex<Connection>);

/// One row left over from a session that did not end cleanly.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StaleJob {
    pub(crate) track_key: String,
    pub(crate) artist: String,
    pub(crate) title: String,
    pub(crate) duration_ms: i64,
    pub(crate) pcm_path: String,
    pub(crate) language: Option<String>,
}

fn db_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("lyric-overlay.db"))
}

/// Open (creating if absent) the journal database for this app.
pub(crate) fn open(app: &AppHandle) -> Option<Journal> {
    let path = db_path(app)?;
    let conn = Connection::open(&path)
        .map_err(|e| log::warn!("cannot open journal database at {}: {e}", path.display()))
        .ok()?;
    Journal::new(conn)
        .map_err(|e| log::warn!("cannot initialise journal schema: {e}"))
        .ok()
}

impl Journal {
    /// Build over an existing connection, and set up the schema. Split from
    /// `open` so tests can construct one over `Connection::open_in_memory()`
    /// without an `AppHandle` or a real file.
    fn new(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok(); // in-memory connections reject WAL; harmless to ignore
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS transcription_journal (
                id          INTEGER PRIMARY KEY,
                track_key   TEXT NOT NULL,
                artist      TEXT NOT NULL,
                title       TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                pcm_path    TEXT NOT NULL,
                language    TEXT,
                started_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_analysis (
                path        TEXT PRIMARY KEY,
                mtime       INTEGER NOT NULL,
                size        INTEGER NOT NULL,
                data        TEXT NOT NULL,
                analysed_at INTEGER NOT NULL
            );",
        )?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Record that a transcription is about to run. Returns the row id, which
    /// `finish` needs to remove exactly this row and no other — two
    /// transcriptions of the same track queued back to back (a rapid skip and
    /// return) must not let the second's `finish` delete the first's still-open
    /// row.
    pub(crate) fn start(
        &self,
        track_key: &str,
        artist: &str,
        title: &str,
        duration_ms: i64,
        pcm_path: &str,
        language: Option<&str>,
    ) -> Option<i64> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO transcription_journal (track_key, artist, title, duration_ms, pcm_path, language, started_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![track_key, artist, title, duration_ms, pcm_path, language, now_unix()],
        )
        .map_err(|e| log::warn!("cannot journal transcription start: {e}"))
        .ok()?;
        Some(conn.last_insert_rowid())
    }

    /// Remove a row — the job it describes reached a real end, one way or
    /// another. Called on success, failure, AND cancellation: all three mean
    /// there is no longer anything to resume.
    pub(crate) fn finish(&self, id: i64) {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute("DELETE FROM transcription_journal WHERE id = ?1", [id]);
    }

    /// Take every row left over from a previous, uncleanly-ended session.
    ///
    /// Each row is deleted as it is claimed, before the caller has attempted
    /// to resume it — a resume that itself crashes must not retry the same
    /// row forever. This is meant to be called exactly once, at startup,
    /// before any new row can exist to be confused with a stale one.
    pub(crate) fn take_stale(&self) -> Vec<StaleJob> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT id, track_key, artist, title, duration_ms, pcm_path, language FROM transcription_journal") {
            Ok(s) => s,
            Err(e) => {
                log::warn!("cannot read the journal: {e}");
                return Vec::new();
            }
        };
        let rows: Vec<(i64, StaleJob)> = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                StaleJob {
                    track_key: row.get(1)?,
                    artist: row.get(2)?,
                    title: row.get(3)?,
                    duration_ms: row.get(4)?,
                    pcm_path: row.get(5)?,
                    language: row.get(6)?,
                },
            ))
        }) {
            Ok(mapped) => mapped.filter_map(Result::ok).collect(),
            Err(e) => {
                log::warn!("cannot read the journal: {e}");
                return Vec::new();
            }
        };
        drop(stmt);

        for (id, _) in &rows {
            let _ = conn.execute("DELETE FROM transcription_journal WHERE id = ?1", [id]);
        }
        rows.into_iter().map(|(_, job)| job).collect()
    }

    /// A cached analysis for `path`, but only if it is still fresh — the
    /// stored `mtime`/`size` match what the caller just read off the file.
    /// Anything else (no row, or the file changed since) is treated as a
    /// miss: silently wrong analysis for a re-recorded/re-encoded file would
    /// be worse than the cost of one re-analysis.
    pub(crate) fn get_local_analysis(&self, path: &str, mtime: i64, size: u64) -> Option<Value> {
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let data: Option<String> = conn
            .query_row(
                "SELECT data FROM local_analysis WHERE path = ?1 AND mtime = ?2 AND size = ?3",
                params![path, mtime, size as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| log::warn!("cannot read local analysis cache for {path}: {e}"))
            .ok()?;
        data.and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Store (or replace) the analysis for `path` at its current `mtime`/`size`.
    /// Replacing rather than merging is deliberate — a stale row for a file
    /// that has since changed is exactly the row this call is meant to
    /// overwrite, not accumulate alongside.
    pub(crate) fn put_local_analysis(&self, path: &str, mtime: i64, size: u64, data: &Value) {
        let Ok(json) = serde_json::to_string(data) else { return };
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "INSERT INTO local_analysis (path, mtime, size, data, analysed_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, data = excluded.data, analysed_at = excluded.analysed_at",
            params![path, mtime, size as i64, json, now_unix()],
        );
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory_journal() -> Journal {
        Journal::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn a_finished_job_leaves_no_stale_row() {
        let j = memory_journal();
        let id = j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\a.pcm", Some("en")).unwrap();
        j.finish(id);
        assert!(j.take_stale().is_empty());
    }

    #[test]
    fn an_unfinished_job_is_stale_at_the_next_sweep() {
        let j = memory_journal();
        j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\a.pcm", Some("en")).unwrap();
        let stale = j.take_stale();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].track_key, "k1");
        assert_eq!(stale[0].artist, "Artist");
        assert_eq!(stale[0].pcm_path, "C:\\tmp\\a.pcm");
        assert_eq!(stale[0].language.as_deref(), Some("en"));
    }

    #[test]
    fn a_language_of_none_round_trips_as_none_not_a_string() {
        let j = memory_journal();
        j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\a.pcm", None).unwrap();
        let stale = j.take_stale();
        assert_eq!(stale[0].language, None);
    }

    #[test]
    fn take_stale_clears_the_journal_so_a_second_sweep_finds_nothing() {
        let j = memory_journal();
        j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\a.pcm", None).unwrap();
        assert_eq!(j.take_stale().len(), 1);
        assert!(j.take_stale().is_empty(), "a claimed row was not removed, so it would be resumed twice");
    }

    #[test]
    fn finishing_one_job_does_not_remove_a_different_jobs_row() {
        // Two transcriptions of the same track queued back to back (skip,
        // then return) — the second's `finish` must not delete the first's
        // still-open row.
        let j = memory_journal();
        let first = j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\a.pcm", None).unwrap();
        let _second = j.start("k1", "Artist", "Title", 180_000, "C:\\tmp\\b.pcm", None).unwrap();
        j.finish(first);
        let stale = j.take_stale();
        assert_eq!(stale.len(), 1, "finishing the first job affected the second's row");
        assert_eq!(stale[0].pcm_path, "C:\\tmp\\b.pcm");
    }

    #[test]
    fn an_empty_journal_sweeps_to_nothing_without_erroring() {
        let j = memory_journal();
        assert!(j.take_stale().is_empty());
    }

    #[test]
    fn multiple_stale_jobs_from_different_tracks_all_come_back() {
        let j = memory_journal();
        j.start("k1", "A1", "T1", 100_000, "C:\\tmp\\1.pcm", None).unwrap();
        j.start("k2", "A2", "T2", 200_000, "C:\\tmp\\2.pcm", Some("es")).unwrap();
        let stale = j.take_stale();
        assert_eq!(stale.len(), 2);
        assert!(stale.iter().any(|s| s.track_key == "k1"));
        assert!(stale.iter().any(|s| s.track_key == "k2" && s.language.as_deref() == Some("es")));
    }

    #[test]
    fn a_local_analysis_round_trips_at_the_same_mtime_and_size() {
        let j = memory_journal();
        let data = json!({ "ok": true, "beats": { "bpm": 120.0 } });
        j.put_local_analysis("C:\\music\\a.mp3", 1000, 4096, &data);
        assert_eq!(j.get_local_analysis("C:\\music\\a.mp3", 1000, 4096), Some(data));
    }

    #[test]
    fn a_changed_mtime_misses_the_cache() {
        let j = memory_journal();
        j.put_local_analysis("C:\\music\\a.mp3", 1000, 4096, &json!({ "ok": true }));
        assert_eq!(j.get_local_analysis("C:\\music\\a.mp3", 1001, 4096), None, "a file re-touched after analysis must not serve the old answer");
    }

    #[test]
    fn a_changed_size_misses_the_cache() {
        let j = memory_journal();
        j.put_local_analysis("C:\\music\\a.mp3", 1000, 4096, &json!({ "ok": true }));
        assert_eq!(j.get_local_analysis("C:\\music\\a.mp3", 1000, 4097), None, "a re-encoded file must not serve the old answer");
    }

    #[test]
    fn an_unanalysed_path_is_a_clean_miss() {
        let j = memory_journal();
        assert_eq!(j.get_local_analysis("C:\\music\\never-seen.mp3", 0, 0), None);
    }

    #[test]
    fn re_analysing_a_path_replaces_rather_than_duplicates() {
        let j = memory_journal();
        j.put_local_analysis("C:\\music\\a.mp3", 1000, 4096, &json!({ "beats": { "bpm": 100.0 } }));
        j.put_local_analysis("C:\\music\\a.mp3", 2000, 5000, &json!({ "beats": { "bpm": 128.0 } }));
        assert_eq!(j.get_local_analysis("C:\\music\\a.mp3", 1000, 4096), None, "the old mtime/size must no longer resolve");
        assert_eq!(j.get_local_analysis("C:\\music\\a.mp3", 2000, 5000), Some(json!({ "beats": { "bpm": 128.0 } })));
    }
}
