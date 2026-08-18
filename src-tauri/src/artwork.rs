//! Cover-art + artist-credit lookup, keyless, across three sources.
//!
//! A Rust port of the automatic-pick half of `artwork.js`: iTunes Search →
//! Deezer → MusicBrainz/Cover Art Archive, first with art wins. The image is
//! downloaded here and handed to the renderer as a `data:` URI so the strict
//! page CSP (`img-src 'self' data:`) never has to allow a remote host. The
//! candidate-picker half (the "choose a different cover" grid) is a later phase.

use base64::Engine;
use serde_json::{json, Value};

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
    let score = t * 2.0 + a;

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

// ------------------------------------------------------------- candidates
//
// The same three sources also feed a "choose a different cover" grid. Two
// differences from the automatic pick: MIN_MATCH_SCORE is NOT applied (a person
// scanning a grid can pick the near-miss the threshold would reject), and each
// candidate carries a small thumbnail — the full image is fetched only when one
// is chosen.

const MAX_CANDIDATES: usize = 9;
const THUMB_SIZE: u32 = 250;

struct RawCand {
    source: String,
    title: String,
    artist: String,
    score: f64,
    full_url: String,
    thumb_url: String,
}

/// One candidate as sent to the renderer (thumbnail inlined as a data URI).
#[derive(serde::Serialize)]
struct Candidate {
    source: String,
    title: String,
    artist: String,
    score: f64,
    #[serde(rename = "fullUrl")]
    full_url: String,
    thumb: String,
}

fn itunes_candidates(track: &Track, cleaned: &str, term: &str, want: &std::collections::HashSet<String>) -> Vec<RawCand> {
    let Some(json) = get_json(ureq::get(ITUNES_SEARCH).query("term", term).query("entity", "song").query("limit", "8")) else {
        return Vec::new();
    };
    let re = regex::Regex::new(r"/\d+x\d+bb\.(jpg|png)").unwrap();
    json.get("results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let raw = r.get("artworkUrl100").or_else(|| r.get("artworkUrl60")).and_then(|v| v.as_str())?;
                    let title = r.get("trackName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let artist = r.get("artistName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    Some(RawCand {
                        score: score_candidate(&title, &artist, track, cleaned, want),
                        source: "iTunes".into(),
                        full_url: re.replace(raw, "/1000x1000bb.$1").to_string(),
                        thumb_url: re.replace(raw, &format!("/{THUMB_SIZE}x{THUMB_SIZE}bb.$1")).to_string(),
                        title,
                        artist,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn deezer_candidates(track: &Track, cleaned: &str, term: &str, want: &std::collections::HashSet<String>) -> Vec<RawCand> {
    let Some(json) = get_json(ureq::get(DEEZER_SEARCH).query("q", term).query("limit", "8")) else {
        return Vec::new();
    };
    json.get("data")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let album = r.get("album")?;
                    let full = album.get("cover_xl").or_else(|| album.get("cover_big")).or_else(|| album.get("cover_medium")).and_then(|v| v.as_str())?;
                    let thumb = album.get("cover_medium").or_else(|| album.get("cover_big")).or_else(|| album.get("cover_xl")).and_then(|v| v.as_str()).unwrap_or(full);
                    let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let artist = r.get("artist").and_then(|a| a.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    Some(RawCand {
                        score: score_candidate(&title, &artist, track, cleaned, want),
                        source: "Deezer".into(),
                        full_url: full.to_string(),
                        thumb_url: thumb.to_string(),
                        title,
                        artist,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn musicbrainz_candidates(track: &Track, cleaned: &str, want: &std::collections::HashSet<String>) -> Vec<RawCand> {
    let mut query = format!("recording:\"{cleaned}\"");
    if !track.artist.is_empty() {
        query.push_str(&format!(" AND artist:\"{}\"", track.artist));
    }
    let Some(json) = get_json(ureq::get(MB_SEARCH).set("User-Agent", MB_UA).query("query", &query).query("fmt", "json").query("limit", "5")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(recs) = json.get("recordings").and_then(|v| v.as_array()) {
        for rec in recs {
            let credit = rec.get("artist-credit").and_then(|v| v.as_array()).map(|arr| {
                arr.iter().map(|a| format!("{}{}", a.get("name").and_then(|v| v.as_str()).unwrap_or(""), a.get("joinphrase").and_then(|v| v.as_str()).unwrap_or(""))).collect::<String>().trim().to_string()
            }).unwrap_or_default();
            let title = rec.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let Some(release) = rec.get("releases").and_then(|v| v.as_array()).and_then(|a| a.iter().find(|r| r.get("id").is_some())) else { continue };
            let Some(id) = release.get("id").and_then(|v| v.as_str()) else { continue };
            out.push(RawCand {
                score: score_candidate(&title, &credit, track, cleaned, want),
                source: "Cover Art Archive".into(),
                full_url: format!("{CAA_FRONT}/{id}/front-500"),
                thumb_url: format!("{CAA_FRONT}/{id}/front-250"),
                title,
                artist: credit,
            });
        }
    }
    out
}

/// Drop candidates pointing at the same image, keeping the best-scoring one.
fn dedupe(list: Vec<RawCand>) -> Vec<RawCand> {
    let mut seen: std::collections::HashMap<String, RawCand> = std::collections::HashMap::new();
    for c in list {
        let key = format!("{}|{}|{}", c.source.to_lowercase(), c.title.trim().to_lowercase(), c.artist.trim().to_lowercase());
        match seen.get(&key) {
            Some(prev) if prev.score >= c.score => {}
            _ => {
                seen.insert(key, c);
            }
        }
    }
    seen.into_values().collect()
}

/// Gather cover-art options for a track, best first, with thumbnails inlined.
pub fn fetch_candidates(track: &Track) -> Value {
    let cleaned = clean_title(&track.title);
    let term = format!("{} {}", cleaned, track.artist);
    let term = term.trim();
    if term.is_empty() {
        return json!([]);
    }
    let want = version_tags(&track.title);

    let mut all = itunes_candidates(track, &cleaned, term, &want);
    all.extend(deezer_candidates(track, &cleaned, term, &want));
    all.extend(musicbrainz_candidates(track, &cleaned, &want));

    let mut ranked = dedupe(all);
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(MAX_CANDIDATES);

    let out: Vec<Candidate> = ranked
        .into_iter()
        .filter_map(|c| {
            download_image(&c.thumb_url).map(|thumb| Candidate {
                source: c.source,
                title: c.title,
                artist: c.artist,
                score: c.score,
                full_url: c.full_url,
                thumb,
            })
        })
        .collect();
    serde_json::to_value(out).unwrap_or(json!([]))
}

/// Download one chosen full-size cover as a data URI.
pub fn fetch_one(url: &str) -> Option<String> {
    download_image(url)
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
        eprintln!("credit: {:?}", art.artist_name);
        eprintln!("data uri length: {} chars", uri.len());
    }
}
