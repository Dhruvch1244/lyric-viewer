//! Per-line artist attribution — which collaborator sings which line.
//!
//! A Rust port of `attribute.js`. No lyric source carries this, but a model
//! knows it (or can infer it from verse structure). Returns one artist index
//! per line; never touches words or timings. Falls back to None (the renderer
//! keeps rotating dancers) on anything less than a usable answer.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::llm;

const BATCH_SIZE: usize = 80;
const MAX_ARTISTS: usize = 6;

const SYSTEM_PROMPT: &str = "You identify which artist performs each line of a song.\n\n\
You are given a song title, an ordered list of the artists credited on it, and\n\
the song's lyrics as numbered lines. For every line, say which artist sings it.\n\n\
Rules:\n\
- Answer with an artist INDEX from the list you were given, zero-based.\n\
- Return EXACTLY as many answers as there are lines, in the same order.\n\
- Songs are usually sung in blocks, not alternating line by line. A verse\n\
  belongs to one artist; a hook is often shared. Prefer contiguous runs.\n\
- Use what you know about the recording first. Where you do not know it, use the\n\
  structure: verse boundaries, a change of voice, an artist named in the line.\n\
- If a line is sung together or you genuinely cannot tell, use -1.\n\
- Never invent an artist who is not in the list, and never return an index\n\
  outside it.";

static SPLIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*(?:,|&|\b(?:feat|ft|featuring|with|vs|x)\b\.?|/)\s*").unwrap());

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "singers": {
                "type": "array",
                "items": { "type": "integer" },
                "description": "One zero-based artist index per lyric line, in order. -1 means shared or unknown.",
            },
        },
        "required": ["singers"],
        "additionalProperties": false,
    })
}

/// Split a credit string into individual artists (the shapes SMTC/lyric sources
/// actually produce). Case-insensitive dedupe, capped at MAX_ARTISTS.
pub fn split_artists(credit: &str) -> Vec<String> {
    if credit.trim().is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for part in SPLIT_RE.split(credit) {
        let name = part.trim();
        if name.is_empty() {
            continue;
        }
        if out.iter().any(|o| o.eq_ignore_ascii_case(name)) {
            continue;
        }
        out.push(name.to_string());
        if out.len() >= MAX_ARTISTS {
            break;
        }
    }
    out
}

/// Validate a model's answer for one batch: clamp indices into range, coerce
/// anything unparseable to -1, reject a wrong-length answer outright.
fn normalise_singers(line_count: usize, singers: &Value, artist_count: usize) -> Option<Vec<i64>> {
    let arr = singers.as_array()?;
    if arr.len() != line_count {
        return None;
    }
    Some(
        arr.iter()
            .map(|v| match v.as_i64() {
                Some(n) if n >= 0 && (n as usize) < artist_count => n,
                _ => -1,
            })
            .collect(),
    )
}

/// Absorb runs shorter than `min_run` into the run before them, so the mic does
/// not flicker between dancers for a single line.
fn smooth_runs(singers: Vec<i64>, min_run: usize) -> Vec<i64> {
    if singers.is_empty() {
        return singers;
    }
    let mut out = singers;
    let mut start = 0;
    while start < out.len() {
        let mut end = start;
        while end + 1 < out.len() && out[end + 1] == out[start] {
            end += 1;
        }
        let length = end - start + 1;
        if length < min_run && start > 0 {
            let fill = out[start - 1];
            for slot in out.iter_mut().take(end + 1).skip(start) {
                *slot = fill;
            }
        }
        start = end + 1;
    }
    out
}

/// Work out who sings each line. None when there is no usable answer (no
/// provider, a solo artist, failures, or an all-unknown result).
pub fn attribute_lines(cue_texts: &[String], title: &str, artist: &str) -> Option<(Vec<String>, Vec<i64>)> {
    if cue_texts.is_empty() || !llm::is_available() {
        return None;
    }
    let lineup = split_artists(artist);
    if lineup.len() < 2 {
        return None; // one name is not a question
    }

    let mut singers: Vec<i64> = Vec::with_capacity(cue_texts.len());
    let mut i = 0;
    while i < cue_texts.len() {
        let end = (i + BATCH_SIZE).min(cue_texts.len());
        let slice = &cue_texts[i..end];
        let user = format!(
            "Song: {}\nArtists (use these indices):\n{}\n\nLines:\n{}\n\nReturn exactly {} indices.",
            if title.is_empty() { "unknown" } else { title },
            lineup.iter().enumerate().map(|(idx, n)| format!("  {idx}: {n}")).collect::<Vec<_>>().join("\n"),
            slice.iter().enumerate().map(|(idx, t)| format!("{idx}: {}", t.trim())).collect::<Vec<_>>().join("\n"),
            slice.len()
        );
        match llm::convert(SYSTEM_PROMPT, &user, &schema()) {
            Ok(parsed) => match parsed.get("singers").and_then(|s| normalise_singers(slice.len(), s, lineup.len())) {
                Some(mut batch) => singers.append(&mut batch),
                None => singers.extend(std::iter::repeat(-1).take(slice.len())),
            },
            Err(_) => singers.extend(std::iter::repeat(-1).take(slice.len())),
        }
        i = end;
    }

    if singers.iter().all(|s| *s < 0) {
        return None; // every line unknown is the default wearing a hat
    }
    Some((lineup, smooth_runs(singers, 2)))
}

