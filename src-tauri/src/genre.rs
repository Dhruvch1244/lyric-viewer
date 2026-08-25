//! Genre classification for a track.
//!
//! MusicBrainz's recording search first — keyless, same request shape
//! `artwork.rs::musicbrainz_lookup` already uses, extended to ask for
//! `genres`/`tags` instead of a release image. MusicBrainz genres are a
//! curated, controlled vocabulary; plain tags can be anything ("2020s",
//! "favourite"), so genres are preferred and tags are only consulted when a
//! recording carries no genre entries at all. An LLM classification
//! (`llm::convert`, the same structured-output path `mood.rs` uses) is the
//! fallback for whatever MusicBrainz has never heard of.
//!
//! The result is cached by the caller into the same per-track lyrics-cache
//! file `mood`/`attribution` already use (see `GenreJob` in
//! `commands/lyrics_cmds.rs`), so this runs at most once per song, not once
//! per play.

use serde_json::{json, Value};

use crate::llm;

const MB_SEARCH: &str = "https://musicbrainz.org/ws/2/recording";
const MB_UA: &str = "LyricOverlay/0.48 (https://github.com/Dhruvch1244/lyric-viewer)";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn get_json(req: ureq::Request) -> Option<Value> {
    req.timeout(TIMEOUT).call().ok()?.into_json().ok()
}

/// The highest-`count` entry's `name` from a MusicBrainz genres/tags array —
/// mirrors how `artwork.rs` scores candidates, just over a name/count pair
/// instead of an image.
fn top_named(field: Option<&Value>) -> Option<String> {
    let arr = field?.as_array()?;
    arr.iter()
        .filter_map(|g| {
            let name = g.get("name")?.as_str()?.to_string();
            let count = g.get("count").and_then(|c| c.as_i64()).unwrap_or(0);
            Some((name, count))
        })
        .max_by_key(|(_, count)| *count)
        .map(|(name, _)| name)
}

/// MusicBrainz recording search, `inc=genres+tags`. Checks up to 3 candidate
/// recordings (a search can return a live version, a remaster, etc. before
/// the one that actually carries genre data) rather than only the top hit.
fn musicbrainz_genre(title: &str, artist: &str) -> Option<String> {
    let mut query = format!("recording:\"{title}\"");
    if !artist.is_empty() {
        query.push_str(&format!(" AND artist:\"{artist}\""));
    }
    let json = get_json(
        ureq::get(MB_SEARCH)
            .set("User-Agent", MB_UA)
            .query("query", &query)
            .query("fmt", "json")
            .query("inc", "genres+tags")
            .query("limit", "3"),
    )?;
    let recs = json.get("recordings")?.as_array()?;
    for rec in recs {
        if let Some(g) = top_named(rec.get("genres")) {
            return Some(g);
        }
    }
    for rec in recs {
        if let Some(g) = top_named(rec.get("tags")) {
            return Some(g);
        }
    }
    None
}

const SYSTEM_PROMPT: &str = "You are a music cataloguer. Given a song's title, \
artist, and (if given) a short lyrics sample, name ONE genre that best \
describes it — a short, common label a listener would recognise (\"Hip-Hop\", \
\"Pop\", \"Rock\", \"Electronic\", \"R&B\", \"Indie\", \"Metal\", \"Country\", \
\"Jazz\", \"Classical\", \"Folk\", \"Latin\", \"K-Pop\", \"Bollywood\", \
\"Devotional\", \"Lo-fi\", \"Ambient\" are common examples, but use whatever \
well-known genre actually fits best. One label only, no slashes or lists.";

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": { "genre": { "type": "string" } },
        "required": ["genre"],
        "additionalProperties": false,
    })
}

fn llm_genre(title: &str, artist: &str, cue_texts: &[String]) -> Option<String> {
    if !llm::is_available() {
        return None;
    }
    let sample: String = cue_texts.iter().filter(|t| !t.trim().is_empty()).take(20).cloned().collect::<Vec<_>>().join("\n");
    let user = format!("Title: {title}\nArtist: {artist}\nLyrics sample:\n{sample}");
    let result = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
    result.get("genre").and_then(|g| g.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Resolve a track's genre: MusicBrainz first, an LLM classification only
/// when MusicBrainz has nothing to say about this recording at all.
pub fn analyze(title: &str, artist: &str, cue_texts: &[String]) -> Option<String> {
    musicbrainz_genre(title, artist).or_else(|| llm_genre(title, artist, cue_texts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_named_picks_the_highest_count() {
        let field = json!([
            { "name": "pop", "count": 2 },
            { "name": "hip hop", "count": 9 },
            { "name": "rap", "count": 5 },
        ]);
        assert_eq!(top_named(Some(&field)), Some("hip hop".to_string()));
    }

    #[test]
    fn top_named_handles_missing_or_empty() {
        assert_eq!(top_named(None), None);
        assert_eq!(top_named(Some(&json!([]))), None);
        assert_eq!(top_named(Some(&json!("not an array"))), None);
    }

    #[test]
    fn top_named_ignores_entries_with_no_name() {
        let field = json!([{ "count": 99 }, { "name": "folk", "count": 1 }]);
        assert_eq!(top_named(Some(&field)), Some("folk".to_string()));
    }
}
