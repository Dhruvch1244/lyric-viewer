//! LLM correction of a Whisper transcript — the "brain" half of the ear/brain
//! split (LyricWhiz / python-lyrics-transcriber). A Rust port of the old
//! Electron-era `src/main/correct.js` (commit cb60b39), which existed before
//! the Tauri migration and was never carried over — a real migration gap,
//! not a net-new feature.
//!
//! Whisper is a speech model; on sung vocals over a dense mix (fast rap,
//! heavy EDM — most of this library) it runs well below its speech accuracy.
//! But it mishears PHONETICALLY: the output rhymes with the truth. A model
//! told the song's title and artist can often reconstruct the real line from
//! that, because it has the one thing Whisper lacks — knowledge of what this
//! song actually is.
//!
//! Deliberately never runs when the lyric text came from a real source.
//! `finalize_transcription` in lib.rs only calls this when `source ==
//! "whisper"` — i.e. nothing anchored LRCLIB's real plain lyrics onto
//! Whisper's clock, so there is nothing but the model's own ear to go on. If
//! real lyrics DID anchor, the words are already correct and "correcting"
//! them can only make them wrong.

use serde_json::{json, Value};

use crate::llm;
use crate::lyrics::Cue;

/// Lines per request. Smaller than translate.rs's 50 — a correction prompt
/// carries more context per line, and the whole point is the model seeing
/// enough of the song around a line to recognise it.
const BATCH_SIZE: usize = 40;

const SYSTEM_PROMPT: &str = "You correct errors in an automatic transcription of song lyrics.\n\n\
The input is what a speech-recognition model heard in a song. It is often wrong\n\
in a specific way: the words are phonetically close to the truth but are not the\n\
real words, because the model was trained on speech and this is singing over\n\
music.\n\n\
Rules:\n\
- Fix mishearings. Use the song title and artist, the rhyme scheme, and the\n\
  surrounding lines to work out what was actually sung.\n\
- Return EXACTLY as many lines as you were given, in the same order. Never merge,\n\
  split, add or drop a line. Each output line corresponds to the input line at\n\
  the same index.\n\
- If a line is already right, or you cannot tell what it should be, return it\n\
  unchanged. A confident wrong guess is worse than leaving it alone.\n\
- Do NOT translate, transliterate, or change the language of a line. Romanized\n\
  Hindi/Punjabi stays romanized.\n\
- Do NOT add punctuation, capitalisation or formatting the transcription did not\n\
  have. You are fixing words, not tidying text.\n\
- Never return an empty line for a line that had words.";

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Corrected lyric lines, same count and order as the input.",
            },
        },
        "required": ["lines"],
        "additionalProperties": false,
    })
}

/// Merge a model's returned lines onto the original cues.
///
/// Pure, and separated from the network call because this is where the
/// damage would be done. The rules it enforces:
///
///   - the line count must match exactly, or the whole batch is rejected — a
///     model that merged two lines has shifted every timing after it, which
///     is far worse than an uncorrected transcript;
///   - timings (`time_ms`/`end_ms`) are copied through untouched, only `text`
///     may change;
///   - a blank correction for a line that had words is ignored, since it
///     would silently delete a lyric;
///   - `words` (measured per-word timing) is dropped on any line whose text
///     actually changed, because those timings were measured against the OLD
///     words and would now point at the wrong ones.
fn merge_corrections(cues: &[Cue], lines: &[String]) -> Result<(Vec<Cue>, usize), String> {
    if lines.len() != cues.len() {
        return Err(format!("line count mismatch: sent {}, received {}", cues.len(), lines.len()));
    }
    let mut changed = 0;
    let out = cues
        .iter()
        .zip(lines.iter())
        .map(|(cue, raw)| {
            let raw = raw.trim();
            let original = cue.text.trim();
            if raw.is_empty() && !original.is_empty() {
                return cue.clone(); // would delete a lyric outright
            }
            if raw == original {
                return cue.clone();
            }
            changed += 1;
            Cue { time_ms: cue.time_ms, text: raw.to_string(), end_ms: cue.end_ms, words: None }
        })
        .collect();
    Ok((out, changed))
}

/// One batch: the network call plus the merge. `None` on ANY failure —
/// missing provider (checked by the caller before this runs), network error,
/// malformed response, or a count mismatch — so the caller can fall back to
/// the batch's original lines rather than losing them.
fn try_correct_batch(batch: &[Cue], title: &str, artist: &str) -> Option<(Vec<Cue>, usize)> {
    let texts: Vec<&str> = batch.iter().map(|c| c.text.as_str()).collect();
    let user = format!(
        "Song: {}\nArtist: {}\n\nCorrect this transcription. Return one output line per input line.\n\n{}",
        if title.is_empty() { "unknown" } else { title },
        if artist.is_empty() { "unknown" } else { artist },
        serde_json::to_string_pretty(&json!({ "lines": texts })).unwrap_or_default()
    );
    let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
    let lines: Vec<String> = parsed
        .get("lines")
        .and_then(|v| v.as_array())?
        .iter()
        .map(|v| v.as_str().unwrap_or("").to_string())
        .collect();
    merge_corrections(batch, &lines).ok()
}

