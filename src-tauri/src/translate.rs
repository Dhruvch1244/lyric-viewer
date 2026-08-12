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
- Leave lines that are already English essentially unchanged.\n\
- Leave purely instrumental markers or empty lines unchanged.\n\
- Return exactly as many output lines as input lines, in the same order.\n\
- Also report the dominant source language of the lyrics as a lowercase English\n\
  word (e.g. \"hindi\", \"punjabi\", \"english\").";

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

/// Translate a full cue list to English, preserving timing. Returns
/// (language, translated cues) or None on any failure / no provider.
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
        let user = format!(
            "Translate these lyric lines to English. Return one output line per input line.\n\n{}",
            serde_json::to_string_pretty(&json!({ "lines": batch })).unwrap_or_default()
        );
        let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
        let lines = parsed.get("lines").and_then(|v| v.as_array())?;
        if lines.len() != batch.len() {
            return None; // count mismatch — reject rather than misalign
        }
        if i == 0 {
            language = parsed.get("language").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        }
        for l in lines {
            translated.push(l.as_str().unwrap_or("").to_string());
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
        })
        .collect();
    Some((language, out))
}
