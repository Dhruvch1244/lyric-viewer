//! Listening history and the stats/insights panel built on it.
//!
//! `history.rs` already logs plays, but only the most recent 500 and only to
//! predict the next SMTC track — no timestamp, capped, and never meant to be
//! read back as a record of what was listened to. This is a second, separate
//! log purpose-built for that: append-only, unbounded, one line of JSON per
//! play (`listening-log.jsonl`), so a "this year in review" query never loses
//! data to the predictor's 500-entry cap and appending one play never costs a
//! read-modify-write of the whole file the way `history.rs`'s does.
//!
//! Written from the same call site as `history::record_play` (see
//! `SpeculateJob` in `commands/lyrics_cmds.rs`) — one play, two logs, each
//! kept for what only it is good at.
//!
//! Local-only, unlimited retention, by explicit choice: this is a real record
//! of exactly what was listened to and when, so `clear_listening_history`
//! exists precisely so that choice is reversible on demand, the same posture
//! `crashlog.rs` takes for its own local-only log.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const DAY_MS: i64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct PlayLogEntry {
    #[serde(rename = "playedAtMs")]
    played_at_ms: i64,
    key: String,
    title: String,
    artist: String,
    #[serde(rename = "durationMs", default)]
    duration_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("listening-log.jsonl"))
}

/// Append one play. O(1): opens in append mode and writes a single line,
/// never reads or rewrites what is already on disk — the whole reason this
/// log can be unbounded without every play getting slower as history grows.
pub fn append_play(app: &AppHandle, key: &str, title: &str, artist: &str, duration_ms: i64) {
    let Some(path) = log_path(app) else { return };
    let entry = PlayLogEntry { played_at_ms: now_ms(), key: key.to_string(), title: title.to_string(), artist: artist.to_string(), duration_ms };
    let Ok(line) = serde_json::to_string(&entry) else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Delete every recorded play. The one-click "clear my history" this feature
/// was explicitly built with, given unlimited local retention is a real
/// record of listening habits, not disposable cache.
pub fn clear(app: &AppHandle) {
    if let Some(path) = log_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Parse a `listening-log.jsonl` file's text into entries, skipping any line
/// that fails to parse — a corrupt or truncated last line (e.g. a write that
/// lost power mid-flush) must not take the whole history down with it.
fn parse_lines(text: &str) -> Vec<PlayLogEntry> {
    text.lines().filter_map(|line| serde_json::from_str::<PlayLogEntry>(line).ok()).collect()
}

/// Day index (days since the Unix epoch, UTC) for a millisecond timestamp.
fn epoch_day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS)
}

/// 0 = Sunday .. 6 = Saturday, from an epoch-day index. 1970-01-01 (day 0) was
/// a Thursday (index 4); hand-derived rather than pulling a date crate for one
/// arithmetic fact, matching how this codebase already prefers a few lines of
/// `std` over a dependency for work this small (see `library.rs`'s manual
/// path hash). UTC, not local time — Windows local-time conversion needs
/// either a crate or `GetTimeZoneInformation` FFI, neither of which is worth
/// it just to shift a "which day of the week" chart by a few hours near
/// midnight.
fn weekday_of(day: i64) -> usize {
    (day.rem_euclid(7) + 4).rem_euclid(7) as usize
}

/// Consecutive-day streak ending today (or ending yesterday if today simply
/// hasn't had a play yet — the day isn't over, so that must not read as a
/// broken streak).
fn current_streak(days: &HashSet<i64>, today: i64) -> i64 {
    let mut cursor = if days.contains(&today) {
        today
    } else if days.contains(&(today - 1)) {
        today - 1
    } else {
        return 0;
    };
    let mut streak = 0i64;
    while days.contains(&cursor) {
        streak += 1;
        cursor -= 1;
    }
    streak
}

