//! AcoustID lookup: a fingerprint in, a canonical recording out.
//!
//! The second half of JOB-ENGINE §5.1. `fingerprint.rs` turns the audio into a
//! Chromaprint string; this asks AcoustID which MusicBrainz recording that is,
//! and hands back an artist and title that came from the *sound* rather than
//! from whatever a browser tab was called.
//!
//! **Keyed, and that is the whole reason this module is separable.** AcoustID
//! needs a free application key, supplied as `ACOUSTID_API_KEY` through the
//! same 🔑 mechanism every other provider uses (`commands::prefs::set_api_key`
//! sets the env var and persists it). Everything here except `lookup` — the
//! trigger, the query, the parsing, the choice between candidates — is offline
//! and tested offline. Without a key `available()` is false and nothing else
//! in this module ever runs, so the app behaves exactly as it does today.
//!
//! **Precision over coverage, deliberately.** A wrong identification is worse
//! than none: it replaces the track's identity everywhere downstream — lyric
//! lookup, artwork, the per-song cache key, the play history — with another
//! band's, and none of those can tell they were lied to. `MIN_SCORE` and the
//! duration check below are both set to refuse rather than guess.

use serde_json::Value;

use crate::fingerprint::Fingerprint;
use crate::lyrics::Track;

const LOOKUP: &str = "https://api.acoustid.org/v2/lookup";
const USER_AGENT: &str = "lyric-overlay/0.37.0 (https://github.com/Dhruvch1244/lyric-viewer)";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// The environment variable the 🔑 panel writes an AcoustID key into.
pub const KEY_NAME: &str = "ACOUSTID_API_KEY";

/// Minimum AcoustID score to accept. A genuine match on clean audio scores
/// well above 0.9; the band below this is where a noisy capture of one song
/// brushes against a different recording. Set high because the failure is
/// silent — see the module doc.
const MIN_SCORE: f64 = 0.8;

/// How far a candidate recording's own duration may sit from the track's
/// before it is rejected. Catches the common near-miss: the same song, but the
/// radio edit rather than the album cut, whose lyrics do not line up.
const MAX_DURATION_DRIFT_SECS: i64 = 12;

/// One recording AcoustID offered, flattened out of its nested response.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// AcoustID's confidence, 0..1.
    pub score: f64,
    /// MusicBrainz recording MBID.
    pub mbid: String,
    /// Recording title, absent when the lookup asked for ids only or the
    /// recording has no metadata attached yet.
    pub title: Option<String>,
    /// Credited artists, in order.
    pub artists: Vec<String>,
    /// The recording's own length, when MusicBrainz knows it.
    pub duration_secs: Option<i64>,
}

/// What a successful identification produces: metadata to use instead of the
/// track's own.
#[derive(Debug, Clone, PartialEq)]
pub struct Identified {
    pub artist: String,
    pub title: String,
    pub mbid: String,
    pub score: f64,
}

