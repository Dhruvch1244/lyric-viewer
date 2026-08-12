//! Cover-art + artist-credit lookup, keyless, across three sources.
//!
//! A Rust port of the automatic-pick half of `artwork.js`: iTunes Search →
//! Deezer → MusicBrainz/Cover Art Archive, first with art wins. The image is
//! downloaded here and handed to the renderer as a `data:` URI so the strict
//! page CSP (`img-src 'self' data:`) never has to allow a remote host. The
//! candidate-picker half (the "choose a different cover" grid) is a later phase.

use base64::Engine;
use serde_json::Value;

use crate::lyrics::{clean_artist, clean_title, token_similarity, version_tags, Track};

const ITUNES_SEARCH: &str = "https://itunes.apple.com/search";
const DEEZER_SEARCH: &str = "https://api.deezer.com/search";
const MB_SEARCH: &str = "https://musicbrainz.org/ws/2/recording";
const CAA_FRONT: &str = "https://coverartarchive.org/release";
const MB_UA: &str = "LyricOverlay/0.25 (https://github.com/Dhruvch1244/lyric-viewer)";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Below this a candidate is not trusted — showing no art beats another band's.
const MIN_MATCH_SCORE: f64 = 0.55;

/// One resolved cover: a data URI plus the source's own credit.
pub struct Art {
    pub data_uri: Option<String>,
    pub artist_name: Option<String>,
    pub track_name: Option<String>,
}

