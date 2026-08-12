//! Song-sentiment analysis → a mood-driven palette.
//!
//! A Rust port of `sentiment.js` + `paletteFromSentiment`: sample the lyrics,
//! ask the LLM for a mood/hue/saturation/energy, and build the four-stop
//! palette the renderer themes the whole backdrop with. Runs on whichever
//! provider `llm::convert` finds; when none is configured the caller keeps the
//! hash palette from the `track` event.

use serde_json::{json, Value};

use crate::llm;

const SYSTEM_PROMPT: &str = "You are the visual director for a music visualizer. Given a\n\
sample of a song's lyrics, judge the overall emotional sentiment and map it to\n\
visual parameters.\n\n\
Return:\n\
- mood: one or two words for the dominant feeling (e.g. \"melancholic\",\n\
  \"euphoric\", \"aggressive\", \"romantic\", \"chill\", \"dark\", \"triumphant\").\n\
- hue: 0-359, the dominant colour that fits the mood. Rough guide — warm reds/\n\
  oranges for anger/passion, gold/yellow for triumph/joy, green for calm/hope,\n\
  blue for sadness/cool, purple for dreamy/mysterious, magenta for romance.\n\
- saturation: 45-100. Higher for intense or vivid moods, lower for subdued ones.\n\
- energy: 0.0-1.0. 0 for slow/somber, 1 for high-energy/hype.\n\n\
Base the judgement on the lyrics' meaning and tone, not individual words.";

/// The mood result plus its derived palette, ready to emit as a `mood` event.
pub struct Mood {
    pub mood: String,
    pub hue: i64,
    pub energy: f64,
    pub palette: [String; 4],
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mood": { "type": "string" },
            "hue": { "type": "integer" },
            "saturation": { "type": "integer" },
            "energy": { "type": "number" },
        },
        "required": ["mood", "hue", "saturation", "energy"],
        "additionalProperties": false,
    })
}

/// HSL (h 0-359, s/l 0-100) → `#rrggbb`.
fn hsl_hex(h: f64, s: f64, l: f64) -> String {
    let s = s / 100.0;
    let l = l / 100.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", to(r1), to(g1), to(b1))
}

/// Analyse a cue list's sentiment and build the mood payload. Returns None when
/// no provider is configured or the request fails (the caller keeps the wash).
pub fn analyze(cue_texts: &[String]) -> Option<Mood> {
    if !llm::is_available() {
        return None;
    }
    let sample: String = cue_texts
        .iter()
        .filter(|t| !t.trim().is_empty())
        .take(40)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    if sample.is_empty() {
        return None;
    }

    let user = format!(
        "Analyze the sentiment of these lyrics and return the visual parameters.\n\n{sample}"
    );
    let parsed = llm::convert(SYSTEM_PROMPT, &user, &schema()).ok()?;

    let mood = parsed.get("mood").and_then(|v| v.as_str()).unwrap_or("neutral").to_string();
    let hue = (parsed.get("hue").and_then(|v| v.as_f64()).unwrap_or(0.0).round() as i64).clamp(0, 359);
    let sat = (parsed.get("saturation").and_then(|v| v.as_f64()).unwrap_or(70.0).round() as i64).clamp(40, 100);
    let energy = parsed.get("energy").and_then(|v| v.as_f64()).unwrap_or(0.5).clamp(0.0, 1.0);

    let hue2 = ((hue + 40) % 360) as f64;
    let hf = hue as f64;
    let sf = sat as f64;
    let palette = [
        hsl_hex(hf, (sf * 0.7).round(), 9.0),
        hsl_hex(hf, sf, 52.0),
        hsl_hex(hue2, sf, 55.0),
        hsl_hex(hf, (sf + 8.0).min(100.0), 62.0),
    ];

    Some(Mood { mood, hue, energy, palette })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsl_hex_matches_known_values() {
        assert_eq!(hsl_hex(0.0, 100.0, 50.0), "#ff0000");
        assert_eq!(hsl_hex(120.0, 100.0, 50.0), "#00ff00");
        assert_eq!(hsl_hex(240.0, 100.0, 50.0), "#0000ff");
        assert_eq!(hsl_hex(0.0, 0.0, 0.0), "#000000");
    }
}
