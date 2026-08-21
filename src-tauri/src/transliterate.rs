//! Devanagari transliteration for romanized Hindi/Urdu lyrics (script, not
//! meaning). A Rust port of `transliterate.js` on the `llm::convert` chain:
//! preserve every word and its order, change only the writing system, keep
//! English words in Latin.

use serde_json::{json, Value};

use crate::llm;
use crate::lyrics::Cue;

const BATCH_SIZE: usize = 60;

const SYSTEM_PROMPT: &str = "You transliterate romanized Hindi/Urdu song lyrics into Devanagari script.\n\n\
Rules:\n\
- TRANSLITERATE, do not translate. Preserve every word and its order exactly.\n\
- Convert Latin-script Hindi/Urdu words to their Devanagari spelling.\n\
- Leave English words, brand names, and Latin-script proper nouns in Latin script.\n\
- Preserve punctuation, casing of retained Latin text, and any bracketed markers.\n\
- If a line is empty or purely instrumental notation, return it unchanged.\n\
- Some or even all of the lines you are given may already be entirely English, with\n\
  nothing Hindi/Urdu to convert. That is not an error and not a reason to comment on\n\
  it or stop: copy each such line through byte-for-byte unchanged, at its own index.\n\
- Never omit, merge, split, reorder, or explain a line, even one that needs no\n\
  change. Never return prose, an apology, or a note instead of the lines array.\n\
- Return EXACTLY as many output lines as input lines, in the same order — this\n\
  holds even when every input line is unchanged.";

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Transliterated lines, same count and order as the input.",
            },
        },
        "required": ["lines"],
        "additionalProperties": false,
    })
}

/// One batch: the network call plus the shape check. `None` on any failure —
/// network error, malformed response, or a count mismatch (e.g. a model that
/// added commentary instead of transliterating a batch it decided was already
/// all-English) — so the caller can fall back to that batch's original,
/// still-readable Latin text rather than losing the whole song over one bad
/// batch.
fn try_batch(batch: &[String]) -> Option<Vec<String>> {
    let user = format!(
        "Transliterate these lyric lines to Devanagari. Return one output line per input line.\n\n{}",
        serde_json::to_string_pretty(&json!({ "lines": batch })).unwrap_or_default()
    );
    let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
    let lines = parsed.get("lines").and_then(|v| v.as_array())?;
    if lines.len() != batch.len() {
        return None;
    }
    Some(lines.iter().map(|l| l.as_str().unwrap_or("").to_string()).collect())
}

/// Transliterate a cue list into Devanagari, preserving timing (incl. endMs).
///
/// Failure is contained per BATCH, not per song: a batch the model refuses or
/// miscounts (all-English lines are the common trigger — see `try_batch`)
/// falls back to that batch's original Latin text instead of discarding every
/// other batch that already succeeded. `None` only when nothing could be
/// attempted at all — no provider, or an empty cue list.
pub fn to_devanagari(cues: &[Cue]) -> Option<Vec<Cue>> {
    if !llm::is_available() || cues.is_empty() {
        return None;
    }
    let texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
    let mut converted: Vec<String> = Vec::with_capacity(texts.len());

    let mut i = 0;
    while i < texts.len() {
        let end = (i + BATCH_SIZE).min(texts.len());
        let batch = &texts[i..end];
        match try_batch(batch) {
            Some(lines) => converted.extend(lines),
            None => converted.extend_from_slice(batch),
        }
        i = end;
    }

    Some(
        cues
            .iter()
            .enumerate()
            .map(|(idx, c)| Cue {
                time_ms: c.time_ms,
                text: converted.get(idx).cloned().unwrap_or_else(|| c.text.clone()),
                end_ms: c.end_ms,
                // The script conversion runs on the whole line, not word by
                // word, so there's no per-word split to attach measured
                // timing to here.
                words: None,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t: i64, s: &str) -> Cue {
        Cue { time_ms: t, text: s.into(), end_ms: None, words: None }
    }

    #[test]
    fn no_provider_and_empty_input_both_no_op_without_a_network_call() {
        assert!(to_devanagari(&[]).is_none());
    }

    // Live network test — run explicitly with `cargo test -- --ignored`. Needs
    // a real configured provider in the environment; skips itself (does not
    // fail) if none is present. Exercises the exact regression this module's
    // per-batch fallback exists for: a batch that is entirely English still
    // has to come back with one output line per input line, not an error.
    #[test]
    #[ignore]
    fn live_all_english_lines_come_back_unchanged_not_failed() {
        if !llm::is_available() {
            eprintln!("skipped: no LLM provider configured in this environment");
            return;
        }
        let cues = [cue(0, "yeah yeah"), cue(1000, "we good, we good")];
        let out = to_devanagari(&cues).expect("an all-English batch must not fail the whole song");
        assert_eq!(out.len(), 2, "line count must never change");
        assert_eq!(out[0].time_ms, 0);
        assert_eq!(out[1].time_ms, 1000);
    }
}
