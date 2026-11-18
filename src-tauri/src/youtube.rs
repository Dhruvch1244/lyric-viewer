//! Find a song's music video on YouTube, so the renderer can play it — muted,
//! in the official embedded player — in sync under the visuals.
//!
//! **Why an API key, and why it is optional.** Searching YouTube needs the
//! Data API (v3), which needs a key; scraping the website instead would break
//! YouTube's terms and break whenever the page changes. So the key is a
//! Settings field like AcoustID's, and without one the feature still works:
//! the user pastes the video's link and the app remembers it for the song.
//! Nothing is ever downloaded — the renderer embeds YouTube's own player.
//!
//! **Picking the right video** is most of this file. A search for "artist
//! title" returns the official video, but also lyric videos, live cuts,
//! covers, reactions, sped-up edits and the "- Topic" upload (a still image
//! over the audio). `score` ranks them on what a person would look at: the
//! title naming the song, the channel being the artist's (or VEVO), "official
//! video" in the name, none of the giveaway words, and a running time close
//! to the song's — a music video runs a little longer than the track when it
//! has an intro, never shorter. It is pure and unit-tested; `find` is the
//! two network calls around it (search, then the candidates' durations,
//! which the search endpoint does not return).
//!
//! Quota: a search costs 100 units of the 10,000 a free key gets per day, so
//! about 100 lookups a day. The renderer only asks when a song has no
//! remembered video, so a library played on repeat costs nothing.

use serde_json::Value;
use std::time::Duration;

pub const KEY_NAME: &str = "YOUTUBE_API_KEY";
const SEARCH: &str = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS: &str = "https://www.googleapis.com/youtube/v3/videos";

/// A video worth choosing below this is no match at all.
const MIN_SCORE: f64 = 2.0;

/// The configured key, if the user has supplied one.
pub fn api_key() -> Option<String> {
    std::env::var(KEY_NAME).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration_secs: Option<u64>,
}

/// `PT3M45S` → 225. YouTube's contentDetails.duration is ISO 8601.
pub fn parse_iso_duration(s: &str) -> Option<u64> {
    let rest = s.strip_prefix("PT").or_else(|| s.strip_prefix("P0DT")).or_else(|| s.strip_prefix("P"))?;
    let rest = rest.trim_start_matches("0DT").trim_start_matches('T');
    let mut total = 0u64;
    let mut num = String::new();
    let mut any = false;
    for c in rest.chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: u64 = num.parse().ok()?;
        num.clear();
        total += match c {
            'H' => n * 3600,
            'M' => n * 60,
            'S' => n,
            'D' => n * 86_400,
            _ => return None,
        };
        any = true;
    }
    if !num.is_empty() || !any {
        return None;
    }
    Some(total)
}