/// The configured key, if the user has supplied one.
pub fn api_key() -> Option<String> {
    std::env::var(KEY_NAME).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// Whether identification can run at all.
pub fn available() -> bool {
    api_key().is_some()
}

/// Whether a track's metadata is bad enough to be worth a fingerprint.
///
/// This gate is the difference between a feature and a tax. Identification
/// costs a recording, a fingerprint pass and a network round trip, and the
/// overwhelming majority of plays — a local file, a desktop music player, a
/// browser tab that reports properly — already know what they are. Only
/// browser-shaped metadata gets the treatment:
///
/// - **No artist at all.** Nothing downstream can score a candidate without
///   one, so a lookup is guessing already.
/// - **Platform noise in the title** — "official video", "lyrics", "4K". A
///   human wrote that for a thumbnail, not a music library.
/// - **A channel-shaped artist** — `VEVO`, `- Topic`, `Records`.
/// - **The artist repeated at the front of the title** — `"Seedhe Maut -
///   Nanchaku"` credited to `Seedhe Maut`. A media player never duplicates the
///   artist into the title; a video upload almost always does.
/// - **A pipe in the title.** `"NANCHAKU | Official Music Video"` is a video
///   headline; no release title uses one.
///
/// A bare `" - "` is deliberately *not* a signal on its own. Spotify's own
/// catalogue is full of `"Song 2 - Remastered 2012"` and `"Bohemian Rhapsody -
/// 2011 Mix"`, and firing on those would spend a request on metadata that was
/// already correct.
///
/// Note what is also not here: "the lyric lookup failed". That is a stronger
/// signal than any of these and the caller is free to require it as well —
/// this function answers "is the metadata suspect", not "should we spend the
/// request right now".
pub fn worth_identifying(track: &Track) -> bool {
    let artist = track.artist.trim();
    if artist.is_empty() {
        return true;
    }
    let lower_artist = artist.to_lowercase();
    if lower_artist.ends_with("vevo") || lower_artist.contains("- topic") || lower_artist.ends_with("records") {
        return true;
    }

    let title = track.title.trim();
    if title.is_empty() {
        return false; // nothing to fingerprint against and nothing to fix
    }
    let lower_title = title.to_lowercase();
    if NOISE_WORDS.iter().any(|w| lower_title.contains(w)) {
        return true;
    }
    if lower_title.starts_with(&format!("{lower_artist} - ")) {
        return true;
    }
    title.contains('|')
}

/// Substrings that only appear in titles written for a video platform.
/// Deliberately narrower than `lyrics::clean_title`'s patterns: that function
/// strips noise so a search can succeed anyway, while this one decides whether
/// to spend a request, so it should fire on the unambiguous cases only.
const NOISE_WORDS: &[&str] = &[
    "official video",
    "official music video",
    "official audio",
    "lyric video",
    "lyrics)",
    "lyrics]",
    "visualizer",
    "(4k",
    "[4k",
    "full song",
    "out now",
];

/// Build the form-encoded body of a lookup request.
///
/// POST, not GET: a two-minute fingerprint is several kilobytes of base64 and
/// AcoustID's own guidance is to POST anything long. `duration` is the *whole
/// track's* length in seconds — AcoustID matches on it as well as on the
/// fingerprint, so passing the length of the analysed excerpt instead would
/// quietly lower every score.
fn build_body(fp: &Fingerprint, duration_secs: u32, key: &str) -> String {
    format!(
        "client={}&duration={}&fingerprint={}&meta=recordings&format=json",
        urlencode(key),
        duration_secs,
        urlencode(&fp.encoded)
    )
}

/// Percent-encode a value for a form body. Chromaprint's URL-safe base64 needs
/// no escaping and neither does a key, but building the body by concatenation
/// without this is how a future parameter introduces an injection.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Flatten a lookup response into candidates.
///
/// Tolerant on purpose. AcoustID returns results with no recordings attached
/// (a fingerprint it has seen but nobody has linked to MusicBrainz), and
/// recordings with no title or no artists. None of those is an error — they
/// are simply not usable, and dropping them here keeps every caller from
/// re-deciding that.
pub fn parse_response(body: &Value) -> Result<Vec<Candidate>, String> {
    match body.get("status").and_then(|s| s.as_str()) {
        Some("ok") => {}
        Some("error") => {
            let message = body
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(message.to_string());
        }
        _ => return Err("response has no status".into()),
    }

    let mut out = Vec::new();
    for result in body.get("results").and_then(|r| r.as_array()).into_iter().flatten() {
        let score = result.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);
        for rec in result.get("recordings").and_then(|r| r.as_array()).into_iter().flatten() {
            let Some(mbid) = rec.get("id").and_then(|i| i.as_str()) else { continue };
            let artists: Vec<String> = rec
                .get("artists")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            out.push(Candidate {
                score,
                mbid: mbid.to_string(),
                title: rec.get("title").and_then(|t| t.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                artists,
                duration_secs: rec.get("duration").and_then(|d| d.as_i64()),
            });
        }
    }
    Ok(out)
}

/// Pick the one candidate worth believing, or none.
///
/// `track_duration_secs` is 0 when unknown (SMTC does not always report a
/// length), in which case the duration check is skipped rather than failing
/// everything — an unknown length is not evidence of a mismatch.
///
/// Deliberately does **not** require inline metadata. A confident match whose
/// recording carries no title in the response is still a complete answer — the
/// MBID resolves against MusicBrainz — so throwing it away here would discard
/// the identification over a detail `resolve` can fetch.
pub fn best(candidates: &[Candidate], track_duration_secs: i64) -> Option<&Candidate> {
    candidates
        .iter()
        .filter(|c| c.score >= MIN_SCORE)
        .filter(|c| match (c.duration_secs, track_duration_secs) {
            (Some(d), t) if t > 0 => (d - t).abs() <= MAX_DURATION_DRIFT_SECS,
            _ => true,
        })
        // Highest score wins. Ties go to the candidate that already carries
        // its metadata (one fewer round trip), then to the closer duration, so
        // the album cut beats a compilation entry of the same recording.
        .max_by(|a, b| {
            a.score
                .total_cmp(&b.score)
                .then_with(|| has_metadata(a).cmp(&has_metadata(b)))
                .then_with(|| duration_drift(b, track_duration_secs).cmp(&duration_drift(a, track_duration_secs)))
        })
}

/// Whether a candidate can be used without a MusicBrainz round trip.
fn has_metadata(c: &Candidate) -> bool {
    c.title.is_some() && !c.artists.is_empty()
}

/// Turn a chosen candidate into usable metadata.
///
/// Uses what AcoustID sent when it sent enough, and asks MusicBrainz directly
/// when it did not — a recording linked to the fingerprint but returned bare
/// is common, and its MBID is all that is needed to get the canonical credit.
/// MusicBrainz is in fact the *better* source when it is reached: it carries
/// the join phrases ("A feat. B") that AcoustID's flat name list loses.
pub fn resolve(c: &Candidate) -> Option<Identified> {
    if has_metadata(c) {
        return Some(Identified {
            artist: c.artists.join(", "),
            title: c.title.clone().unwrap_or_default(),
            mbid: c.mbid.clone(),
            score: c.score,
        });
    }
    match crate::musicbrainz::recording(&c.mbid) {
        Ok(rec) => Some(Identified { artist: rec.artist, title: rec.title, mbid: c.mbid.clone(), score: c.score }),
        Err(e) => {
            log::warn!("acoustid matched {} but musicbrainz could not describe it: {e}", c.mbid);
            None
        }
    }
}

/// How far a candidate's length sits from the track's; `i64::MAX` when either
/// is unknown, so an unknown duration never wins a tie-break on merit it does
/// not have.
fn duration_drift(c: &Candidate, track_duration_secs: i64) -> i64 {
    match (c.duration_secs, track_duration_secs) {
        (Some(d), t) if t > 0 => (d - t).abs(),
        _ => i64::MAX,
    }
}

/// Ask AcoustID what this fingerprint is.
///
/// The one function here that needs the network and a key; everything it
/// depends on is unit-tested without either. Returns the raw candidate list so
/// a caller can log what was on offer before `best` throws most of it away.
pub fn lookup(fp: &Fingerprint, track_duration_secs: u32) -> Result<Vec<Candidate>, String> {
    let key = api_key().ok_or("no AcoustID key configured")?;
    let resp = ureq::post(LOOKUP)
        .timeout(TIMEOUT)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&build_body(fp, track_duration_secs, &key))
        .map_err(|e| format!("acoustid request failed: {e}"))?;
    let body: Value = resp.into_json().map_err(|e| format!("acoustid returned unreadable JSON: {e}"))?;
    parse_response(&body)
}

