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
//! **Without a key: the user's own yt-dlp.** If they have installed yt-dlp
//! (video.rs, which also downloads with it), its `ytsearch` returns the same
//! candidates — id, title, channel and running time in one call, no quota —
//! and they go through the same `score`. The app still never scrapes YouTube
//! itself; it drives a tool the user chose to install, exactly as it does
//! for downloads. With neither, pasting the link works as before.
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
    /// View count when the source reports one (yt-dlp does; the API search
    /// does not, and a second quota-costing call is not worth it for this).
    pub views: Option<u64>,
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
    // The artist's own channel counts for more than the artist merely being
    // named in the title: re-uploads copy the official title word for word
    // ("Rick Astley - Never Gonna Give You Up (Official Music Video)" from
    // a channel called "Enjoy it") and used to tie with the real thing.
    let first_artist = sa.split(" feat ").next().unwrap_or(&sa).split(" x ").next().unwrap_or(&sa).trim().to_string();
    if !first_artist.is_empty() {
        if ch.contains(&first_artist) {
            s += 2.0;
        } else if vt.contains(&first_artist) {
            s += 1.0;
        }
    }
    // Popularity, gently: log-scaled so it breaks ties between otherwise
    // equal uploads (1.8B views ≈ +0.93, 25k ≈ +0.44) but cannot carry a
    // lyric video or a live cut past the penalties above and below.
    if let Some(v) = c.views.filter(|v| *v > 0) {
        s += ((v as f64).log10() / 10.0).min(1.0);
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
        // First of the best: on an exact tie YouTube's own ranking (result
        // order) decides, where max_by would take the LAST one.
        .fold(None::<(Candidate, f64)>, |acc, cur| match acc {
            Some(a) if a.1 >= cur.1 => Some(a),
            _ => Some(cur),
        })
}

/// Search YouTube for the song's music video. `Ok(None)` is "searched, found
/// nothing good"; `Err` is "could not search" (no key or yt-dlp, quota,
/// network). The API when there is a key, else the user's yt-dlp.
pub fn find(artist: &str, title: &str, duration_ms: u64) -> Result<Option<(Candidate, f64)>, String> {
    find_with(api_key(), crate::video::ytdlp(), artist, title, duration_ms)
}

fn find_with(
    key: Option<String>,
    ytdlp: Option<std::path::PathBuf>,
    artist: &str,
    title: &str,
    duration_ms: u64,
) -> Result<Option<(Candidate, f64)>, String> {
    let song_secs = (duration_ms > 0).then_some(duration_ms / 1000);
    let Some(key) = key else {
        let exe = ytdlp.ok_or_else(|| {
            "no YouTube API key — add one in Settings, install yt-dlp, or paste the video's link".to_string()
        })?;
        let cands = search_ytdlp(&exe, artist, title)?;
        return Ok(best(&cands, artist, title, song_secs));
    };
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
                        views: None,
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
    Ok(best(&cands, artist, title, song_secs))
}

/// Candidates from `yt-dlp --flat-playlist -J "ytsearch8:..."`. A flat search
/// lists each result's id, title, channel and duration without resolving
/// any video, so it is one quick request.
fn search_ytdlp(exe: &std::path::Path, artist: &str, title: &str) -> Result<Vec<Candidate>, String> {
    let query = format!("ytsearch8:{artist} {title} official video");
    let args = ["--flat-playlist", "-J", "--no-warnings", "--", query.as_str()].map(String::from);
    let out = crate::localcli::run_direct(&exe.to_string_lossy(), &args, Duration::from_secs(25), None)
        .map_err(|e| format!("yt-dlp search failed: {e}"))?;
    Ok(parse_ytdlp_search(&out))
}