/// Run a correction pass over a transcript. Returns the ORIGINAL cues (0
/// changed) on no provider or an empty input — a transcript good enough to
/// show before this pass is still good enough after it declines to run.
///
/// Failure is contained per BATCH, not per song: one bad response keeps that
/// batch's original lines rather than discarding corrections that already
/// succeeded for the rest of the track. `on_batch(done, total)` fires before
/// each batch's network call, for progress reporting.
pub fn correct_transcript(
    cues: &[Cue],
    title: &str,
    artist: &str,
    mut on_batch: impl FnMut(usize, usize),
) -> (Vec<Cue>, usize) {
    if cues.is_empty() || !llm::is_available() {
        return (cues.to_vec(), 0);
    }

    let batches = cues.len().div_ceil(BATCH_SIZE);
    let mut result = Vec::with_capacity(cues.len());
    let mut changed = 0;
    let mut i = 0;
    let mut b = 0;
    while i < cues.len() {
        let end = (i + BATCH_SIZE).min(cues.len());
        let batch = &cues[i..end];
        b += 1;
        on_batch(b, batches);
        match try_correct_batch(batch, title, artist) {
            Some((merged, batch_changed)) => {
                result.extend(merged);
                changed += batch_changed;
            }
            None => result.extend_from_slice(batch),
        }
        i = end;
    }
    (result, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t: i64, s: &str) -> Cue {
        Cue { time_ms: t, text: s.into(), end_ms: None, words: None }
    }

    fn lines(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn corrected_text_replaces_the_original() {
        let (out, changed) = merge_corrections(
            &[cue(0, "sweet dreams are made of cheese")],
            &lines(&["sweet dreams are made of this"]),
        )
        .unwrap();
        assert_eq!(out[0].text, "sweet dreams are made of this");
        assert_eq!(changed, 1);
    }

    #[test]
    fn timings_are_never_touched() {
        let input = [cue(0, "a"), cue(1000, "b"), cue(2000, "c")];
        let (out, _) = merge_corrections(&input, &lines(&["x", "y", "z"])).unwrap();
        assert_eq!(out.iter().map(|c| c.time_ms).collect::<Vec<_>>(), vec![0, 1000, 2000]);
    }

    #[test]
    fn a_line_count_mismatch_rejects_the_whole_batch() {
        assert!(merge_corrections(&[cue(0, "a"), cue(1, "b"), cue(2, "c")], &lines(&["a", "b"])).is_err());
        assert!(merge_corrections(&[cue(0, "a"), cue(1, "b")], &lines(&["a", "b", "c"])).is_err());
    }

    #[test]
    fn a_blank_correction_never_deletes_a_lyric() {
        let (out, changed) = merge_corrections(&[cue(0, "real words here")], &lines(&["   "])).unwrap();
        assert_eq!(out[0].text, "real words here");
        assert_eq!(changed, 0);
    }

    #[test]
    fn unchanged_lines_are_reported_as_unchanged() {
        let (out, changed) = merge_corrections(&[cue(0, "same"), cue(1, "same too")], &lines(&["same", "same too"])).unwrap();
        assert_eq!(changed, 0);
        assert_eq!(out.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), vec!["same", "same too"]);
    }

    #[test]
    fn whitespace_only_differences_do_not_count_as_corrections() {
        let (_, changed) = merge_corrections(&[cue(0, "hello world")], &lines(&["  hello world  "])).unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn word_timings_are_dropped_from_lines_whose_text_changed() {
        let word = |w: &str, s: i64, e: i64| crate::lyrics::WordTiming { word: w.into(), start_ms: s, end_ms: e };
        let input = [
            Cue { time_ms: 0, text: "wrong words".into(), end_ms: None, words: Some(vec![word("wrong", 0, 300), word("words", 300, 600)]) },
            Cue { time_ms: 1000, text: "right already".into(), end_ms: None, words: Some(vec![word("right", 1000, 1300)]) },
        ];
        let (out, _) = merge_corrections(&input, &lines(&["correct words", "right already"])).unwrap();
        assert!(out[0].words.is_none(), "stale word timings survived a rewrite");
        assert!(out[1].words.is_some(), "untouched line lost its word timings");
    }

    #[test]
    fn other_cue_fields_are_carried_through() {
        let input = [Cue { time_ms: 0, text: "a".into(), end_ms: Some(900), words: None }];
        let (out, _) = merge_corrections(&input, &lines(&["b"])).unwrap();
        assert_eq!(out[0].end_ms, Some(900));
    }

    #[test]
    fn an_empty_original_line_may_be_filled_in() {
        // The blank guard protects lines that HAD words; it must not stop the
        // model supplying words for a line that had none.
        let (out, changed) = merge_corrections(&[cue(0, "")], &lines(&["now it has words"])).unwrap();
        assert_eq!(out[0].text, "now it has words");
        assert_eq!(changed, 1);
    }

    #[test]
    fn empty_input_and_no_provider_both_no_op_without_a_network_call() {
        // No provider configured in a test process, so this exercises the
        // early-return path rather than actually reaching the network.
        let (out, changed) = correct_transcript(&[], "Song", "Artist", |_, _| {});
        assert_eq!(out.len(), 0);
        assert_eq!(changed, 0);
    }
}