/// The pure aggregation, genre lookup injected so it's testable without a
/// real `AppHandle` or disk — `compute_stats` below supplies the real one
/// (a read of the per-track lyrics-cache file `GenreJob` already writes to).
fn aggregate(entries: &[PlayLogEntry], today: i64, genre_of: impl Fn(&str) -> Option<String>) -> Value {
    let mut total_ms: i64 = 0;
    let mut artist_counts: HashMap<&str, (i64, i64)> = HashMap::new();
    let mut song_counts: HashMap<&str, (String, String, i64)> = HashMap::new();
    let mut weekday_counts = [0i64; 7];
    let mut days_played: HashSet<i64> = HashSet::new();
    let mut genre_cache: HashMap<&str, Option<String>> = HashMap::new();
    let mut genre_counts: HashMap<String, i64> = HashMap::new();

    for e in entries {
        total_ms += e.duration_ms.max(0);

        if !e.artist.is_empty() {
            let a = artist_counts.entry(e.artist.as_str()).or_insert((0, 0));
            a.0 += 1;
            a.1 += e.duration_ms.max(0);
        }

        let s = song_counts.entry(e.key.as_str()).or_insert_with(|| (e.title.clone(), e.artist.clone(), 0));
        s.2 += 1;

        let day = epoch_day(e.played_at_ms);
        days_played.insert(day);
        weekday_counts[weekday_of(day)] += 1;

        let genre = genre_cache.entry(e.key.as_str()).or_insert_with(|| genre_of(&e.key)).clone();
        if let Some(g) = genre {
            *genre_counts.entry(g).or_insert(0) += 1;
        }
    }

    let mut top_artists: Vec<(&str, (i64, i64))> = artist_counts.into_iter().collect();
    top_artists.sort_by_key(|(_, (plays, _))| std::cmp::Reverse(*plays));
    top_artists.truncate(8);

    let mut top_songs: Vec<(String, String, i64)> = song_counts.into_values().collect();
    top_songs.sort_by_key(|(_, _, plays)| std::cmp::Reverse(*plays));
    top_songs.truncate(8);

    let mut top_genres: Vec<(String, i64)> = genre_counts.into_iter().collect();
    top_genres.sort_by_key(|(_, plays)| std::cmp::Reverse(*plays));
    top_genres.truncate(8);

    json!({
        "totalPlays": entries.len(),
        "totalListeningMs": total_ms,
        "daysWithPlays": days_played.len(),
        "streakDays": current_streak(&days_played, today),
        "topArtists": top_artists.iter().map(|(name, (plays, ms))| json!({ "artist": name, "plays": plays, "listeningMs": ms })).collect::<Vec<_>>(),
        "topSongs": top_songs.iter().map(|(title, artist, plays)| json!({ "title": title, "artist": artist, "plays": plays })).collect::<Vec<_>>(),
        "topGenres": top_genres.iter().map(|(genre, plays)| json!({ "genre": genre, "plays": plays })).collect::<Vec<_>>(),
        "playsByWeekday": weekday_counts,
    })
}

/// This track's genre, if `genre.rs` has ever resolved and cached one for
/// it — read from the same per-track lyrics-cache file `mood`/`attribution`
/// already live in, not a separate index, so there is exactly one place a
/// track's genre can be wrong.
fn genre_of(app: &AppHandle, key: &str) -> Option<String> {
    let path = crate::commands::lyrics_cmds::lyrics_cache_path(app, key)?;
    let text = std::fs::read_to_string(path).ok()?;
    let cached: Value = serde_json::from_str(&text).ok()?;
    cached.get("genre").and_then(|g| g.as_str()).map(String::from)
}

/// This track's mood label, if `mood.rs` has ever resolved and cached one —
/// same cache file `genre_of` reads, one level deeper: the cached `mood`
/// field is the whole sentiment payload (`{mood, hue, energy, palette}`),
/// and only the free-text label itself is relevant for similarity.
fn mood_of(app: &AppHandle, key: &str) -> Option<String> {
    let path = crate::commands::lyrics_cmds::lyrics_cache_path(app, key)?;
    let text = std::fs::read_to_string(path).ok()?;
    let cached: Value = serde_json::from_str(&text).ok()?;
    cached.get("mood")?.get("mood").and_then(|m| m.as_str()).map(String::from)
}

