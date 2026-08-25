//! Song/artist info from Wikipedia — the "about this" panel.
//!
//! Keyless, on the same footing as MusicBrainz/LRCLIB/iTunes/Deezer: this
//! codebase avoids HTML scraping on principle (see `artwork.rs`'s header and
//! `genius.rs`'s module doc, which hit a Cloudflare wall doing exactly that
//! for lyrics), so this talks to Wikipedia's real REST API, not its HTML.
//!
//! Two calls: MediaWiki's search API finds the best-matching page (an artist
//! or song name is rarely the exact page title — disambiguation, "(band)"
//! suffixes, stylised capitalisation), then the REST summary endpoint fetches
//! that page's lead extract.
//!
//! On demand only, unlike genre/mood/attribution — nobody reads an artist
//! bio for a song they are not currently looking at, so this is a plain
//! blocking `#[tauri::command]` (see `search_lyrics`/`artwork_candidates` for
//! the same shape) rather than a job queued at track-resolve time. The
//! command layer still caches the result into the per-track lyrics-cache
//! file so re-opening the panel for the same song costs nothing.

use serde_json::Value;

const SEARCH: &str = "https://en.wikipedia.org/w/api.php";
const SUMMARY: &str = "https://en.wikipedia.org/api/rest_v1/page/summary";
const USER_AGENT: &str = "LyricOverlay/0.48 (https://github.com/Dhruvch1244/lyric-viewer)";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn get_json(req: ureq::Request) -> Option<Value> {
    req.set("User-Agent", USER_AGENT).timeout(TIMEOUT).call().ok()?.into_json().ok()
}

/// A page's lead extract, enough to show and enough to sanity-check against.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub title: String,
    pub extract: String,
    pub thumbnail: Option<String>,
}

/// Percent-encode one URL path segment (NOT a query string — `ureq`'s
/// `.query()` already handles that elsewhere in this codebase). Operates on
/// UTF-8 bytes, so non-ASCII artist/song names encode correctly, not just
/// ASCII ones. Hand-rolled rather than a crate: this is the one path-segment
/// encode this module needs, the same "std first" reasoning `library.rs`'s
/// manual path hash and `lyrics_cmds.rs`'s manual track-key hash already use.
fn percent_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.replace(' ', "_").bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Best-matching Wikipedia page title for a search query, or nothing if the
/// search returned no hits at all.
fn search_title(query: &str) -> Option<String> {
    let json = get_json(
        ureq::get(SEARCH)
            .query("action", "query")
            .query("list", "search")
            .query("srsearch", query)
            .query("format", "json")
            .query("srlimit", "1"),
    )?;
    json.get("query")?.get("search")?.as_array()?.first()?.get("title")?.as_str().map(String::from)
}

/// Turn a REST summary response into a `Summary`, or nothing if it carries no
/// usable extract — a disambiguation page or a stub with no prose is not
/// worth showing.
fn parse_summary(body: &Value, fallback_title: &str) -> Option<Summary> {
    let extract = body.get("extract").and_then(|e| e.as_str()).unwrap_or("").trim().to_string();
    if extract.is_empty() {
        return None;
    }
    Some(Summary {
        title: body.get("title").and_then(|t| t.as_str()).unwrap_or(fallback_title).to_string(),
        extract,
        thumbnail: body.get("thumbnail").and_then(|t| t.get("source")).and_then(|s| s.as_str()).map(String::from),
    })
}

fn fetch_summary_by_title(title: &str) -> Option<Summary> {
    let path = percent_encode_path_segment(title);
    let json = get_json(ureq::get(&format!("{SUMMARY}/{path}")))?;
    parse_summary(&json, title)
}

/// An artist's Wikipedia bio: search, then summarise the best hit.
pub fn artist_summary(artist: &str) -> Option<Summary> {
    if artist.trim().is_empty() {
        return None;
    }
    let title = search_title(artist)?;
    fetch_summary_by_title(&title)
}

/// Whether a summary's extract plausibly is about `artist` — the artist's
/// name appears somewhere in the prose. A search landing on an unrelated
/// same-titled page is a wrong answer, and a wrong "about this song" is worse
/// than none — same refusal reasoning as `musicbrainz.rs::parse_recording`
/// rejecting half an answer.
fn mentions_artist(summary: &Summary, artist: &str) -> bool {
    artist.trim().is_empty() || summary.extract.to_lowercase().contains(&artist.trim().to_lowercase())
}

