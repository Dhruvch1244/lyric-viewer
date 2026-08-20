//! MusicBrainz recording lookup by MBID — the keyless half of identification.
//!
//! `acoustid.rs` normally returns the title and artists inline
//! (`meta=recordings`), so this is not on the happy path. It exists for the
//! case that path cannot cover: a fingerprint AcoustID matched confidently but
//! whose linked recording carried no usable metadata in the response. The MBID
//! is still a complete answer — MusicBrainz has the canonical credit, and
//! asking it directly needs no key.
//!
//! It is also the more accurate credit when it is used. AcoustID flattens
//! artists into a list of names; MusicBrainz's `artist-credit` carries the
//! **join phrases** the artists themselves chose — `"Seedhe Maut feat. Sez"`,
//! not `"Seedhe Maut, Sez"` — which matters here because that credit string
//! goes straight into a lyric search.
//!
//! `artwork.rs` already talks to MusicBrainz (a recording *search*, by title
//! and artist). This is the complementary direction: an exact fetch by id.
//! They are kept apart deliberately — the search half scores fuzzy candidates
//! and this half has nothing to score, since an MBID either resolves or does
//! not.
//!
//! **Rate limit.** MusicBrainz allows roughly one request per second per
//! client and enforces it by IP. This is only ever reached after an AcoustID
//! match on a track whose metadata looked wrong, so it fires at most once per
//! song and needs no throttle of its own — but a future caller that loops over
//! a library does, and that is why this note is here.

use serde_json::Value;

const RECORDING: &str = "https://musicbrainz.org/ws/2/recording";
/// MusicBrainz requires a contactable User-Agent and blocks generic ones.
const USER_AGENT: &str = "LyricOverlay/0.36 (https://github.com/Dhruvch1244/lyric-viewer)";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// A recording as MusicBrainz describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct Recording {
    pub title: String,
    /// The full credit, join phrases included.
    pub artist: String,
    pub duration_secs: Option<i64>,
}

/// Build the artist credit from MusicBrainz's `artist-credit` array.
///
/// Each entry is `{name, joinphrase}`, and the join phrase belongs *after* its
/// artist — `[{Seedhe Maut, " feat. "}, {Sez, ""}]` is `"Seedhe Maut feat.
/// Sez"`. Concatenating names with a separator of our own choosing would throw
/// away the one thing this endpoint knows better than AcoustID does.
fn credit(artist_credit: Option<&Value>) -> String {
    let Some(entries) = artist_credit.and_then(|a| a.as_array()) else {
        return String::new();
    };
    let mut out = String::new();
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(|n| n.as_str())
            // Some responses put the name only on the nested artist object.
            .or_else(|| entry.get("artist").and_then(|a| a.get("name")).and_then(|n| n.as_str()))
            .unwrap_or("");
        out.push_str(name);
        out.push_str(entry.get("joinphrase").and_then(|j| j.as_str()).unwrap_or(""));
    }
    out.trim().to_string()
}

/// Turn a recording response into a `Recording`, or nothing if it is unusable.
///
/// A recording with no title or no credit is not an error — MusicBrainz has
/// sparse entries — it simply cannot replace the metadata we already have, and
/// half an answer is worse than none here.
pub fn parse_recording(body: &Value) -> Option<Recording> {
    let title = body.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
    let artist = credit(body.get("artist-credit"));
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    Some(Recording {
        title,
        artist,
        // MusicBrainz reports length in milliseconds.
        duration_secs: body.get("length").and_then(|l| l.as_i64()).map(|ms| (ms + 500) / 1000),
    })
}

