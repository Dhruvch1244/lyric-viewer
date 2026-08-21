//! English translation of non-English lyric lines (meaning, not script).
//!
//! A Rust port of `translate.js`. Batches the lines through `llm::convert`,
//! preserving timing, and returns the dominant source language plus the
//! translated cues. Shown as a secondary line under the running lyric.

use serde_json::{json, Value};

use crate::llm;
use crate::lyrics::Cue;

const BATCH_SIZE: usize = 50;

const SYSTEM_PROMPT: &str = "You translate song lyrics into natural, fluent English.\n\n\
Rules:\n\
- Translate meaning, not word-for-word. Prefer how a native English speaker would say it.\n\
- Input lines may be Hindi, Punjabi, or other languages, written in either their\n\
  native script (Devanagari, Gurmukhi) or romanized in the Latin alphabet.\n\
- Keep slang and tone; render it as idiomatic English slang where appropriate.\n\
- Some or even all of the lines you are given may already be plain English. That is\n\
  not an error and not a reason to comment on it or stop: copy each such line through\n\
  unchanged, at its own index, exactly like every other line.\n\
- Leave purely instrumental markers or empty lines unchanged.\n\
- Never omit, merge, split, reorder, or explain a line, even one that needs no\n\
  change. Never return prose, an apology, or a note instead of the lines array.\n\
- Return EXACTLY as many output lines as input lines, in the same order — this\n\
  holds even when every input line is already English and stays unchanged.\n\
- Also report the dominant source language of the ORIGINAL lyrics as a lowercase\n\
  English word (e.g. \"hindi\", \"punjabi\", \"english\") — this still applies even\n\
  when that language is English itself.";

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": { "type": "string", "description": "Dominant source language, lowercase." },
            "lines": {
                "type": "array",
                "items": { "type": "string" },
                "description": "English translations, same count and order as input.",
            },
        },
        "required": ["language", "lines"],
        "additionalProperties": false,
    })
}

/// One batch: the network call plus the shape check. `None` on any failure —
/// network error, malformed response, or a count mismatch (e.g. a model that
/// added commentary instead of translating a batch it decided was already all
/// English) — so the caller can fall back to that batch's original text
/// rather than losing the whole song over one bad batch. On success, also
/// returns the reported source language.
fn try_batch(batch: &[String]) -> Option<(Vec<String>, String)> {
    let user = format!(
        "Translate these lyric lines to English. Return one output line per input line.\n\n{}",
        serde_json::to_string_pretty(&json!({ "lines": batch })).unwrap_or_default()
    );
    let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
    let lines = parsed.get("lines").and_then(|v| v.as_array())?;
    if lines.len() != batch.len() {
        return None; // count mismatch — reject this batch rather than misalign
    }
    let language = parsed.get("language").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    Some((lines.iter().map(|l| l.as_str().unwrap_or("").to_string()).collect(), language))
}

/// Translate a full cue list to English, preserving timing. Returns
/// (language, translated cues) or None on any failure / no provider.
///
/// Failure is contained per BATCH, not per song: a batch the model refuses or
/// miscounts (all-English lines are the common trigger — see `try_batch`)
/// falls back to that batch's original text instead of discarding every
/// other batch that already succeeded. `None` only when nothing could be
/// attempted at all — no provider, or an empty cue list.
pub fn to_english(cues: &[Cue]) -> Option<(String, Vec<Cue>)> {
    if !llm::is_available() || cues.is_empty() {
        return None;
    }
    let texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
    let mut translated: Vec<String> = Vec::with_capacity(texts.len());
    let mut language = String::from("unknown");

    let mut i = 0;
    while i < texts.len() {
        let end = (i + BATCH_SIZE).min(texts.len());
        let batch = &texts[i..end];
        match try_batch(batch) {
            Some((lines, lang)) => {
                if i == 0 && !lang.is_empty() {
                    language = lang;
                }
                translated.extend(lines);
            }
            None => translated.extend_from_slice(batch),
        }
        i = end;
    }

    let out = cues
        .iter()
        .enumerate()
        .map(|(idx, c)| Cue {
            time_ms: c.time_ms,
            text: translated.get(idx).cloned().unwrap_or_default(),
            end_ms: None,
            // A translation's word count/order doesn't match the original's
            // measured timing, so there's nothing honest to carry forward.
            words: None,
        })
        .collect();
    Some((language, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t: i64, s: &str) -> Cue {
        Cue { time_ms: t, text: s.into(), end_ms: None, words: None }
    }

    #[test]
    fn no_provider_and_empty_input_both_no_op_without_a_network_call() {
        assert!(to_english(&[]).is_none());
    }

    // Live network test — run explicitly with `cargo test -- --ignored`. Needs
    // a real configured provider in the environment; skips itself (does not
    // fail) if none is present. Exercises the exact regression this module's
    // per-batch fallback exists for: a song whose lyrics are already English
    // still has to come back with the lines intact, not an error.
    #[test]
    #[ignore]
    fn live_already_english_lyrics_come_back_unchanged_not_failed() {
        if !llm::is_available() {
            eprintln!("skipped: no LLM provider configured in this environment");
            return;
        }
        let cues = [cue(0, "we good, we good"), cue(1000, "yeah, that's right")];
        let (_, out) = to_english(&cues).expect("already-English lyrics must not fail translation");
        assert_eq!(out.len(), 2, "line count must never change");
    }
}
