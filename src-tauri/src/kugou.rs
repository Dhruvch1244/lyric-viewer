//! Kugou — a third synced lyric source (Western dance/pop with community sync).
//!
//! A Rust port of `kugou.js`. Public JSON endpoints, best-effort. Its one
//! structural quirk: lyrics are keyed by the audio file's `hash`, so a fetch is
//! three requests — search → find lyric docs for the hash → download one with
//! the per-lookup `accesskey` (a base64 LRC). Reuses the LRCLIB scorer/parser
//! and NetEase's credit stripper.

use base64::Engine;
use serde_json::{json, Value};

use crate::lyrics::{parse_lrc, score_candidate, Cue, Track};
use crate::netease::strip_credits;

const SEARCH_URL: &str = "https://mobiles.kugou.com/api/v3/search/song";
const LYRIC_SEARCH_URL: &str = "https://lyrics.kugou.com/search";
const LYRIC_DOWNLOAD_URL: &str = "https://lyrics.kugou.com/download";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const MAX_CANDIDATES: usize = 3;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

fn get_json(url: &str) -> Option<Value> {
    ureq::get(url).set("User-Agent", UA).timeout(TIMEOUT).call().ok()?.into_json().ok()
}

fn search(track: &Track) -> Vec<Value> {
    let query = format!("{} {}", track.title, track.artist);
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let url = format!(
        "{SEARCH_URL}?format=json&keyword={}&page=1&pagesize={}",
        urlencode(query),
        MAX_CANDIDATES * 2
    );
    get_json(&url)
        .and_then(|j| j.pointer("/data/info").and_then(|v| v.as_array().cloned()))
        .unwrap_or_default()
}

/// Fetch the best lyric document for a song hash (prefers the official one).
fn lyric_for_hash(hash: &str) -> Option<String> {
    if hash.is_empty() {
        return None;
    }
    let found = get_json(&format!("{LYRIC_SEARCH_URL}?ver=1&man=yes&client=pc&hash={}", urlencode(hash)))?;
    let candidates = found.get("candidates")?.as_array()?;
    if candidates.is_empty() {
        return None;
    }
    let official = candidates
        .iter()
        .find(|c| c.get("product_from").and_then(|v| v.as_str()).map(|s| s.contains("官方")).unwrap_or(false));
    let pick = official.or_else(|| candidates.first())?;
    let id = pick.get("id").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))?;
    let accesskey = pick.get("accesskey").and_then(|v| v.as_str())?;

    let doc = get_json(&format!(
        "{LYRIC_DOWNLOAD_URL}?ver=1&client=pc&fmt=lrc&charset=utf8&id={}&accesskey={}",
        urlencode(&id),
        urlencode(accesskey)
    ))?;
    let content = doc.get("content").and_then(|v| v.as_str())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(content).ok()?;
    String::from_utf8(bytes).ok()
}

fn to_candidate(song: &Value, lrc: &str) -> Value {
    let artist = song
        .get("singername")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .replace('、', ", ");
    json!({
        "trackName": song.get("songname_original").or_else(|| song.get("songname")).and_then(|v| v.as_str()).unwrap_or(""),
        "artistName": artist,
        "duration": song.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "syncedLyrics": lrc,
    })
}

/// Look up synced lyrics on Kugou. Same shape as the LRCLIB fetch.
pub fn fetch_synced(track: &Track) -> Option<(Vec<Cue>, Value)> {
    let songs = search(track);
    if songs.is_empty() {
        return None;
    }
    let mut best: Option<(Value, String)> = None;
    let mut best_score = 0.0_f64;
    for song in songs.iter().take(MAX_CANDIDATES) {
        let Some(hash) = song.get("hash").or_else(|| song.get("Hash")).and_then(|v| v.as_str()) else { continue };
        let Some(lrc) = lyric_for_hash(hash) else { continue };
        let cand = to_candidate(song, &lrc);
        let score = score_candidate(&cand, track);
        if score > best_score {
            best_score = score;
            best = Some((cand, lrc));
        }
    }
    let (cand, lrc) = best?;
    if best_score < 1.0 {
        return None;
    }
    let cues = strip_credits(parse_lrc(&lrc), cand.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));
    if cues.is_empty() {
        return None;
    }
    let source = json!({
        "name": "kugou",
        "trackName": cand.get("trackName"),
        "artistName": cand.get("artistName"),
        "score": (best_score * 100.0).round() / 100.0,
    });
    Some((cues, source))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