/// Which axis a candidate song matches against the currently-playing one —
/// or `None` when it isn't similar at all. Mirrors `presets.js`'s `forTrack`
/// fallback order exactly (intersection first, then mood alone as "the axis
/// this app has trusted longer, and rejects fewer candidates than genre's
/// wider bucket set does" — that function's own words), so "similar" means
/// the same thing here as it already does for which visual a song gets.
/// A song with neither mood nor genre resolved yet has nothing to compare
/// candidates against, so nothing is "similar" to it.
fn similarity_tier(current: (Option<&str>, Option<&str>), candidate: (Option<&str>, Option<&str>)) -> Option<u8> {
    let same = |a: Option<&str>, b: Option<&str>| matches!((a, b), (Some(x), Some(y)) if x.eq_ignore_ascii_case(y));
    let mood_match = same(current.0, candidate.0);
    let genre_match = same(current.1, candidate.1);
    match (current.0.is_some(), current.1.is_some()) {
        (true, true) if mood_match && genre_match => Some(2),
        (true, true) if mood_match => Some(1),
        (true, false) if mood_match => Some(1),
        (false, true) if genre_match => Some(1),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
struct HistoryTrack {
    title: String,
    artist: String,
    last_played_ms: i64,
    plays: i64,
}

/// The pure matching + ranking, mood/genre lookups injected — same
/// testability pattern as `aggregate` above. `similar_songs` below supplies
/// the real ones (a read of the per-track lyrics-cache file).
fn build_similar(
    entries: &[PlayLogEntry],
    key: &str,
    current_mood: Option<&str>,
    current_genre: Option<&str>,
    mood_of: impl Fn(&str) -> Option<String>,
    genre_of: impl Fn(&str) -> Option<String>,
    limit: usize,
) -> Value {
    if current_mood.is_none() && current_genre.is_none() {
        return json!([]);
    }

    let mut by_key: HashMap<&str, HistoryTrack> = HashMap::new();
    for e in entries {
        if e.key == key {
            continue; // not similar to itself
        }
        let slot = by_key.entry(e.key.as_str()).or_insert_with(|| HistoryTrack {
            title: e.title.clone(),
            artist: e.artist.clone(),
            last_played_ms: 0,
            plays: 0,
        });
        slot.last_played_ms = slot.last_played_ms.max(e.played_at_ms);
        slot.plays += 1;
    }

    let mut scored: Vec<(u8, HistoryTrack)> = by_key
        .into_iter()
        .filter_map(|(k, track)| {
            let tier = similarity_tier((current_mood, current_genre), (mood_of(k).as_deref(), genre_of(k).as_deref()))?;
            Some((tier, track))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.last_played_ms.cmp(&a.1.last_played_ms)));
    scored.truncate(limit);

    json!(scored
        .into_iter()
        .map(|(tier, t)| json!({
            "title": t.title, "artist": t.artist, "lastPlayedMs": t.last_played_ms, "plays": t.plays, "tier": tier,
        }))
        .collect::<Vec<_>>())
}

/// Past-played songs whose mood/genre are similar to `key`'s track (see
/// `similarity_tier`), best tier first and most-recently-played within a
/// tier. On-demand only — nobody wants a listening-log scan running in the
/// background for every song, only for the one currently in front of the
/// user, same reasoning as `wiki.rs`'s on-demand-only doc comment.
pub fn similar_songs(app: &AppHandle, key: &str, limit: usize) -> Value {
    let Some(path) = log_path(app) else { return json!([]) };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let entries = parse_lines(&text);

    let current_mood = mood_of(app, key);
    let current_genre = genre_of(app, key);
    build_similar(&entries, key, current_mood.as_deref(), current_genre.as_deref(), |k| mood_of(app, k), |k| genre_of(app, k), limit)
}

/// Stats for the Insights panel. `days` restricts to the trailing window
/// (e.g. 30/365); `None` covers the whole unlimited log.
pub fn compute_stats(app: &AppHandle, days: Option<i64>) -> Value {
    let Some(path) = log_path(app) else { return json!({ "totalPlays": 0 }) };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let all = parse_lines(&text);

    let now = now_ms();
    let cutoff = days.map(|d| now - d * DAY_MS);
    let filtered: Vec<PlayLogEntry> = all.into_iter().filter(|e| cutoff.map_or(true, |c| e.played_at_ms >= c)).collect();

    aggregate(&filtered, epoch_day(now), |key| genre_of(app, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, title: &str, artist: &str, played_at_ms: i64, duration_ms: i64) -> PlayLogEntry {
        PlayLogEntry { played_at_ms, key: key.into(), title: title.into(), artist: artist.into(), duration_ms }
    }

    #[test]
    fn parse_lines_skips_a_corrupt_line_without_losing_the_rest() {
        let text = "not json\n{\"playedAtMs\":1,\"key\":\"a\",\"title\":\"A\",\"artist\":\"X\",\"durationMs\":1000}\n";
        let entries = parse_lines(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "a");
    }

    #[test]
    fn parse_lines_handles_an_empty_file() {
        assert!(parse_lines("").is_empty());
    }

    #[test]
    fn weekday_of_epoch_day_zero_is_thursday() {
        assert_eq!(weekday_of(0), 4);
    }

    #[test]
    fn weekday_of_wraps_correctly_across_a_week() {
        // day 0 = Thu(4), day 3 = Sun(0), day 10 = Sun(0) again.
        assert_eq!(weekday_of(3), 0);
        assert_eq!(weekday_of(10), 0);
    }

    #[test]
    fn current_streak_counts_consecutive_days_ending_today() {
        let days: HashSet<i64> = [100, 99, 98, 95].into_iter().collect();
        assert_eq!(current_streak(&days, 100), 3);
    }

    #[test]
    fn current_streak_survives_today_having_no_play_yet() {
        let days: HashSet<i64> = [99, 98].into_iter().collect();
        assert_eq!(current_streak(&days, 100), 2, "yesterday's streak must not read as broken before today ends");
    }

    #[test]
    fn current_streak_is_zero_after_a_real_gap() {
        let days: HashSet<i64> = [90].into_iter().collect();
        assert_eq!(current_streak(&days, 100), 0);
    }

    #[test]
    fn aggregate_counts_plays_and_listening_time() {
        let entries = vec![
            entry("a", "Song A", "Artist X", 0, 200_000),
            entry("a", "Song A", "Artist X", DAY_MS, 200_000),
            entry("b", "Song B", "Artist Y", DAY_MS * 2, 100_000),
        ];
        let out = aggregate(&entries, epoch_day(DAY_MS * 2), |_| None);
        assert_eq!(out["totalPlays"], 3);
        assert_eq!(out["totalListeningMs"], 500_000);
        assert_eq!(out["topArtists"][0]["artist"], "Artist X");
        assert_eq!(out["topArtists"][0]["plays"], 2);
    }

    #[test]
    fn aggregate_joins_genre_per_unique_key_not_per_play() {
        let entries = vec![entry("a", "Song A", "X", 0, 1000), entry("a", "Song A", "X", DAY_MS, 1000)];
        let calls = std::cell::Cell::new(0);
        let out = aggregate(&entries, epoch_day(DAY_MS), |_| {
            calls.set(calls.get() + 1);
            Some("Hip-Hop".to_string())
        });
        assert_eq!(calls.get(), 1, "genre lookup must be memoised per key within one aggregation, not repeated per play");
        assert_eq!(out["topGenres"][0]["genre"], "Hip-Hop");
        assert_eq!(out["topGenres"][0]["plays"], 2);
    }

    #[test]
    fn aggregate_on_an_empty_log_does_not_panic() {
        let out = aggregate(&[], 0, |_| None);
        assert_eq!(out["totalPlays"], 0);
        assert_eq!(out["streakDays"], 0);
    }

    /* ---------------------------------------------- similarity_tier --- */

    #[test]
    fn matching_both_mood_and_genre_is_the_best_tier() {
        let tier = similarity_tier((Some("Euphoric"), Some("Hip-Hop")), (Some("euphoric"), Some("hip-hop")));
        assert_eq!(tier, Some(2), "mood/genre matching must be case-insensitive too");
    }

    #[test]
    fn matching_mood_alone_beats_a_genre_mismatch_when_both_axes_are_known() {
        // Mirrors presets.js's forTrack: when both mood and genre are known
        // but only mood matches, the mood match still counts — genre alone
        // never overrides it, matching that function's own stated fallback
        // order (mood is "the axis this app has trusted longer").
        let tier = similarity_tier((Some("Euphoric"), Some("Hip-Hop")), (Some("Euphoric"), Some("Jazz")));
        assert_eq!(tier, Some(1));
    }

    #[test]
    fn a_genre_only_match_when_both_axes_are_known_is_not_similar() {
        // The asymmetric half of the fallback order above: genre matching
        // alone does not save a candidate whose mood disagrees.
        let tier = similarity_tier((Some("Euphoric"), Some("Hip-Hop")), (Some("Melancholic"), Some("Hip-Hop")));
        assert_eq!(tier, None);
    }

    #[test]
    fn mood_only_known_falls_back_to_a_mood_match() {
        let tier = similarity_tier((Some("Euphoric"), None), (Some("Euphoric"), Some("Hip-Hop")));
        assert_eq!(tier, Some(1));
    }

    #[test]
    fn genre_only_known_falls_back_to_a_genre_match() {
        let tier = similarity_tier((None, Some("Hip-Hop")), (Some("Euphoric"), Some("Hip-Hop")));
        assert_eq!(tier, Some(1));
    }

    #[test]
    fn neither_axis_known_on_the_current_track_matches_nothing() {
        assert_eq!(similarity_tier((None, None), (Some("Euphoric"), Some("Hip-Hop"))), None);
    }

    #[test]
    fn a_candidate_with_neither_axis_known_is_never_similar() {
        assert_eq!(similarity_tier((Some("Euphoric"), Some("Hip-Hop")), (None, None)), None);
    }

    /* ------------------------------------------------- build_similar --- */

    fn mood_lookup(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn a_song_with_no_known_mood_or_genre_returns_nothing() {
        let entries = vec![entry("b", "Song B", "Y", 0, 1000)];
        let out = build_similar(&entries, "a", None, None, |_| None, |_| None, 20);
        assert_eq!(out.as_array().unwrap().len(), 0);
    }

    #[test]
    fn the_current_track_itself_never_appears_in_its_own_results() {
        let entries = vec![entry("a", "Song A", "X", 0, 1000), entry("b", "Song B", "Y", DAY_MS, 1000)];
        let mood = mood_lookup(&[("a", "Euphoric"), ("b", "Euphoric")]);
        let out = build_similar(&entries, "a", Some("Euphoric"), None, mood, |_| None, 20);
        let titles: Vec<&str> = out.as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap()).collect();
        assert_eq!(titles, vec!["Song B"]);
    }

    #[test]
    fn results_rank_best_tier_first_then_most_recently_played() {
        let entries = vec![
            entry("older-full", "Older Full Match", "X", 0, 1000),
            entry("newer-mood-only", "Newer Mood Only", "Y", DAY_MS, 1000),
            entry("newest-full", "Newest Full Match", "Z", DAY_MS * 2, 1000),
        ];
        let mood = mood_lookup(&[("older-full", "Euphoric"), ("newer-mood-only", "Euphoric"), ("newest-full", "Euphoric")]);
        let genre = mood_lookup(&[("older-full", "Hip-Hop"), ("newer-mood-only", "Jazz"), ("newest-full", "Hip-Hop")]);
        let out = build_similar(&entries, "current", Some("Euphoric"), Some("Hip-Hop"), mood, genre, 20);
        let titles: Vec<&str> = out.as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap()).collect();
        assert_eq!(titles, vec!["Newest Full Match", "Older Full Match", "Newer Mood Only"]);
    }

    #[test]
    fn a_repeated_key_is_counted_once_with_its_own_play_count_and_latest_timestamp() {
        let entries = vec![
            entry("a", "Song A", "X", 0, 1000),
            entry("a", "Song A", "X", DAY_MS, 1000),
            entry("a", "Song A", "X", DAY_MS * 3, 1000),
        ];
        let mood = mood_lookup(&[("a", "Euphoric"), ("current", "Euphoric")]);
        let out = build_similar(&entries, "current", Some("Euphoric"), None, mood, |_| None, 20);
        let songs = out.as_array().unwrap();
        assert_eq!(songs.len(), 1);
        assert_eq!(songs[0]["plays"], 3);
        assert_eq!(songs[0]["lastPlayedMs"], DAY_MS * 3);
    }

    #[test]
    fn results_are_capped_at_the_requested_limit() {
        let entries: Vec<PlayLogEntry> =
            (0..30).map(|i| entry(&format!("k{i}"), &format!("Song {i}"), "X", i, 1000)).collect();
        let mood = |_: &str| Some("Euphoric".to_string());
        let out = build_similar(&entries, "current", Some("Euphoric"), None, mood, |_| None, 5);
        assert_eq!(out.as_array().unwrap().len(), 5);
    }
}
