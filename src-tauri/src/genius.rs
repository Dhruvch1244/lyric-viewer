//! Genius — a second PLAIN (unsynced) lyric source, keyless. **Currently
//! non-functional in practice — see the CONFIRMED BLOCKED note below before
//! trusting this module for anything.**
//!
//! Genius's official OAuth developer API deliberately excludes lyrics text
//! (their terms reserve lyric display for their own site), so this was built
//! to go through two public, unauthenticated surfaces instead — the same
//! technique open-source Genius scrapers (lyricsgenius, Sonar) are documented
//! as using: the website's own search endpoint (what genius.com's search box
//! itself calls, not the developer API) to find the song's page, then that
//! page's HTML for the actual words.
//!
//! CONFIRMED BLOCKED (2026-08-17, live test): `search_hits`'s request to
//! `/api/search/multi` gets a Cloudflare-managed JS challenge every time
//! (`Cf-Mitigated: challenge`, HTTP 403), not a simple header check —
//! confirmed via 3 consecutive real requests, and via curl with a full
//! browser-shaped header set, both blocked identically. A plain HTTP client
//! cannot execute the JS challenge Cloudflare requires, and this project
//! does not build tooling to defeat bot-detection/anti-scraping measures —
//! that line doesn't move for "but it would help a feature work." No longer
//! called from `fetch_plain_any` in lib.rs (previously "left in place because
//! it fails CLOSED" — true, but that closed failure was still costing a
//! bounded network round trip on every LRCLIB-plain miss for zero chance of
//! success, so the call was pulled). The parsing logic
//! (extract_lyrics_containers / html_lyrics_to_text / best_url) is still
//! unit-tested and still correct for whatever HTML it's given. If Genius's
//! Cloudflare posture ever relaxes, or a legitimate (ToS-compliant) access
//! path turns up, wire `fetch_plain` back into `fetch_plain_any` — no other
//! changes needed.
//!
//! No API key needed — matches every other lyric source in this app (LRCLIB,
//! NetEase, Kugou). Used the same way LRCLIB's plain lyrics are: force-aligned
//! to a Whisper transcription's timing by align.rs, never shown raw/unsynced.

// Dormant per the note above: nothing outside `#[cfg(test)]` calls into this
// module right now, which would otherwise make every item here a dead-code
// warning. Kept live (not deleted) so re-enabling it is a one-line change in
// lib.rs, not a rewrite.
#![allow(dead_code)]

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::lyrics::{clean_title, token_similarity, Track};

const SEARCH_URL: &str = "https://genius.com/api/search/multi";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// Below this, the "best" search hit is still a bad match — title_score is
/// weighted ×2 (max 2.0) plus artist_score (max 1.0), so 0.9 wants roughly
/// half the title's words matched at minimum. A wrong page returns
/// confidently wrong lyrics, which is worse than no plain lyrics at all.
const MATCH_FLOOR: f64 = 0.9;

