//! Synced-lyric lookup against LRCLIB.
//!
//! A focused Rust port of the parts of the old `src/main/lyrics.js` that the
//! core loop needs: clean the messy SMTC title/artist, search LRCLIB's
//! free-text endpoint, score candidates by title/artist/duration/version, and
//! parse the winning LRC into timestamped cues (folding textless gap markers
//! into `endMs`). NetEase/Kugou/plain-lyric fallbacks and the LLM passes are
//! later phases.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

const LRCLIB_SEARCH: &str = "https://lrclib.net/api/search";
const USER_AGENT: &str = "lyric-overlay/0.25.0 (personal project)";

/// The track we are looking up.
pub struct Track {
    pub title: String,
    pub artist: String,
    pub duration_ms: i64,
}

/// One timestamped lyric line. Serialises to the shape the renderer expects.
#[derive(Serialize, Clone)]
pub struct Cue {
    #[serde(rename = "timeMs")]
    pub time_ms: i64,
    pub text: String,
    #[serde(rename = "endMs", skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
}

/// Words that mark a *different recording* — a studio LRC won't line up with a
/// live/remix cut even at a similar duration.
const VERSION_TOKENS: &[&str] = &[
    "live", "remix", "acoustic", "unplugged", "instrumental", "slowed", "reverb",
    "sped", "speedup", "remastered", "cover", "karaoke", "demo", "extended",
    "mashup", "reprise", "bonus", "edit", "rework", "flip", "bootleg",
];

static NOISE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\((?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?|lyric video|mv|hd|4k)\)",
        r"(?i)\[(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?|lyric video|mv|hd|4k)\]",
        r"(?i)\((?:prod\.?|prod by)[^)]*\)",
        r"(?i)\b(?:official\s+)?(?:music\s+)?video\b",
        r"(?i)\bfull\s+(?:song|video|album)\b",
        r"(?i)\bremaster(?:ed)?(?:\s+\d{4})?\b",
        r"(?i)\b(?:official\s+)?(?:audio|lyrical|lyric)\b",
        r"(?i)\bout\s+now\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

static FEAT_PARENS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\((?:feat\.?|ft\.?|with)[^)]*\)").unwrap());
static FEAT_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:feat\.?|ft\.?)\s+.*$").unwrap());
static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\s]").unwrap());
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static LINE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]").unwrap());

/// Lowercase, strip punctuation, collapse whitespace. Keeps non-Latin scripts.
fn normalize(value: &str) -> String {
    let lowered = value.to_lowercase();
    let no_punct = NON_ALNUM.replace_all(&lowered, " ");
    WS.replace_all(&no_punct, " ").trim().to_string()
}

/// Token-overlap similarity in [0, 1].
pub fn token_similarity(a: &str, b: &str) -> f64 {
    let na = normalize(a);
    let nb = normalize(b);
    let sa: std::collections::HashSet<&str> = na.split(' ').filter(|s| !s.is_empty()).collect();
    let sb: std::collections::HashSet<&str> = nb.split(' ').filter(|s| !s.is_empty()).collect();
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let shared = sa.iter().filter(|t| sb.contains(*t)).count();
    shared as f64 / sa.len().max(sb.len()) as f64
}

/// Version markers present in a raw title/album string.
pub fn version_tags(raw: &str) -> std::collections::HashSet<String> {
    let words: std::collections::HashSet<String> =
        normalize(raw).split(' ').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    VERSION_TOKENS
        .iter()
        .filter(|t| words.contains(**t))
        .map(|t| t.to_string())
        .collect()
}

/// Strip platform noise from a raw media title.
pub fn clean_title(raw: &str) -> String {
    let mut out = raw.to_string();
    if let Some(idx) = out.find('|') {
        out = out[..idx].to_string();
    }
    for re in NOISE_PATTERNS.iter() {
        out = re.replace_all(&out, " ").to_string();
    }
    out = FEAT_PARENS.replace_all(&out, " ").to_string();
    out = FEAT_TAIL.replace_all(&out, " ").to_string();
    out = out.replace(['"', '\'', '`', '‘', '’', '“', '”'], " ");
    let out = WS.replace_all(&out, " ").trim().to_string();
    if out.is_empty() {
        raw.trim().to_string()
    } else {
        out
    }
}