/// The search API returns titles HTML-escaped (`Don&#39;t`, `R&amp;B`).
pub fn unescape(s: &str) -> String {
    s.replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Lowercase letters and digits only, single-spaced — so "Tum Hi Ho (Full
/// Video)" and "tum hi ho" can be compared word for word.
fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = true;
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

/// Words that mark a video as not the music video — unless the song's own
/// title contains them (a song called "Live Forever" is allowed its live).
const GIVEAWAYS: &[&str] = &[
    "lyric", "lyrics", "lyrical", "live", "cover", "reaction", "remix", "8d", "slowed", "reverb",
    "sped up", "nightcore", "karaoke", "instrumental", "teaser", "trailer", "shorts", "audio",
    "visualizer", "visualiser", "fan made", "fanmade", "behind the scenes", "making of",
];

/// How likely `c` is the official music video for `artist` – `title`.
pub fn score(c: &Candidate, artist: &str, title: &str, song_secs: Option<u64>) -> f64 {
    let vt = norm(&c.title);
    let ch = norm(&c.channel);
    let st = norm(title);
    let sa = norm(artist);
    let mut s = 0.0;

    // The song's title must be in the video's — a hard requirement, not a
    // penalty: the artist's own channel posting "Official Video" for a
    // DIFFERENT song otherwise outscores everything else on the page.
    if st.is_empty() || !vt.contains(&st) {
        return -10.0;
    }
    s += 2.0;
    // The artist's own channel, or VEVO, or the artist named in the title.
    let first_artist = sa.split(" feat ").next().unwrap_or(&sa).split(" x ").next().unwrap_or(&sa).trim().to_string();
    if !first_artist.is_empty() && (ch.contains(&first_artist) || vt.contains(&first_artist)) {
        s += 2.0;
    }
    if c.channel.trim_end().ends_with("VEVO") {
        s += 1.5;
    }
    // "- Topic" channels are auto-generated: a still image over the audio.
    if c.channel.trim_end().ends_with("- Topic") {
        s -= 4.0;
    }
    if vt.contains("official music video") || vt.contains("official video") {
        s += 2.0;
    } else if vt.contains("official") || vt.contains("music video") {
        s += 0.5;
    }
    for w in GIVEAWAYS {
        if vt.contains(w) && !st.contains(w) {
            // "official audio" and "lyric video" both sink hard: no picture.
            s -= 3.0;
        }
    }
    // Running time. A music video may add an intro or an outro; it is never
    // a cut-down of the track.
    if let (Some(v), Some(song)) = (c.duration_secs, song_secs) {
        if song > 0 {
            let (v, song) = (v as i64, song as i64);
            let d = v - song;
            if d.abs() <= 5 {
                s += 1.5;
            } else if d < -10 {
                s -= 3.0;
            } else if d <= 120 {
                s += 0.5;
            } else {
                s -= 2.0;
            }
        }
    }
    s
}

/// The best candidate, if any scores as a real match.
pub fn best(cands: &[Candidate], artist: &str, title: &str, song_secs: Option<u64>) -> Option<(Candidate, f64)> {
    cands
        .iter()
        .map(|c| (c.clone(), score(c, artist, title, song_secs)))
        .filter(|(_, s)| *s >= MIN_SCORE)
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// Search YouTube for the song's music video. `Ok(None)` is "searched, found
/// nothing good"; `Err` is "could not search" (no key, quota, network).
pub fn find(artist: &str, title: &str, duration_ms: u64) -> Result<Option<(Candidate, f64)>, String> {
    let key = api_key().ok_or_else(|| "no YouTube API key — add one in Settings, or paste the video's link".to_string())?;
    let q = format!("{artist} {title} official video");
    let resp = ureq::get(SEARCH)
        .query("part", "snippet")
        .query("type", "video")
        .query("videoEmbeddable", "true")
        .query("maxResults", "8")
        .query("q", &q)
        .query("key", &key)
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(describe)?;
    let body: Value = resp.into_json().map_err(|e| format!("bad response: {e}"))?;
    let mut cands: Vec<Candidate> = body["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    Some(Candidate {
                        id: it["id"]["videoId"].as_str()?.to_string(),
                        title: unescape(it["snippet"]["title"].as_str().unwrap_or("")),
                        channel: unescape(it["snippet"]["channelTitle"].as_str().unwrap_or("")),
                        duration_secs: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if cands.is_empty() {
        return Ok(None);
    }
    // Durations: one more call for all candidates (1 quota unit).
    let ids = cands.iter().map(|c| c.id.as_str()).collect::<Vec<_>>().join(",");
    if let Ok(resp) = ureq::get(VIDEOS)
        .query("part", "contentDetails")
        .query("id", &ids)
        .query("key", &key)
        .timeout(Duration::from_secs(12))
        .call()
    {
        if let Ok(v) = resp.into_json::<Value>() {
            for it in v["items"].as_array().into_iter().flatten() {
                let (Some(id), Some(d)) = (it["id"].as_str(), it["contentDetails"]["duration"].as_str()) else { continue };
                if let Some(c) = cands.iter_mut().find(|c| c.id == id) {
                    c.duration_secs = parse_iso_duration(d);
                }
            }
        }
    }
    let song_secs = (duration_ms > 0).then_some(duration_ms / 1000);
    Ok(best(&cands, artist, title, song_secs))
}

/// A message a person can act on, from a failed API call.
fn describe(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(403, r) => {
            let body = r.into_string().unwrap_or_default();
            if body.contains("quotaExceeded") {
                "YouTube's daily search quota is used up — paste the link, or try tomorrow".into()
            } else {
                "YouTube refused the key — check it in Settings".into()
            }
        }
        ureq::Error::Status(400, _) => "YouTube refused the key — check it in Settings".into(),
        ureq::Error::Status(code, _) => format!("YouTube search failed (HTTP {code})"),
        ureq::Error::Transport(_) => "could not reach YouTube — check your connection".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(title: &str, channel: &str, secs: u64) -> Candidate {
        Candidate { id: title.into(), title: title.into(), channel: channel.into(), duration_secs: Some(secs) }
    }

    #[test]
    fn iso_durations() {
        assert_eq!(parse_iso_duration("PT3M45S"), Some(225));
        assert_eq!(parse_iso_duration("PT1H2M3S"), Some(3723));
        assert_eq!(parse_iso_duration("PT59S"), Some(59));
        assert_eq!(parse_iso_duration("PT4M"), Some(240));
        assert_eq!(parse_iso_duration("P0D"), Some(0));
        assert_eq!(parse_iso_duration("garbage"), None);
        assert_eq!(parse_iso_duration("PT3M45"), None);
    }

    #[test]
    fn titles_are_unescaped() {
        assert_eq!(unescape("Don&#39;t Stop &amp; R&amp;B &quot;Live&quot;"), "Don't Stop & R&B \"Live\"");
    }

    #[test]
    fn the_official_video_beats_lyric_live_topic_and_sped_up_uploads() {
        let song = 262;
        let cands = vec![
            c("Arijit Singh - Tum Hi Ho (Lyrics)", "Lyrics Hub", 262),
            c("Tum Hi Ho - Live in Concert", "Arijit Singh", 400),
            c("Tum Hi Ho", "Arijit Singh - Topic", 262),
            c("Tum Hi Ho (Sped Up)", "edits", 200),
            c("Tum Hi Ho Full Video Song | Aashiqui 2 | Arijit Singh", "T-Series", 280),
            c("Arijit Singh - Tum Hi Ho (Official Video)", "ArijitSinghVEVO", 270),
        ];
        let (pick, _) = best(&cands, "Arijit Singh", "Tum Hi Ho", Some(song)).expect("a match");
        assert_eq!(pick.title, "Arijit Singh - Tum Hi Ho (Official Video)");
    }

    #[test]
    fn a_label_upload_with_the_artist_in_the_title_is_accepted_when_nothing_better_exists() {
        let cands = vec![
            c("Tum Hi Ho Full Video Song | Aashiqui 2 | Arijit Singh", "T-Series", 280),
            c("Tum Hi Ho (Lyrics)", "Lyrics Hub", 262),
        ];
        let (pick, _) = best(&cands, "Arijit Singh", "Tum Hi Ho", Some(262)).expect("a match");
        assert_eq!(pick.channel, "T-Series");
    }

    #[test]
    fn nothing_matching_the_title_is_no_match() {
        let cands = vec![c("Some Other Song (Official Video)", "Arijit Singh", 262)];
        assert!(best(&cands, "Arijit Singh", "Tum Hi Ho", Some(262)).is_none());
    }

    #[test]
    fn a_song_whose_title_contains_a_giveaway_word_is_not_penalised_for_it() {
        let live = c("Oasis - Live Forever (Official Video)", "OasisVEVO", 280);
        let cover = c("Oasis - Live Forever (Cover)", "someone", 280);
        assert!(score(&live, "Oasis", "Live Forever", Some(277)) > score(&cover, "Oasis", "Live Forever", Some(277)));
        assert!(score(&live, "Oasis", "Live Forever", Some(277)) >= MIN_SCORE);
    }

    #[test]
    fn a_cut_down_version_scores_below_the_full_one() {
        let full = c("Song (Official Video)", "ArtistVEVO", 215);
        let short = c("Song (Official Video)", "ArtistVEVO", 150);
        assert!(score(&full, "Artist", "Song", Some(210)) > score(&short, "Artist", "Song", Some(210)));
    }

    #[test]
    fn without_a_key_find_says_so_instead_of_calling_out() {
        std::env::remove_var(KEY_NAME);
        let err = find("a", "b", 0).unwrap_err();
        assert!(err.contains("API key"), "{err}");
    }
}