fn search_hits(track: &Track) -> Vec<Value> {
    let q = format!("{} {}", clean_title(&track.title), track.artist);
    let q = q.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let Ok(resp) = ureq::get(SEARCH_URL).set("User-Agent", UA).query("q", q).timeout(TIMEOUT).call() else {
        return Vec::new();
    };
    let Ok(json): Result<Value, _> = resp.into_json() else { return Vec::new() };
    let sections = json.pointer("/response/sections").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for section in &sections {
        if section.get("type").and_then(|v| v.as_str()) == Some("song") {
            return section.get("hits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        }
    }
    Vec::new()
}

/// Best-matching song page URL for `track`, or None if nothing scored well
/// enough. Genius search gives no track duration to cross-check the way
/// LRCLIB/NetEase/Kugou do, so title+artist token overlap is the only signal.
fn best_url(hits: &[Value], track: &Track) -> Option<String> {
    let cleaned_title = clean_title(&track.title);
    let mut best_score = f64::NEG_INFINITY;
    let mut best_url: Option<String> = None;
    for hit in hits {
        let Some(result) = hit.get("result") else { continue };
        let title = result.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let artist = result.pointer("/primary_artist/name").and_then(|v| v.as_str()).unwrap_or("");
        let url = result.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let title_score = token_similarity(&cleaned_title, title);
        let artist_score = if track.artist.trim().is_empty() { 0.0 } else { token_similarity(&track.artist, artist) };
        let score = title_score * 2.0 + artist_score;
        if score > best_score {
            best_score = score;
            best_url = Some(url.to_string());
        }
    }
    if best_score < MATCH_FLOOR {
        return None;
    }
    best_url
}

fn fetch_page(url: &str) -> Option<String> {
    ureq::get(url).set("User-Agent", UA).timeout(TIMEOUT).call().ok()?.into_string().ok()
}

static LYRICS_OPEN_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<div\b[^>]*\bdata-lyrics-container="true"[^>]*>"#).unwrap());
static ANY_DIV_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?div\b[^>]*>").unwrap());
static BR_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static ANY_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static BLANK_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// Pull every `[data-lyrics-container="true"]` div's inner HTML out of a
/// Genius song page. Hand-rolled depth counting rather than one greedy regex,
/// because the container isn't flat — it nests `<a>`/`<span>` annotation tags
/// and the occasional `<div>` — so a naive `.*?` match would truncate at the
/// first nested closing tag rather than the container's own.
fn extract_lyrics_containers(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(m) = LYRICS_OPEN_TAG.find_at(html, cursor) {
        let content_start = m.end();
        let mut depth = 1i32;
        let mut content_end = html.len();
        let mut next_cursor = html.len();
        for tag in ANY_DIV_TAG.find_iter(&html[content_start..]) {
            depth += if tag.as_str().starts_with("</") { -1 } else { 1 };
            if depth == 0 {
                content_end = content_start + tag.start();
                next_cursor = content_start + tag.end();
                break;
            }
        }
        out.push(html[content_start..content_end].to_string());
        cursor = next_cursor;
    }
    out
}

/// A pragmatic subset of HTML entities — enough for what lyric text actually
/// contains (apostrophes, ampersands in "Me & You"-style titles), not a full
/// HTML5 entity table.
fn decode_entities(s: &str) -> String {
    s.replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// One lyrics-container's inner HTML → plain text: `<br>` becomes a newline
/// (that's the only line-break signal Genius's markup gives), every other
/// tag (annotation links, formatting spans) is stripped but its text content
/// kept, then entities are decoded.
fn html_lyrics_to_text(fragment: &str) -> String {
    let with_breaks = BR_TAG.replace_all(fragment, "\n");
    let stripped = ANY_TAG.replace_all(&with_breaks, "");
    decode_entities(&stripped)
}

/// Trim each line and collapse runs of 3+ blank lines (stray `<br><br><br>`
/// in the source) down to one, without discarding intentional single blank
/// lines between verses.
fn clean_lines(text: &str) -> String {
    let trimmed: Vec<&str> = text.lines().map(|l| l.trim_end()).collect();
    let joined = trimmed.join("\n");
    BLANK_RUN.replace_all(&joined, "\n\n").trim().to_string()
}

/// Fetch plain (unsynced) lyrics from Genius. Used exactly like
/// `lyrics::fetch_plain` — force-aligned to a Whisper transcription's timing
/// by align.rs, never shown as-is.
pub fn fetch_plain(track: &Track) -> Option<String> {
    let hits = search_hits(track);
    let url = best_url(&hits, track)?;
    let html = fetch_page(&url)?;
    let containers = extract_lyrics_containers(&html);
    if containers.is_empty() {
        return None;
    }
    let text = containers.iter().map(|c| html_lyrics_to_text(c)).collect::<Vec<_>>().join("\n");
    let cleaned = clean_lines(&text);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: &str) -> Track {
        Track { title: title.into(), artist: artist.into(), duration_ms: 0 }
    }

    #[test]
    fn extracts_a_single_flat_container() {
        let html = r#"<html><body><div data-lyrics-container="true">Hello<br>World</div></body></html>"#;
        let out = extract_lyrics_containers(html);
        assert_eq!(out, vec!["Hello<br>World".to_string()]);
    }

    #[test]
    fn extracts_multiple_containers_in_order() {
        let html = r#"<div data-lyrics-container="true">First</div><p>gap</p><div data-lyrics-container="true">Second</div>"#;
        let out = extract_lyrics_containers(html);
        assert_eq!(out, vec!["First".to_string(), "Second".to_string()]);
    }

    #[test]
    fn does_not_truncate_at_a_nested_divs_closing_tag() {
        // A naive non-greedy regex would stop at the first </div>, which
        // belongs to the nested wrapper, not the container.
        let html = r#"<div data-lyrics-container="true">Line one<div class="inline">nested</div>Line two</div>"#;
        let out = extract_lyrics_containers(html);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("Line one"));
        assert!(out[0].contains("Line two"));
        assert!(out[0].contains("nested"));
    }

    #[test]
    fn returns_empty_when_no_container_is_present() {
        assert!(extract_lyrics_containers("<html><body>nothing here</body></html>").is_empty());
    }

    #[test]
    fn br_tags_become_newlines() {
        let out = html_lyrics_to_text("Line one<br>Line two<br/>Line three");
        assert_eq!(out, "Line one\nLine two\nLine three");
    }

    #[test]
    fn annotation_tags_are_stripped_but_their_text_kept() {
        let out = html_lyrics_to_text(r#"I said <a href="/annotation">something clever</a> today"#);
        assert_eq!(out, "I said something clever today");
    }

    #[test]
    fn common_entities_are_decoded() {
        let out = html_lyrics_to_text("Me &amp; You &#x27;forever&#x27; &lt;3");
        assert_eq!(out, "Me & You 'forever' <3");
    }

    #[test]
    fn clean_lines_collapses_long_blank_runs_but_keeps_single_blanks() {
        let out = clean_lines("verse one\n\nverse two\n\n\n\n\nverse three");
        assert_eq!(out, "verse one\n\nverse two\n\nverse three");
    }

    #[test]
    fn best_url_picks_the_closest_title_and_artist_match() {
        let hits = serde_json::json!([
            { "result": { "title": "A Completely Different Song", "primary_artist": { "name": "Nobody" }, "url": "https://genius.com/wrong" } },
            { "result": { "title": "Blinding Lights", "primary_artist": { "name": "The Weeknd" }, "url": "https://genius.com/right" } },
        ]);
        let url = best_url(hits.as_array().unwrap(), &track("Blinding Lights", "The Weeknd"));
        assert_eq!(url.as_deref(), Some("https://genius.com/right"));
    }

    #[test]
    fn best_url_returns_none_when_nothing_clears_the_floor() {
        let hits = serde_json::json!([
            { "result": { "title": "Totally Unrelated", "primary_artist": { "name": "Someone Else" }, "url": "https://genius.com/x" } },
        ]);
        let url = best_url(hits.as_array().unwrap(), &track("Blinding Lights", "The Weeknd"));
        assert!(url.is_none());
    }

    #[test]
    fn best_url_skips_hits_missing_a_result_or_url() {
        let hits = serde_json::json!([
            { "not_result": {} },
            { "result": { "title": "Blinding Lights", "primary_artist": { "name": "The Weeknd" } } },
        ]);
        assert!(best_url(hits.as_array().unwrap(), &track("Blinding Lights", "The Weeknd")).is_none());
    }

    // Live network test — run explicitly with `cargo test -- --ignored`.
    // Never run in CI: genius.com's markup or search endpoint can change
    // without warning, which is exactly the kind of breakage this exists to
    // catch, not something that should fail an unrelated PR's build.
    //
    // KNOWN FAILING as of 2026-08-17 — see the module doc's "CONFIRMED
    // BLOCKED" note. Left asserting real success (not inverted to expect a
    // 403) on purpose: this test's job is to say whether Genius actually
    // works today, and right now the honest answer is no.
    #[test]
    #[ignore]
    fn live_fetch_known_song() {
        let t = track("Blinding Lights", "The Weeknd");
        let hits = search_hits(&t);
        assert!(!hits.is_empty(), "expected Genius search to return hits");
        let url = best_url(&hits, &t);
        eprintln!("best url: {url:?}");
        assert!(url.is_some(), "expected a confident match for a well-known song");
        let plain = fetch_plain(&t);
        assert!(plain.is_some(), "expected fetch_plain to return lyric text");
        let text = plain.unwrap();
        assert!(text.len() > 100, "lyrics text looks too short: {} chars", text.len());
        eprintln!("first 200 chars: {}", &text.chars().take(200).collect::<String>());
    }
}