/// Strip "- Topic" / VEVO from an artist credit.
pub fn clean_artist(raw: &str) -> String {
    let lowered = raw.to_lowercase();
    let mut out = raw.to_string();
    if let Some(pos) = lowered.rfind("- topic") {
        out = out[..pos].to_string();
    }
    let trimmed = out.trim();
    let stripped = trimmed.strip_suffix("VEVO").or_else(|| trimmed.strip_suffix("vevo")).unwrap_or(trimmed);
    let cleaned = WS.replace_all(stripped, " ").trim().to_string();
    if cleaned.is_empty() {
        raw.trim().to_string()
    } else {
        cleaned
    }
}

/// Score one LRCLIB candidate. Requires syncedLyrics. Negative = reject.
fn score_candidate(candidate: &Value, track: &Track) -> f64 {
    if candidate.get("syncedLyrics").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return -1.0;
    }
    let cleaned_title = clean_title(&track.title);
    let track_name = candidate.get("trackName").and_then(|v| v.as_str()).unwrap_or("");
    let artist_name = candidate.get("artistName").and_then(|v| v.as_str()).unwrap_or("");

    let title_score = token_similarity(&cleaned_title, track_name)
        .max(token_similarity(&cleaned_title, &format!("{track_name} {artist_name}")));

    let cleaned_artist = clean_artist(&track.artist);
    let artist_score = if cleaned_artist.is_empty() {
        0.0
    } else {
        token_similarity(&cleaned_artist, artist_name)
    };

    let mut score = title_score * 2.0 + artist_score;

    let cand_dur = candidate.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if track.duration_ms > 0 && cand_dur > 0.0 {
        let delta = (cand_dur - track.duration_ms as f64 / 1000.0).abs();
        if delta <= 2.0 {
            score += 1.5;
        } else if delta <= 5.0 {
            score += 0.75;
        } else if delta > 20.0 {
            score -= 1.0;
        }
    }

    let want = version_tags(&track.title);
    let album = candidate.get("albumName").and_then(|v| v.as_str()).unwrap_or("");
    let have = version_tags(&format!("{track_name} {album}"));
    let mut mismatch = 0;
    for tag in &want {
        if !have.contains(tag) {
            mismatch += 1;
        }
    }
    for tag in &have {
        if !want.contains(tag) {
            mismatch += 1;
        }
    }
    score - mismatch as f64 * 1.25
}

/// Parse an LRC document into ordered cues, folding textless stamps into `endMs`.
pub fn parse_lrc(lrc: &str) -> Vec<Cue> {
    let mut stamped: Vec<(i64, String)> = Vec::new();
    for raw_line in lrc.split('\n') {
        let mut stamps: Vec<i64> = Vec::new();
        for cap in LINE_TAG.captures_iter(raw_line) {
            let minutes: i64 = cap[1].parse().unwrap_or(0);
            let seconds: i64 = cap[2].parse().unwrap_or(0);
            let frac_raw = cap.get(3).map(|m| m.as_str()).unwrap_or("0");
            let mut frac = frac_raw.to_string();
            while frac.len() < 3 {
                frac.push('0');
            }
            let fraction: i64 = frac[..3].parse().unwrap_or(0);
            stamps.push(minutes * 60_000 + seconds * 1000 + fraction);
        }
        if stamps.is_empty() {
            continue;
        }
        let text = LINE_TAG.replace_all(raw_line, "").trim().to_string();
        for t in stamps {
            stamped.push((t, text.clone()));
        }
    }
    stamped.sort_by_key(|(t, _)| *t);

    // Fold textless markers into endMs on the line they close.
    let mut out: Vec<Cue> = Vec::new();
    for (time_ms, text) in stamped {
        if text.is_empty() {
            if let Some(last) = out.last_mut() {
                if last.end_ms.is_none() && time_ms > last.time_ms {
                    last.end_ms = Some(time_ms);
                }
            }
            continue;
        }
        out.push(Cue { time_ms, text, end_ms: None });
    }
    out
}

