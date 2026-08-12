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
- Return exactly as many output lines as input lines, in the same order.";

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

/// Transliterate a cue list into Devanagari, preserving timing (incl. endMs).
/// None on any failure / no provider.
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
        let user = format!(
            "Transliterate these lyric lines to Devanagari. Return one output line per input line.\n\n{}",
            serde_json::to_string_pretty(&json!({ "lines": batch })).unwrap_or_default()
        );
        let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;
        let lines = parsed.get("lines").and_then(|v| v.as_array())?;
        if lines.len() != batch.len() {
            return None;
        }
        for l in lines {
            converted.push(l.as_str().unwrap_or("").to_string());
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
            })
            .collect(),
    )
}
