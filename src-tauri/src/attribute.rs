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
    fn smooth_absorbs_short_runs() {
        // A lone 1 between runs of 0 is absorbed into the preceding 0.
        assert_eq!(smooth_runs(vec![0, 0, 1, 0, 0], 2), vec![0, 0, 0, 0, 0]);
        // The first run stands even if short.
        assert_eq!(smooth_runs(vec![1, 0, 0], 2), vec![1, 0, 0]);
    }
}