/// Fingerprint → identity, in one call. `Ok(None)` means the lookup worked and
/// nothing was confident enough, which is a normal outcome, not a failure.
pub fn identify(fp: &Fingerprint, track_duration_secs: u32) -> Result<Option<Identified>, String> {
    let candidates = lookup(fp, track_duration_secs)?;
    log::info!("acoustid returned {} candidate(s)", candidates.len());
    Ok(best(&candidates, track_duration_secs as i64).and_then(resolve))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track(artist: &str, title: &str) -> Track {
        Track { artist: artist.into(), title: title.into(), duration_ms: 0 }
    }

    /* ------------------------------------------------- when to even ask --- */

    #[test]
    fn a_clean_desktop_player_track_is_left_alone() {
        // The common case by a wide margin. Firing here would cost a
        // fingerprint and a request on every song for no gain.
        assert!(!worth_identifying(&track("Seedhe Maut", "Nanchaku")));
        assert!(!worth_identifying(&track("Radiohead", "Weird Fishes / Arpeggi")));
        assert!(!worth_identifying(&track("Tyler, The Creator", "See You Again")));
    }

    #[test]
    fn a_missing_artist_is_worth_identifying() {
        assert!(worth_identifying(&track("", "Nanchaku")));
        assert!(worth_identifying(&track("   ", "Nanchaku")));
    }

    #[test]
    fn browser_title_shapes_are_worth_identifying() {
        for title in [
            "Seedhe Maut - Nanchaku (Official Video)",
            "NANCHAKU | Official Music Video",
            "Nanchaku [4K] Lyrics",
            "Nanchaku (Official Audio)",
            "Nanchaku (Lyrics)",
            "Nanchaku - Full Song",
        ] {
            assert!(worth_identifying(&track("Some Channel", title)), "missed: {title}");
        }
    }

    #[test]
    fn channel_shaped_artists_are_worth_identifying() {
        for artist in ["ArtistVEVO", "Seedhe Maut - Topic", "Def Jam Records"] {
            assert!(worth_identifying(&track(artist, "Nanchaku")), "missed: {artist}");
        }
    }

    #[test]
    fn the_artist_repeated_into_the_title_is_worth_identifying() {
        // The upload shape where the channel IS the artist, so none of the
        // channel tests above fire. A media player never writes the artist
        // into the title as well.
        assert!(worth_identifying(&track("Seedhe Maut", "Seedhe Maut - Nanchaku")));
        assert!(worth_identifying(&track("seedhe maut", "SEEDHE MAUT - NANCHAKU")));
    }

    #[test]
    fn a_dash_suffix_on_a_legitimate_title_is_not_a_signal() {
        // Spotify's catalogue is full of these. Treating " - " alone as
        // browser-shaped would spend a request on most of a normal library.
        assert!(!worth_identifying(&track("Blur", "Song 2 - Remastered 2012")));
        assert!(!worth_identifying(&track("Queen", "Bohemian Rhapsody - 2011 Mix")));
        assert!(!worth_identifying(&track("Wu-Tang Clan", "C.R.E.A.M.")));
        assert!(!worth_identifying(&track("Jay-Z", "99 Problems")));
    }

    #[test]
    fn an_empty_title_with_a_normal_artist_is_not_worth_a_request() {
        // Nothing to fingerprint against and nothing the answer could fix.
        assert!(!worth_identifying(&track("Seedhe Maut", "")));
    }

    /* ---------------------------------------------------- request shape --- */

    #[test]
    fn the_body_carries_the_tracks_duration_not_the_excerpts() {
        // The mistake this pins: AcoustID scores on duration too, so sending
        // the 30s we analysed instead of the song's 217s silently ruins every
        // match, with a perfectly successful HTTP 200 to show for it.
        let fp = Fingerprint { encoded: "AQAA".into(), analysed_secs: 30 };
        let body = build_body(&fp, 217, "abc123");
        assert!(body.contains("&duration=217&"), "{body}");
        assert!(!body.contains("30"), "the analysed length leaked into the request: {body}");
    }

    #[test]
    fn the_body_asks_for_recordings_and_json() {
        let fp = Fingerprint { encoded: "AQAA".into(), analysed_secs: 30 };
        let body = build_body(&fp, 217, "abc123");
        assert!(body.contains("meta=recordings"), "{body}");
        assert!(body.contains("format=json"), "{body}");
        assert!(body.contains("client=abc123"), "{body}");
        assert!(body.contains("fingerprint=AQAA"), "{body}");
    }

    #[test]
    fn url_safe_fingerprints_survive_encoding_unchanged() {
        // Chromaprint's alphabet is exactly the unreserved set plus - and _,
        // so a correct encoder is a no-op here. If this ever starts escaping
        // things, the encoder was swapped for a standard-alphabet one and the
        // fingerprint is now wrong on the wire as well as longer.
        assert_eq!(urlencode("AQAA-_azAZ09.~"), "AQAA-_azAZ09.~");
    }

    #[test]
    fn a_key_with_awkward_characters_is_escaped() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
    }

    /* -------------------------------------------------------- responses --- */

    fn ok_response() -> Value {
        json!({
            "status": "ok",
            "results": [{
                "score": 0.97,
                "id": "9ff43b6a-4f16-427c-93c2-92307ca505e0",
                "recordings": [{
                    "id": "5b0f1b4e-6a4a-4f4b-9c9d-7e2b3f9a1c2d",
                    "title": "Nanchaku",
                    "duration": 217,
                    "artists": [{ "id": "a1", "name": "Seedhe Maut" }, { "id": "a2", "name": "Sez on the Beat" }]
                }]
            }]
        })
    }

    #[test]
    fn a_normal_response_flattens_to_one_candidate() {
        let cands = parse_response(&ok_response()).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].score, 0.97);
        assert_eq!(cands[0].title.as_deref(), Some("Nanchaku"));
        assert_eq!(cands[0].artists, vec!["Seedhe Maut", "Sez on the Beat"]);
        assert_eq!(cands[0].duration_secs, Some(217));
    }

    #[test]
    fn every_recording_under_one_result_inherits_that_results_score() {
        // AcoustID scores the fingerprint match, not the recording — one
        // fingerprint can be linked to several recordings (a single and an
        // album cut of the same master) and all of them are equally confident.
        let body = json!({
            "status": "ok",
            "results": [{ "score": 0.9, "id": "x", "recordings": [
                { "id": "r1", "title": "A", "artists": [{ "name": "N" }] },
                { "id": "r2", "title": "B", "artists": [{ "name": "N" }] }
            ]}]
        });
        let cands = parse_response(&body).unwrap();
        assert_eq!(cands.len(), 2);
        assert!(cands.iter().all(|c| c.score == 0.9));
    }

    #[test]
    fn an_error_response_becomes_an_error_with_its_message() {
        let body = json!({ "status": "error", "error": { "code": 4, "message": "invalid API key" } });
        assert_eq!(parse_response(&body).unwrap_err(), "invalid API key");
    }

    #[test]
    fn a_response_with_no_status_is_an_error_rather_than_an_empty_list() {
        // An empty list means "nothing matched", which a caller acts on. A
        // malformed response must not be able to say that.
        assert!(parse_response(&json!({ "results": [] })).is_err());
        assert!(parse_response(&json!({})).is_err());
    }

    #[test]
    fn a_match_with_no_linked_recording_yields_nothing_but_is_not_an_error() {
        // Real and common: AcoustID knows the fingerprint but nobody has
        // linked it to MusicBrainz, so there is no metadata to hand back.
        let body = json!({ "status": "ok", "results": [{ "score": 0.99, "id": "x" }] });
        assert!(parse_response(&body).unwrap().is_empty());
    }

    #[test]
    fn recordings_without_an_id_are_skipped() {
        let body = json!({
            "status": "ok",
            "results": [{ "score": 0.9, "recordings": [{ "title": "A", "artists": [{ "name": "N" }] }] }]
        });
        assert!(parse_response(&body).unwrap().is_empty());
    }

    #[test]
    fn blank_artist_names_are_dropped_rather_than_joined_as_empty_strings() {
        let body = json!({
            "status": "ok",
            "results": [{ "score": 0.9, "recordings": [{ "id": "r", "title": "A",
                "artists": [{ "name": "  " }, { "name": "Real" }, { "id": "no-name" }] }] }]
        });
        assert_eq!(parse_response(&body).unwrap()[0].artists, vec!["Real"]);
    }

    /* ------------------------------------------------------- the choice --- */

    fn cand(score: f64, title: &str, artist: &str, duration: Option<i64>) -> Candidate {
        Candidate {
            score,
            mbid: format!("mbid-{title}"),
            title: Some(title.into()),
            artists: vec![artist.into()],
            duration_secs: duration,
        }
    }

    #[test]
    fn the_best_candidate_is_the_highest_scoring_one() {
        let cands = [cand(0.85, "A", "X", Some(200)), cand(0.95, "B", "Y", Some(200))];
        let got = resolve(best(&cands, 200).unwrap()).unwrap();
        assert_eq!(got.title, "B");
        assert_eq!(got.artist, "Y");
        assert_eq!(got.score, 0.95);
    }

    #[test]
    fn a_low_scoring_match_is_refused_rather_than_used() {
        // The whole point of MIN_SCORE: a wrong identification silently
        // rewrites the track's identity everywhere downstream.
        assert!(best(&[cand(0.79, "A", "X", Some(200))], 200).is_none());
        assert!(best(&[cand(0.80, "A", "X", Some(200))], 200).is_some());
    }

    #[test]
    fn a_candidate_whose_length_is_wrong_is_refused() {
        // Same song, different cut — the radio edit's lyrics do not line up
        // with the album version's timing.
        assert!(best(&[cand(0.99, "A", "X", Some(150))], 217).is_none());
        assert!(best(&[cand(0.99, "A", "X", Some(217 - MAX_DURATION_DRIFT_SECS))], 217).is_some());
    }

    #[test]
    fn an_unknown_track_length_skips_the_duration_check_instead_of_failing_everything() {
        // SMTC does not always report a length; that is not evidence of a
        // mismatch, so it must not reject every candidate.
        assert!(best(&[cand(0.99, "A", "X", Some(150))], 0).is_some());
    }

    #[test]
    fn a_bare_match_is_still_chosen_so_musicbrainz_can_describe_it() {
        // AcoustID often knows the fingerprint but returns the recording with
        // no title attached. Dropping it here would throw away a confident
        // identification over something `resolve` can go and fetch.
        let bare = Candidate { title: None, artists: vec![], ..cand(0.99, "A", "X", Some(200)) };
        assert!(best(&[bare], 200).is_some());
    }

    #[test]
    fn equal_scores_prefer_the_candidate_that_needs_no_second_request() {
        let bare = Candidate { title: None, artists: vec![], ..cand(0.9, "bare", "X", Some(217)) };
        let full = cand(0.9, "full", "X", Some(217));
        assert_eq!(best(&[bare, full], 217).unwrap().title.as_deref(), Some("full"));
    }

    #[test]
    fn equal_scores_break_toward_the_closer_duration() {
        let cands = [cand(0.9, "far", "X", Some(210)), cand(0.9, "near", "X", Some(217))];
        assert_eq!(best(&cands, 217).unwrap().title.as_deref(), Some("near"));
    }

    #[test]
    fn multiple_credited_artists_are_joined_in_order() {
        let c = Candidate { artists: vec!["Seedhe Maut".into(), "Sez".into()], ..cand(0.95, "A", "X", Some(200)) };
        assert_eq!(resolve(&c).unwrap().artist, "Seedhe Maut, Sez");
    }

    #[test]
    fn resolving_a_complete_candidate_never_touches_the_network() {
        // The happy path must not depend on MusicBrainz being reachable. If
        // this ever starts making a request it will hang in CI rather than
        // fail loudly, so it is asserted rather than assumed.
        let c = cand(0.95, "Title", "Artist", Some(200));
        let got = resolve(&c).unwrap();
        assert_eq!((got.title.as_str(), got.artist.as_str()), ("Title", "Artist"));
    }

    #[test]
    fn a_bare_candidate_with_an_unusable_mbid_resolves_to_nothing_rather_than_hanging() {
        // is_mbid rejects it before any request, so this is offline too.
        let bad = Candidate {
            title: None,
            artists: vec![],
            mbid: "not-an-id".into(),
            ..cand(0.99, "A", "X", Some(200))
        };
        assert!(resolve(&bad).is_none());
    }

    #[test]
    fn nothing_on_offer_is_not_an_error() {
        assert!(best(&[], 200).is_none());
    }

    /* ------------------------------------------------------------- keys --- */

    #[test]
    fn the_key_name_is_the_one_the_key_panel_writes() {
        // The renderer's 🔑 panel saves by name through set_api_key, which
        // sets an env var of exactly this name. A mismatch here would make a
        // saved key silently do nothing.
        assert_eq!(KEY_NAME, "ACOUSTID_API_KEY");
    }

    /// The live round trip, ignored by default. Run with a real key:
    /// `ACOUSTID_API_KEY=... cargo test -p lyric-overlay -- --ignored acoustid`
    /// Everything above this line runs without a key or a network.
    #[test]
    #[ignore = "needs an AcoustID API key and the network"]
    fn a_real_lookup_answers() {
        let key = api_key().expect("set ACOUSTID_API_KEY to run this");
        assert!(!key.is_empty());
        // A fingerprint of synthetic audio matches nothing, which is the
        // point: this proves the request shape is accepted and the response
        // parses, without depending on a particular song being in the index.
        let audio: Vec<f32> = (0..44_100 * 30).map(|i| ((i as f64 * 0.01).sin() * 0.5) as f32).collect();
        let fp = crate::fingerprint::compute(&audio, 44_100).unwrap();
        let candidates = lookup(&fp, 30).expect("lookup should succeed even with no match");
        println!("acoustid returned {} candidate(s)", candidates.len());
    }
}
