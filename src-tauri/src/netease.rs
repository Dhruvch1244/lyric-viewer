//! NetEase Cloud Music — a second synced lyric source (strong on Asian pop).
//!
//! A Rust port of `netease.js`. Public JSON endpoints (the ones NetEase's own
//! web player uses), best-effort throughout: every failure returns None and the
//! caller falls through. Reuses the LRCLIB scorer and LRC parser so all sources
//! agree what a good match is. The `tlyric` translation track is deliberately
//! NOT used (on a Chinese service it is the translation *into* Chinese).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::lyrics::{clean_title, parse_lrc, score_candidate, Cue, Track};

const SEARCH_URL: &str = "https://music.163.com/api/search/get";
const LYRIC_URL: &str = "https://music.163.com/api/song/lyric";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const REFERER: &str = "https://music.163.com/";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Leading production-credit lines (作词/作曲/… : …, or Latin equivalents).
static CREDIT_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(作词|作曲|编曲|制作人|监制|混音|母带|和声|录音|吉他|贝斯|鼓|键盘|策划|出品|录音室|词|曲)\s*[:：]").unwrap()
});
static CREDIT_LATIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(lyricist|composer|arranger|produced by|written by|mixing|mastering|recorded by|lyrics by|composed by|arranged by|producer|mixed by|mastered by)\s*[:：]").unwrap()
});

fn get_json(url: &str) -> Option<Value> {
    ureq::get(url)
        .set("Referer", REFERER)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn search(track: &Track) -> Vec<Value> {
    let q = format!("{} {}", clean_title(&track.title), track.artist);
    let q = q.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let url = format!("{SEARCH_URL}?s={}&type=1&limit=10&offset=0", urlencode(q));
    get_json(&url)
        .and_then(|j| j.pointer("/result/songs").and_then(|s| s.as_array().cloned()))
        .unwrap_or_default()
}

/// Fetch the LRC for one song id (translation ignored — see module docs).
fn lyric_for(id: &Value) -> Option<String> {
    let id_str = id.as_i64().map(|n| n.to_string()).or_else(|| id.as_str().map(String::from))?;
    let url = format!("{LYRIC_URL}?id={id_str}&lv=1&kv=1&tv=-1");
    let json = get_json(&url)?;
    let lrc = json.pointer("/lrc/lyric").and_then(|v| v.as_str()).unwrap_or("");
    if lrc.trim().is_empty() {
        None
    } else {
        Some(lrc.to_string())
    }
}

fn to_candidate(song: &Value, lrc: &str) -> Value {
    let artists = song
        .get("artists")
        .or_else(|| song.get("ar"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let dur_ms = song.get("duration").or_else(|| song.get("dt")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    json!({
        "trackName": song.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "artistName": artists,
        "albumName": song.pointer("/album/name").or_else(|| song.pointer("/al/name")).and_then(|v| v.as_str()).unwrap_or(""),
        "duration": (dur_ms / 1000.0).round(),
        "syncedLyrics": lrc,
    })
}

/// Drop leading production-credit lines (and a "TITLE - artist/…" header) from
/// the front of a parsed LRC. Only from the front; never returns empty.
pub fn strip_credits(cues: Vec<Cue>, title_hint: &str) -> Vec<Cue> {
    if cues.is_empty() {
        return cues;
    }
    let hint = title_hint.trim().to_lowercase();
    let mut i = 0;
    if !hint.is_empty() {
        let first = cues[0].text.trim().to_lowercase();
        if first.starts_with(&hint) && first[hint.len()..].trim_start().starts_with('-') {
            i = 1;
        }
    }
    while i < cues.len() {
        let text = &cues[i].text;
        if !CREDIT_PREFIX.is_match(text) && !CREDIT_LATIN.is_match(text) {
            break;
        }
        i += 1;
    }
    if i >= cues.len() {
        Vec::new() // all credits, no lyrics — let the caller fall through
    } else {
        cues.into_iter().skip(i).collect()
    }
}

/// Look up synced lyrics on NetEase. Same shape as the LRCLIB fetch.
pub fn fetch_synced(track: &Track) -> Option<(Vec<Cue>, Value)> {
    let songs = search(track);
    if songs.is_empty() {
        return None;
    }
    let mut best: Option<(Value, String)> = None;
    let mut best_score = 0.0_f64;
    for song in songs.iter().take(4) {
        let Some(id) = song.get("id").or_else(|| song.get("songId")) else { continue };
        let Some(lrc) = lyric_for(id) else { continue };
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
        "name": "netease",
        "trackName": cand.get("trackName"),
        "artistName": cand.get("artistName"),
        "score": (best_score * 100.0).round() / 100.0,
    });
    Some((cues, source))
}

/// Minimal percent-encoding for a query value (ureq's .query would also work,
/// but the URLs here interpolate the query into a longer string).
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