/// Look up synced lyrics for a track. Returns (cues, source label) or None.
pub fn fetch_synced(track: &Track) -> Option<(Vec<Cue>, Value)> {
    let query = format!("{} {}", clean_title(&track.title), track.artist);
    let query = query.trim();
    if query.is_empty() {
        return None;
    }

    let resp = ureq::get(LRCLIB_SEARCH)
        .set("User-Agent", USER_AGENT)
        .query("q", query)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .ok()?;
    let results: Value = resp.into_json().ok()?;
    let arr = results.as_array()?;
    if arr.is_empty() {
        return None;
    }

    let mut best: Option<&Value> = None;
    let mut best_score = 0.0_f64;
    for candidate in arr {
        let s = score_candidate(candidate, track);
        if s > best_score {
            best_score = s;
            best = Some(candidate);
        }
    }
    // Require a meaningful match, mirroring the JS floor.
    let best = best?;
    if best_score < 1.0 {
        return None;
    }
    let synced = best.get("syncedLyrics").and_then(|v| v.as_str())?;
    let cues = parse_lrc(synced);
    if cues.is_empty() {
        return None;
    }

    let source = serde_json::json!({
        "id": best.get("id"),
        "trackName": best.get("trackName"),
        "artistName": best.get("artistName"),
        "duration": best.get("duration"),
        "score": (best_score * 100.0).round() / 100.0,
    });
    Some((cues, source))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_title_strips_noise_and_pipe_credits() {
        assert_eq!(clean_title("Blinding Lights (Official Video)"), "Blinding Lights");
        assert_eq!(clean_title("Song | Artist x Producer"), "Song");
        assert_eq!(clean_title("Track (feat. Someone)"), "Track");
        // Cleaning to empty falls back to the raw trimmed title.
        assert_eq!(clean_title("(Official Audio)"), "(Official Audio)");
    }

    #[test]
    fn clean_artist_strips_topic_and_vevo() {
        assert_eq!(clean_artist("Seedhe Maut - Topic"), "Seedhe Maut");
        assert_eq!(clean_artist("TheWeekndVEVO"), "TheWeeknd");
    }

    #[test]
    fn parse_lrc_folds_textless_markers_into_end_ms() {
        let lrc = "[00:14.15] Yeah\n[00:17.73]\n[00:27.85] I've been tryna call";
        let cues = parse_lrc(lrc);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Yeah");
        assert_eq!(cues[0].time_ms, 14_150);
        assert_eq!(cues[0].end_ms, Some(17_730)); // the blank line closed it
        assert_eq!(cues[1].text, "I've been tryna call");
        assert_eq!(cues[1].time_ms, 27_850);
    }

    #[test]
    fn score_rejects_candidates_without_synced_lyrics() {
        let track = Track { title: "X".into(), artist: "Y".into(), duration_ms: 0 };
        let cand = serde_json::json!({ "trackName": "X", "artistName": "Y" });
        assert!(score_candidate(&cand, &track) < 0.0);
    }

    // Live network test — run explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_fetch_known_song() {
        let track = Track {
            title: "Blinding Lights".into(),
            artist: "The Weeknd".into(),
            duration_ms: 200_000,
        };
        let result = fetch_synced(&track);
        assert!(result.is_some(), "expected LRCLIB to have Blinding Lights");
        let (cues, source) = result.unwrap();
        assert!(cues.len() > 5, "expected multiple synced lines, got {}", cues.len());
        eprintln!("matched: {source}");
        eprintln!("first line: [{}ms] {}", cues[0].time_ms, cues[0].text);
    }
}