/// Whether a string is a well-formed MBID (8-4-4-4-12 hex).
///
/// Checked before building a URL rather than after a 404: the MBID comes from
/// a third-party response, and interpolating an unvalidated one into a path is
/// how a request ends up somewhere else entirely.
pub fn is_mbid(value: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Fetch one recording by MBID.
pub fn recording(mbid: &str) -> Result<Recording, String> {
    if !is_mbid(mbid) {
        return Err(format!("not a MusicBrainz id: {mbid}"));
    }
    let resp = ureq::get(&format!("{RECORDING}/{mbid}"))
        .timeout(TIMEOUT)
        .set("User-Agent", USER_AGENT)
        .query("fmt", "json")
        .query("inc", "artist-credits")
        .call()
        .map_err(|e| format!("musicbrainz request failed: {e}"))?;
    let body: Value = resp.into_json().map_err(|e| format!("musicbrainz returned unreadable JSON: {e}"))?;
    parse_recording(&body).ok_or_else(|| format!("recording {mbid} has no usable title/credit"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_normal_recording_parses() {
        let body = json!({
            "id": "5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2d",
            "title": "Nanchaku",
            "length": 217_400,
            "artist-credit": [{ "name": "Seedhe Maut", "joinphrase": "" }]
        });
        let rec = parse_recording(&body).unwrap();
        assert_eq!(rec.title, "Nanchaku");
        assert_eq!(rec.artist, "Seedhe Maut");
        assert_eq!(rec.duration_secs, Some(217));
    }

    #[test]
    fn join_phrases_are_honoured_instead_of_a_separator_of_our_own() {
        // The reason to prefer this endpoint over AcoustID's flat name list:
        // the credit string goes into a lyric search, and "feat." vs ", "
        // changes which candidates that search scores highly.
        let body = json!({
            "title": "Nanchaku",
            "artist-credit": [
                { "name": "Seedhe Maut", "joinphrase": " feat. " },
                { "name": "Sez on the Beat", "joinphrase": "" }
            ]
        });
        assert_eq!(parse_recording(&body).unwrap().artist, "Seedhe Maut feat. Sez on the Beat");
    }

    #[test]
    fn an_ampersand_credit_keeps_its_own_shape() {
        let body = json!({
            "title": "Song",
            "artist-credit": [
                { "name": "A", "joinphrase": " & " },
                { "name": "B", "joinphrase": "" }
            ]
        });
        assert_eq!(parse_recording(&body).unwrap().artist, "A & B");
    }

    #[test]
    fn a_credit_naming_the_artist_only_on_the_nested_object_still_reads() {
        // `inc=artist-credits` normally puts `name` on the credit entry, but
        // an entry that was never aliased carries it only on the artist.
        let body = json!({
            "title": "Song",
            "artist-credit": [{ "artist": { "name": "Nested Only" }, "joinphrase": "" }]
        });
        assert_eq!(parse_recording(&body).unwrap().artist, "Nested Only");
    }

    #[test]
    fn a_trailing_join_phrase_is_trimmed() {
        let body = json!({ "title": "Song", "artist-credit": [{ "name": "A", "joinphrase": " " }] });
        assert_eq!(parse_recording(&body).unwrap().artist, "A");
    }

    #[test]
    fn length_rounds_to_the_nearest_second() {
        let half_up = json!({ "title": "T", "length": 217_500, "artist-credit": [{ "name": "A" }] });
        let half_down = json!({ "title": "T", "length": 217_499, "artist-credit": [{ "name": "A" }] });
        assert_eq!(parse_recording(&half_up).unwrap().duration_secs, Some(218));
        assert_eq!(parse_recording(&half_down).unwrap().duration_secs, Some(217));
    }

    #[test]
    fn a_recording_with_no_length_still_parses() {
        let body = json!({ "title": "T", "artist-credit": [{ "name": "A" }] });
        assert_eq!(parse_recording(&body).unwrap().duration_secs, None);
    }

    #[test]
    fn half_an_answer_is_refused() {
        // Replacing a track's title while leaving a channel name as the artist
        // is worse than changing nothing: the pair has to be coherent.
        assert!(parse_recording(&json!({ "title": "T" })).is_none());
        assert!(parse_recording(&json!({ "artist-credit": [{ "name": "A" }] })).is_none());
        assert!(parse_recording(&json!({ "title": "  ", "artist-credit": [{ "name": "A" }] })).is_none());
        assert!(parse_recording(&json!({})).is_none());
    }

    #[test]
    fn a_real_mbid_is_accepted() {
        assert!(is_mbid("5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2d"));
        assert!(is_mbid("00000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn anything_that_could_redirect_the_request_is_rejected() {
        // The id comes from a third-party response and lands in a URL path.
        for bad in [
            "",
            "not-an-id",
            "5b0f1b4e6a4a4f4b9c9d7e2b3f9a1c2d",
            "5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2d/../../other",
            "5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2z",
            "5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2",
            "../../etc",
        ] {
            assert!(!is_mbid(bad), "accepted: {bad}");
        }
    }

    #[test]
    fn a_bad_mbid_never_reaches_the_network() {
        assert!(recording("not-an-id").unwrap_err().contains("not a MusicBrainz id"));
    }

    /// The live fetch, ignored by default — needs the network but no key.
    /// `cargo test -p lyric-overlay -- --ignored musicbrainz`
    #[test]
    #[ignore = "needs the network"]
    fn a_real_recording_resolves() {
        // "Bohemian Rhapsody" by Queen, a stable MusicBrainz recording id.
        let rec = recording("b1a9c0e9-d987-4042-ae91-78d6a3267d69").expect("lookup failed");
        println!("{rec:?}");
        assert!(!rec.title.is_empty());
        assert!(!rec.artist.is_empty());
    }
}
