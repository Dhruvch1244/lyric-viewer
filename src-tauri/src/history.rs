//! Play history, and the next-track prediction built on it.
//!
//! WHY THIS EXISTS. Phase 2 of the job engine is speculative precompute: warm
//! the lyrics cache for a song *before* it starts, so it opens instantly
//! instead of showing "searching…" for the length of a network round trip.
//! That needs an answer to "what plays next", and the two playback paths this
//! app supports answer it very differently:
//!
//! - **Local files** know exactly. `LocalPlayer` owns the queue, so the
//!   renderer hands the next entries straight to `precompute_tracks`. No
//!   guessing, and this module is not involved.
//! - **Everything else** (SMTC — Spotify, YouTube, any media app) does not.
//!   Windows' media session reports what is playing now; it exposes no queue
//!   and no next-track lookahead. The only signal available is what has
//!   followed this song before, which is what this module records.
//!
//! WHY THAT IS WORTH ANYTHING. Album and playlist listening is highly
//! repetitive: the same track order recurs every time the record is played.
//! Two observations of the same transition (`MIN_CONFIDENCE`) is enough to be
//! confident it is an ordering rather than a coincidence.
//!
//! WHAT IT COSTS WHEN WRONG. One lyric fetch that nobody reads. A prediction
//! never produces user-visible output — it only writes the on-disk lyrics
//! cache — so a wrong guess cannot show the wrong words for a song. That
//! asymmetry is why a fairly crude predictor is good enough here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One entry of playback history. Carries enough to run a lyric lookup
/// without a second source of truth — a bare key would be unusable, since
/// `track_key` is a one-way hash.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub(crate) struct Play {
    pub key: String,
    pub title: String,
    pub artist: String,
    #[serde(default, rename = "durationMs")]
    pub duration_ms: i64,
}

/// How many plays to keep. 500 is a few weeks of ordinary listening, scans in
/// microseconds, and keeps the file well under a megabyte. The cap exists so
/// this can never grow without bound on a machine that is never cleaned up.
const MAX_PLAYS: usize = 500;

/// How many times a transition must have been seen before it is acted on.
/// One occurrence is indistinguishable from two songs happening to be played
/// back to back once; two is a pattern.
const MIN_CONFIDENCE: usize = 2;

fn history_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("history.json"))
}

fn load(app: &AppHandle) -> Vec<Play> {
    let Some(path) = history_path(app) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(app: &AppHandle, plays: &[Play]) {
    let Some(path) = history_path(app) else { return };
    if let Ok(text) = serde_json::to_string(plays) {
        let _ = std::fs::write(path, text);
    }
}

/// Append a play to the on-disk history.
pub(crate) fn record_play(app: &AppHandle, play: Play) {
    let mut plays = load(app);
    if append(&mut plays, play) {
        save(app, &plays);
    }
}

/// The song most likely to follow `key`, or `None` when nothing clears
/// `MIN_CONFIDENCE`.
pub(crate) fn predict_next(app: &AppHandle, key: &str) -> Option<Play> {
    successor(&load(app), key)
}

/// Add a play, keeping the list bounded. Returns whether anything changed.
///
/// Ignores a repeat of whatever is already last. `resolve_lyrics` runs again
/// for the same song on a re-resolve (a script switch, a manual re-fetch), and
/// counting those would teach the predictor that every song is followed by
/// itself — which is both wrong and self-reinforcing, since it is the one
/// "transition" that recurs whenever the user changes a setting mid-song.
fn append(plays: &mut Vec<Play>, play: Play) -> bool {
    if plays.last().map(|p| p.key == play.key).unwrap_or(false) {
        return false;
    }
    plays.push(play);
    if plays.len() > MAX_PLAYS {
        let excess = plays.len() - MAX_PLAYS;
        plays.drain(..excess);
    }
    true
}

/// Most frequent successor of `key`, requiring `MIN_CONFIDENCE` sightings.
///
/// Ties break towards the most recent, on the theory that a listening habit
/// that changed recently is more likely to be the current one.
fn successor(plays: &[Play], key: &str) -> Option<Play> {
    let mut counts: HashMap<&str, (usize, usize)> = HashMap::new(); // key -> (count, last index)
    for (i, play) in plays.iter().enumerate() {
        if play.key != key {
            continue;
        }
        let Some(next) = plays.get(i + 1) else { continue };
        let entry = counts.entry(next.key.as_str()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = i + 1;
    }

    let (best_key, _) = counts.into_iter().filter(|(_, (count, _))| *count >= MIN_CONFIDENCE).max_by_key(|(_, (count, last))| (*count, *last))?;
    plays.iter().rev().find(|p| p.key == best_key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play(key: &str) -> Play {
        Play { key: key.to_string(), title: key.to_string(), artist: "artist".into(), duration_ms: 1000 }
    }

    fn history(keys: &[&str]) -> Vec<Play> {
        keys.iter().map(|k| play(k)).collect()
    }

    #[test]
    fn predicts_a_transition_seen_twice() {
        let plays = history(&["a", "b", "c", "a", "b"]);
        assert_eq!(successor(&plays, "a").map(|p| p.key), Some("b".to_string()));
    }

    #[test]
    fn ignores_a_transition_seen_only_once() {
        let plays = history(&["a", "b", "c"]);
        assert_eq!(successor(&plays, "a"), None, "one sighting is a coincidence, not a pattern");
    }

    #[test]
    fn picks_the_most_frequent_successor() {
        // a -> b twice, a -> z three times.
        let plays = history(&["a", "b", "a", "b", "a", "z", "a", "z", "a", "z"]);
        assert_eq!(successor(&plays, "a").map(|p| p.key), Some("z".to_string()));
    }

    #[test]
    fn returns_none_for_a_song_never_heard() {
        let plays = history(&["a", "b", "a", "b"]);
        assert_eq!(successor(&plays, "never"), None);
    }

    #[test]
    fn the_last_play_has_no_successor() {
        // "b" only ever appears last, so nothing has followed it.
        let plays = history(&["a", "b"]);
        assert_eq!(successor(&plays, "b"), None);
    }

    #[test]
    fn a_predicted_play_carries_enough_to_fetch_with() {
        let plays = history(&["a", "b", "a", "b"]);
        let next = successor(&plays, "a").expect("b follows a twice");
        assert_eq!(next.title, "b");
        assert_eq!(next.artist, "artist");
        assert_eq!(next.duration_ms, 1000);
    }

    #[test]
    fn append_ignores_a_repeat_of_the_current_song() {
        let mut plays = history(&["a"]);
        assert!(!append(&mut plays, play("a")), "a re-resolve must not record a second play");
        assert_eq!(plays.len(), 1);
        assert!(append(&mut plays, play("b")));
        assert_eq!(plays.len(), 2);
    }

    #[test]
    fn append_never_grows_past_the_cap() {
        let mut plays = Vec::new();
        for i in 0..(MAX_PLAYS + 50) {
            append(&mut plays, play(&format!("k{i}")));
        }
        assert_eq!(plays.len(), MAX_PLAYS);
        // The oldest are the ones dropped.
        assert_eq!(plays.first().unwrap().key, format!("k{}", 50));
        assert_eq!(plays.last().unwrap().key, format!("k{}", MAX_PLAYS + 49));
    }

    #[test]
    fn a_self_transition_is_never_learned_even_across_other_songs() {
        // Repeat-one listening: a, a, a would be collapsed by `append`.
        let mut plays = Vec::new();
        for _ in 0..5 {
            append(&mut plays, play("a"));
        }
        assert_eq!(plays.len(), 1);
        assert_eq!(successor(&plays, "a"), None);
    }
}