/// Fill in lines the LLM left at -1 (unknown/shared) using the audio's own
/// diarization clusters (ROADMAP.md §5.8, `sidecar/src/diarize.rs`) — the
/// text-based guess above knows the lineup's NAMES but not who is actually
/// singing; diarization knows who is singing but only as anonymous cluster
/// numbers. Combined: for each unresolved line, look at which artist indices
/// the LLM already assigned to OTHER lines sharing this line's diarization
/// cluster, and take the majority; a cluster with no confidently-attributed
/// line anywhere in it is left at -1, same as before.
///
/// `line_cluster` is one diarization cluster id per line — the caller's job
/// to derive from `SpeakerSpan`s and each cue's time range (whichever cluster
/// covers most of the line), since that mapping needs the cue timings this
/// function does not take. `None` for a line diarization said nothing about
/// (e.g. shorter than one embedding window).
///
/// Not yet wired to a live caller: diarization needs raw audio, and today
/// only songs that need transcription (no synced lyrics found) ever have
/// audio in hand at the point attribution runs (`resolve_attribution`
/// fires off lyric text alone, before playback). Wiring this in for an
/// already-synced song needs that capture to happen for attribution's sake
/// too, not only transcription's — a real next step, not a stub.
// Not yet called from anywhere — see the doc comment above for why. Same
// shape as genius.rs's module-level allow: kept ready, not deleted, because
// deleting it would lose the (tested) hard part before the easy wiring step
// exists to use it.
#[allow(dead_code)]
pub fn refine_with_diarization(singers: &[i64], line_cluster: &[Option<u32>]) -> Vec<i64> {
    if singers.len() != line_cluster.len() {
        return singers.to_vec(); // shapes disagree; refuse rather than guess
    }

    // One majority vote per cluster, from lines the LLM already resolved.
    let mut votes: std::collections::HashMap<u32, std::collections::HashMap<i64, u32>> = std::collections::HashMap::new();
    for (&singer, &cluster) in singers.iter().zip(line_cluster) {
        if singer < 0 {
            continue;
        }
        if let Some(c) = cluster {
            *votes.entry(c).or_default().entry(singer).or_default() += 1;
        }
    }
    let majority: std::collections::HashMap<u32, i64> = votes
        .into_iter()
        .filter_map(|(cluster, counts)| counts.into_iter().max_by_key(|(_, n)| *n).map(|(singer, _)| (cluster, singer)))
        .collect();

    singers
        .iter()
        .zip(line_cluster)
        .map(|(&singer, &cluster)| {
            if singer >= 0 {
                return singer;
            }
            cluster.and_then(|c| majority.get(&c).copied()).unwrap_or(-1)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_artists_handles_common_shapes() {
        assert_eq!(split_artists("Drake"), vec!["Drake"]);
        assert_eq!(split_artists("A, B & C"), vec!["A", "B", "C"]);
        assert_eq!(split_artists("Calvin Harris feat. Rihanna"), vec!["Calvin Harris", "Rihanna"]);
        assert_eq!(split_artists("Seedhe Maut x MC"), vec!["Seedhe Maut", "MC"]);
        // Case-insensitive dedupe.
        assert_eq!(split_artists("Drake & drake"), vec!["Drake"]);
    }

    #[test]
    fn normalise_rejects_wrong_length_and_clamps() {
        let v = json!([0, 1, 5, -1, "x"]);
        // artist_count 2 → 5 and "x" become -1.
        assert_eq!(normalise_singers(5, &v, 2), Some(vec![0, 1, -1, -1, -1]));
        assert_eq!(normalise_singers(4, &v, 2), None); // length mismatch
    }

    #[test]
    fn refine_fills_an_unknown_line_from_its_clusters_majority() {
        // Lines 0,1 confidently attributed to artist 0, both in cluster 5.
        // Line 2 is unknown but shares cluster 5 — should inherit artist 0.
        let singers = vec![0, 0, -1];
        let clusters = vec![Some(5), Some(5), Some(5)];
        assert_eq!(refine_with_diarization(&singers, &clusters), vec![0, 0, 0]);
    }

    #[test]
    fn refine_never_overwrites_an_already_confident_line() {
        let singers = vec![0, 1];
        let clusters = vec![Some(9), Some(9)]; // same cluster, disagreeing labels
        assert_eq!(refine_with_diarization(&singers, &clusters), vec![0, 1], "existing LLM answers must not be overwritten");
    }

    #[test]
    fn refine_leaves_a_cluster_with_no_confident_line_at_unknown() {
        let singers = vec![-1, -1];
        let clusters = vec![Some(1), Some(1)];
        assert_eq!(refine_with_diarization(&singers, &clusters), vec![-1, -1]);
    }

    #[test]
    fn refine_leaves_a_line_with_no_cluster_at_unknown() {
        let singers = vec![0, -1];
        let clusters = vec![Some(1), None];
        assert_eq!(refine_with_diarization(&singers, &clusters), vec![0, -1]);
    }

    #[test]
    fn refine_takes_the_majority_when_a_clusters_known_lines_disagree() {
        // Cluster 2 has two lines attributed to artist 0 and one to artist 1;
        // the unknown line should inherit the majority, 0.
        let singers = vec![0, 0, 1, -1];
        let clusters = vec![Some(2), Some(2), Some(2), Some(2)];
        assert_eq!(refine_with_diarization(&singers, &clusters)[3], 0);
    }

    #[test]
    fn refine_refuses_mismatched_lengths_rather_than_guessing() {
        let singers = vec![0, -1];
        let clusters = vec![Some(1)];
        assert_eq!(refine_with_diarization(&singers, &clusters), singers);
    }

    #[test]
    fn smooth_absorbs_short_runs() {
        // A lone 1 between runs of 0 is absorbed into the preceding 0.
        assert_eq!(smooth_runs(vec![0, 0, 1, 0, 0], 2), vec![0, 0, 0, 0, 0]);
        // The first run stands even if short.
        assert_eq!(smooth_runs(vec![1, 0, 0], 2), vec![1, 0, 0]);
    }
}