/// The candidates in yt-dlp's `-J` output for a flat search.
pub fn parse_ytdlp_search(json: &str) -> Vec<Candidate> {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    v["entries"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| {
                    let id = e["id"].as_str().filter(|id| crate::video::valid_id(id))?;
                    Some(Candidate {
                        id: id.to_string(),
                        title: e["title"].as_str().unwrap_or("").to_string(),
                        channel: e["channel"].as_str().or_else(|| e["uploader"].as_str()).unwrap_or("").to_string(),
                        duration_secs: e["duration"].as_f64().filter(|d| *d > 0.0).map(|d| d.round() as u64),
                        views: e["view_count"].as_u64(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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
        Candidate { id: title.into(), title: title.into(), channel: channel.into(), duration_secs: Some(secs), views: None }
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
    fn without_a_key_or_ytdlp_find_says_so_instead_of_calling_out() {
        let err = find_with(None, None, "a", "b", 0).unwrap_err();
        assert!(err.contains("API key") && err.contains("yt-dlp"), "{err}");
    }

    #[test]
    fn ytdlp_search_output_becomes_ranked_candidates() {
        let json = r#"{"_type":"playlist","entries":[
          {"id":"AAAAAAAAAAA","title":"Artist - Song (Lyrics)","channel":"Lyric Hub","duration":214.0},
          {"id":"BBBBBBBBBBB","title":"Artist - Song (Official Video)","channel":"ArtistVEVO","duration":236.0},
          {"id":"not-an-id","title":"junk","channel":"x","duration":10},
          {"id":"CCCCCCCCCCC","title":"Song","uploader":"Artist - Topic","duration":null}
        ]}"#;
        let cands = parse_ytdlp_search(json);
        assert_eq!(cands.len(), 3, "an invalid id is dropped");
        assert_eq!(cands[2].channel, "Artist - Topic", "uploader stands in for a missing channel");
        assert_eq!(cands[2].duration_secs, None);
        let (pick, _) = best(&cands, "Artist", "Song", Some(214)).expect("a pick");
        assert_eq!(pick.id, "BBBBBBBBBBB");
    }

    /// The real search that exposed the tie (2026-11-19): a re-upload copying
    /// the official title used to score level with the official video and,
    /// being later in the list, win.
    #[test]
    fn the_artists_own_upload_beats_a_reupload_with_the_same_title() {
        let mk = |id: &str, title: &str, channel: &str, secs, views| Candidate {
            id: id.into(), title: title.into(), channel: channel.into(), duration_secs: Some(secs), views: Some(views),
        };
        let cands = vec![
            mk("dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley", 214, 1_838_766_163),
            mk("LM8dsLtUs2A", "Rick Astley - Never Gonna Give You Up (Official Music Video)", "Rick Astley", 213, 492),
            mk("LQ4w9xiHkrY", "Rick Astley - Never Gonna Give You Up [Remastered In 4K] (Official Music Video)", "Enjoy it🤍", 212, 25_746),
            mk("7FwDP17XPlk", "Rick Astley - Never Gonna Give You Up", "Amazing Lyrics", 214, 1_257_187),
        ];
        let (pick, _) = best(&cands, "Rick Astley", "Never Gonna Give You Up", Some(213)).unwrap();
        assert_eq!(pick.id, "dQw4w9WgXcQ");
    }

    #[test]
    fn on_an_exact_tie_the_first_result_wins() {
        let a = c("Artist - Song (Official Video)", "Artist", 200);
        let mut b = a.clone();
        b.id = "second".into();
        let (pick, _) = best(&[a.clone(), b], "Artist", "Song", Some(200)).unwrap();
        assert_eq!(pick.id, a.id);
    }

    #[test]
    fn unreadable_ytdlp_output_is_no_candidates() {
        assert!(parse_ytdlp_search("").is_empty());
        assert!(parse_ytdlp_search("{\"entries\": 5}").is_empty());
    }

    /// Live: `LYRIC_TEST_YTDLP=/path/to/yt-dlp cargo test --workspace --
    /// --ignored real_ytdlp_search`.
    #[test]
    #[ignore]
    fn real_ytdlp_search_finds_an_official_video() {
        let exe = std::env::var("LYRIC_TEST_YTDLP").map(std::path::PathBuf::from).expect("set LYRIC_TEST_YTDLP");
        let found = find_with(None, Some(exe), "Rick Astley", "Never Gonna Give You Up", 213_000).expect("search ran");
        let (c, score) = found.expect("a match");
        eprintln!("picked {} — {} · {} ({:?}s, score {score:.1})", c.id, c.title, c.channel, c.duration_secs);
        assert_eq!(c.id, "dQw4w9WgXcQ");
    }
}