/// Download a remote image and encode it as a base64 data: URI.
fn download_image(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    let resp = ureq::get(url).timeout(TIMEOUT).call().ok()?;
    let mime = resp
        .header("content-type")
        .map(|c| c.split(';').next().unwrap_or("").trim().to_string())
        .filter(|c| c.starts_with("image/"))
        .unwrap_or_else(|| {
            if url.to_lowercase().ends_with(".png") {
                "image/png".into()
            } else {
                "image/jpeg".into()
            }
        });
    let mut bytes = Vec::new();
    use std::io::Read;
    resp.into_reader().take(20_000_000).read_to_end(&mut bytes).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Score one candidate against the track. 0..3-ish; higher is better.
fn score_candidate(
    cand_title: &str,
    cand_artist: &str,
    track: &Track,
    cleaned: &str,
    want_versions: &std::collections::HashSet<String>,
) -> f64 {
    let artist = clean_artist(&track.artist);
    let t = token_similarity(cleaned, cand_title);
    let a = if artist.is_empty() { 0.0 } else { token_similarity(&artist, cand_artist) };
    let mut score = t * 2.0 + a;

    let have = version_tags(cand_title);
    let mut mismatch = 0;
    for tag in want_versions {
        if !have.contains(tag) {
            mismatch += 1;
        }
    }
    for tag in &have {
        if !want_versions.contains(tag) {
            mismatch += 1;
        }
    }
    score - mismatch as f64 * 0.5
}

fn get_json(req: ureq::Request) -> Option<Value> {
    req.timeout(TIMEOUT).call().ok()?.into_json().ok()
}

/// iTunes Search: rich credits, cover upgradable to 1000px.
fn itunes_lookup(track: &Track, cleaned: &str, term: &str, want: &std::collections::HashSet<String>) -> Option<Art> {
    let json = get_json(ureq::get(ITUNES_SEARCH).query("term", term).query("entity", "song").query("limit", "8"))?;
    let results = json.get("results")?.as_array()?;
    let mut best: Option<&Value> = None;
    let mut best_score = f64::NEG_INFINITY;
    for r in results {
        let title = r.get("trackName").and_then(|v| v.as_str()).unwrap_or("");
        let artist = r.get("artistName").and_then(|v| v.as_str()).unwrap_or("");
        let s = score_candidate(title, artist, track, cleaned, want);
        if s > best_score {
            best_score = s;
            best = Some(r);
        }
    }
    let best = best?;
    if best_score < MIN_MATCH_SCORE {
        return None;
    }
    let raw = best.get("artworkUrl100").or_else(|| best.get("artworkUrl60")).and_then(|v| v.as_str()).unwrap_or("");
    let re = regex::Regex::new(r"/\d+x\d+bb\.(jpg|png)").ok()?;
    let art_url = re.replace(raw, "/1000x1000bb.$1").to_string();
    Some(Art {
        data_uri: download_image(&art_url),
        artist_name: best.get("artistName").and_then(|v| v.as_str()).map(String::from),
        track_name: best.get("trackName").and_then(|v| v.as_str()).map(String::from),
    })
}

/// Deezer: good coverage, `cover_xl` is a direct 1000px URL.
fn deezer_lookup(track: &Track, cleaned: &str, term: &str, want: &std::collections::HashSet<String>) -> Option<Art> {
    let json = get_json(ureq::get(DEEZER_SEARCH).query("q", term).query("limit", "8"))?;
    let results = json.get("data")?.as_array()?;
    let mut best: Option<&Value> = None;
    let mut best_score = f64::NEG_INFINITY;
    for r in results {
        let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let artist = r.get("artist").and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or("");
        let s = score_candidate(title, artist, track, cleaned, want);
        if s > best_score {
            best_score = s;
            best = Some(r);
        }
    }
    let best = best?;
    if best_score < MIN_MATCH_SCORE {
        return None;
    }
    let album = best.get("album");
    let art_url = album
        .and_then(|a| a.get("cover_xl").or_else(|| a.get("cover_big")).or_else(|| a.get("cover_medium")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Some(Art {
        data_uri: download_image(art_url),
        artist_name: best.get("artist").and_then(|a| a.get("name")).and_then(|v| v.as_str()).map(String::from),
        track_name: best.get("title").and_then(|v| v.as_str()).map(String::from),
    })
}

/// MusicBrainz recording search → Cover Art Archive front image (long-tail).
fn musicbrainz_lookup(track: &Track, cleaned: &str) -> Option<Art> {
    let mut query = format!("recording:\"{cleaned}\"");
    if !track.artist.is_empty() {
        query.push_str(&format!(" AND artist:\"{}\"", track.artist));
    }
    let json = get_json(
        ureq::get(MB_SEARCH).set("User-Agent", MB_UA).query("query", &query).query("fmt", "json").query("limit", "5"),
    )?;
    let recs = json.get("recordings")?.as_array()?;
    let best = recs.first()?;
    let credit = best.get("artist-credit").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .map(|a| {
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let join = a.get("joinphrase").and_then(|v| v.as_str()).unwrap_or("");
                format!("{name}{join}")
            })
            .collect::<String>()
            .trim()
            .to_string()
    });

    let mut art = None;
    if let Some(releases) = best.get("releases").and_then(|v| v.as_array()) {
        for rel in releases.iter().take(3) {
            if let Some(id) = rel.get("id").and_then(|v| v.as_str()) {
                art = download_image(&format!("{CAA_FRONT}/{id}/front-500"));
                if art.is_some() {
                    break;
                }
            }
        }
    }
    Some(Art {
        data_uri: art,
        artist_name: credit.filter(|c| !c.is_empty()),
        track_name: best.get("title").and_then(|v| v.as_str()).map(String::from),
    })
}

/// Look up cover art + credit, trying each source until one yields an image;
/// failing that, the first that at least carries a richer artist credit.
pub fn fetch_artwork(track: &Track) -> Option<Art> {
    let cleaned = clean_title(&track.title);
    let term = format!("{} {}", cleaned, track.artist);
    let term = term.trim();
    if term.is_empty() {
        return None;
    }
    let want = version_tags(&track.title);

    let sources: [Box<dyn Fn() -> Option<Art>>; 3] = [
        Box::new(|| itunes_lookup(track, &cleaned, term, &want)),
        Box::new(|| deezer_lookup(track, &cleaned, term, &want)),
        Box::new(|| musicbrainz_lookup(track, &cleaned)),
    ];

    let mut credit_only: Option<Art> = None;
    for run in sources {
        let result = run();
        if let Some(art) = result {
            if art.data_uri.is_some() {
                return Some(art);
            }
            if credit_only.is_none() && art.artist_name.is_some() {
                credit_only = Some(art);
            }
        }
    }
    credit_only
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore] // live network — run with `cargo test -- --ignored`
    fn live_fetch_known_cover() {
        let track = Track {
            title: "Blinding Lights".into(),
            artist: "The Weeknd".into(),
            duration_ms: 200_000,
        };
        let art = fetch_artwork(&track).expect("expected cover art");
        let uri = art.data_uri.expect("expected an image");
        assert!(uri.starts_with("data:image/"), "not a data image uri");
        assert!(uri.len() > 5_000, "image suspiciously small: {} bytes b64", uri.len());
        eprintln!("credit: {:?} / {:?}", art.artist_name, art.track_name);
        eprintln!("data uri length: {} chars", uri.len());
    }
}