/// Song info for the panel: a song-specific article if one exists and
/// plausibly matches the artist, otherwise the artist's own bio as an honest
/// fallback rather than showing nothing.
pub fn song_info(title: &str, artist: &str) -> Option<Summary> {
    if title.trim().is_empty() {
        return None;
    }
    let song_query = if artist.trim().is_empty() { title.to_string() } else { format!("{title} {artist} song") };
    if let Some(page_title) = search_title(&song_query) {
        if let Some(summary) = fetch_summary_by_title(&page_title) {
            if mentions_artist(&summary, artist) {
                return Some(summary);
            }
        }
    }
    artist_summary(artist)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn percent_encode_turns_spaces_into_underscores() {
        assert_eq!(percent_encode_path_segment("Blinding Lights"), "Blinding_Lights");
    }

    #[test]
    fn percent_encode_escapes_non_ascii_utf8_bytes() {
        // "Sez" with a leading accented character, to exercise multi-byte UTF-8.
        let encoded = percent_encode_path_segment("Émiway");
        assert!(encoded.starts_with("%C3%89miway"), "got {encoded}");
    }

    #[test]
    fn percent_encode_leaves_unreserved_characters_alone() {
        assert_eq!(percent_encode_path_segment("KR$NA"), "KR%24NA");
        assert_eq!(percent_encode_path_segment("A-B.C_D~E"), "A-B.C_D~E");
    }

    #[test]
    fn parse_summary_extracts_title_extract_and_thumbnail() {
        let body = json!({
            "title": "Blinding Lights",
            "extract": "Blinding Lights is a song by The Weeknd.",
            "thumbnail": { "source": "https://example.com/cover.jpg" },
        });
        let s = parse_summary(&body, "fallback").unwrap();
        assert_eq!(s.title, "Blinding Lights");
        assert_eq!(s.extract, "Blinding Lights is a song by The Weeknd.");
        assert_eq!(s.thumbnail.as_deref(), Some("https://example.com/cover.jpg"));
    }

    #[test]
    fn parse_summary_rejects_a_page_with_no_prose() {
        let body = json!({ "title": "Disambiguation", "extract": "" });
        assert!(parse_summary(&body, "fallback").is_none());
    }

    #[test]
    fn parse_summary_falls_back_to_the_query_title_when_the_response_omits_one() {
        let body = json!({ "extract": "Some prose." });
        assert_eq!(parse_summary(&body, "Fallback Title").unwrap().title, "Fallback Title");
    }

    #[test]
    fn parse_summary_handles_a_missing_thumbnail() {
        let body = json!({ "title": "T", "extract": "Some prose." });
        assert_eq!(parse_summary(&body, "T").unwrap().thumbnail, None);
    }

    #[test]
    fn mentions_artist_is_case_insensitive() {
        let summary = Summary { title: "T".into(), extract: "A song BY The Weeknd.".into(), thumbnail: None };
        assert!(mentions_artist(&summary, "the weeknd"));
    }

    #[test]
    fn mentions_artist_rejects_an_unrelated_page() {
        let summary = Summary { title: "T".into(), extract: "A completely unrelated topic.".into(), thumbnail: None };
        assert!(!mentions_artist(&summary, "The Weeknd"));
    }

    #[test]
    fn mentions_artist_is_vacuously_true_with_no_artist_to_check() {
        let summary = Summary { title: "T".into(), extract: "Anything at all.".into(), thumbnail: None };
        assert!(mentions_artist(&summary, ""));
    }

    /// The live fetches, ignored by default — need the network but no key.
    /// `cargo test -p lyric-overlay -- --ignored wiki`
    #[test]
    #[ignore = "needs the network"]
    fn a_real_artist_bio_resolves() {
        let s = artist_summary("The Weeknd").expect("lookup failed");
        println!("{s:?}");
        assert!(!s.extract.is_empty());
    }

    #[test]
    #[ignore = "needs the network"]
    fn a_real_song_info_resolves_and_mentions_its_artist() {
        let s = song_info("Blinding Lights", "The Weeknd").expect("lookup failed");
        println!("{s:?}");
        assert!(mentions_artist(&s, "The Weeknd"));
    }
}
