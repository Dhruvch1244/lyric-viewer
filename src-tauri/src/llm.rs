//! Provider-neutral LLM layer for structured (JSON) output.
//!
//! A Rust port of `llm.js`. `convert(system, user, schema)` runs a structured
//! JSON conversion on the first configured provider that succeeds, in the same
//! precedence order as the old Electron build: Gemini → Groq → HuggingFace →
//! Claude, then a consented local CLI last. Claude went through the Node SDK
//! in Electron and was left as a raw-API TODO through the first cut of this
//! port — `call_anthropic` below is that gap closed, using the Messages API
//! directly. Keys come from environment variables, matching keys.js's env layer.

use serde_json::{json, Value};

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn env_any(names: &[&str]) -> Option<String> {
    for n in names {
        if let Ok(v) = std::env::var(n) {
            if !v.trim().is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn gemini_key() -> Option<String> {
    env_any(&["GEMINI_API_KEY", "GOOGLE_API_KEY"])
}
fn groq_key() -> Option<String> {
    env_any(&["GROQ_API_KEY"])
}
fn hf_key() -> Option<String> {
    env_any(&["HF_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN"])
}
fn anthropic_key() -> Option<String> {
    env_any(&["ANTHROPIC_API_KEY"])
}

/// Whether any provider — a cloud key or a consented local CLI — can run.
pub fn is_available() -> bool {
    gemini_key().is_some()
        || groq_key().is_some()
        || hf_key().is_some()
        || anthropic_key().is_some()
        || crate::localcli::is_ready()
}

/// The provider that would answer first, for the renderer's status chip.
pub fn active_provider() -> Option<&'static str> {
    if gemini_key().is_some() {
        Some("gemini")
    } else if groq_key().is_some() {
        Some("groq")
    } else if hf_key().is_some() {
        Some("huggingface")
    } else if anthropic_key().is_some() {
        Some("claude")
    } else {
        None
    }
}

/// Translate a draft JSON Schema into Gemini's dialect: UPPERCASE type names,
/// drop keys it rejects (additionalProperties), recurse into properties/items.
fn to_gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                match k.as_str() {
                    "additionalProperties" => {}
                    "type" => {
                        if let Some(s) = v.as_str() {
                            out.insert("type".into(), json!(s.to_uppercase()));
                        } else {
                            out.insert(k.clone(), v.clone());
                        }
                    }
                    "properties" => {
                        if let Some(props) = v.as_object() {
                            let mapped: serde_json::Map<String, Value> = props
                                .iter()
                                .map(|(pk, pv)| (pk.clone(), to_gemini_schema(pv)))
                                .collect();
                            out.insert("properties".into(), Value::Object(mapped));
                        } else {
                            out.insert(k.clone(), v.clone());
                        }
                    }
                    "items" => {
                        out.insert("items".into(), to_gemini_schema(v));
                    }
                    _ => {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn call_gemini(system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let key = gemini_key().ok_or("no gemini key")?;
    let model = std::env::var("LYRIC_OVERLAY_GEMINI_MODEL").unwrap_or_else(|_| "gemini-flash-latest".into());
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");

    let body = json!({
        "system_instruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": user }] }],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseSchema": to_gemini_schema(schema),
        },
    });

    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("X-goog-api-key", &key)
        .timeout(TIMEOUT)
        .send_json(body);

    let data: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("gemini decode: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("gemini {code}: {}", detail.chars().take(200).collect::<String>()));
        }
        Err(e) => return Err(format!("gemini transport: {e}")),
    };

    if let Some(reason) = data.pointer("/promptFeedback/blockReason").and_then(|v| v.as_str()) {
        return Err(format!("gemini blocked: {reason}"));
    }
    let text = data
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<String>()
        })
        .unwrap_or_default();
    if text.is_empty() {
        return Err("gemini empty response".into());
    }
    serde_json::from_str(&text).map_err(|_| "gemini unparseable JSON".into())
}

/// OpenAI-compatible chat providers (Groq, HuggingFace router) share a shape.
fn call_openai_compatible(url: &str, model: &str, key: &str, system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let sys = format!(
        "{system}\n\nReturn ONLY a JSON object that conforms to this JSON Schema (no markdown, no commentary):\n{schema}"
    );
    let body = json!({
        "model": model,
        "temperature": 0.2,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": sys },
            { "role": "user", "content": user },
        ],
    });
    let resp = ureq::post(url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(TIMEOUT)
        .send_json(body);
    let data: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("decode: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("{code}: {}", detail.chars().take(200).collect::<String>()));
        }
        Err(e) => return Err(format!("transport: {e}")),
    };
    let text = data
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    parse_json_loose(text)
}

/// Claude via the Messages API directly — no SDK, since Electron's Node SDK
/// dependency doesn't carry over to a Rust binary. Anthropic has no
/// `response_format`/JSON-mode knob the way the OpenAI-compatible providers
/// above do, so the schema is asked for in the system prompt and the reply is
/// parsed the same best-effort way as Groq/HF's completions.
fn call_anthropic(system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let key = anthropic_key().ok_or("no anthropic key")?;
    let model = std::env::var("LYRIC_OVERLAY_ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into());
    let sys = format!(
        "{system}\n\nReturn ONLY a JSON object that conforms to this JSON Schema (no markdown, no commentary):\n{schema}"
    );
    let body = json!({
        "model": model,
        "max_tokens": 8192,
        "temperature": 0.2,
        "system": sys,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("Content-Type", "application/json")
        .set("x-api-key", &key)
        .set("anthropic-version", "2023-06-01")
        .timeout(TIMEOUT)
        .send_json(body);
    let data: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("anthropic decode: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("anthropic {code}: {}", detail.chars().take(200).collect::<String>()));
        }
        Err(e) => return Err(format!("anthropic transport: {e}")),
    };
    let text = data
        .pointer("/content/0/text")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    parse_json_loose(text)
}

/// Best-effort JSON extraction from a completion that may wrap it in prose or a
/// ```json fence. `pub(crate)` so `localcli.rs` can reuse it for CLI output,
/// which has the same no-structured-output problem as the chat APIs below.
///
/// **The error carries what was actually received**, and that is the point of
/// it. A bare "unparseable JSON" is unactionable: the overwhelmingly common
/// cause is not malformed JSON at all but a tool answering in prose — a usage
/// limit, a login prompt, a refusal — and every one of those says so plainly
/// in the text that used to be discarded. Quoting it turns "unparseable JSON"
/// into "claude said: usage limit reached", which the user can act on.
pub(crate) fn parse_json_loose(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    let unfenced = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let (Some(start), Some(end)) = (unfenced.find('{'), unfenced.rfind('}')) {
        if end > start {
            if let Ok(v) = serde_json::from_str::<Value>(&unfenced[start..=end]) {
                return Ok(v);
            }
        }
    }
    // Streaming CLIs emit one JSON value per line, sometimes after a banner.
    // Take the last line that parses to an object — the earlier ones are
    // progress envelopes.
    if let Some(v) = unfenced
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(|v| v.is_object())
    {
        return Ok(v);
    }
    Err(describe_non_json(trimmed))
}

/// Turn a non-JSON reply into something worth showing a user.
///
/// Recognises the handful of plain-text answers a CLI actually gives instead
/// of JSON. Anything unrecognised is quoted rather than summarised, because a
/// message nobody anticipated is exactly the one worth seeing verbatim.
fn describe_non_json(text: &str) -> String {
    if text.is_empty() {
        return "returned nothing at all (no output on stdout)".into();
    }
    let low = text.to_lowercase();
    let hint = if low.contains("usage limit") || low.contains("rate limit") || low.contains("quota") {
        Some("its usage limit is reached — try again later, or set a cloud API key in Settings")
    } else if low.contains("not logged in") || low.contains("please log in") || low.contains("/login") || low.contains("authentication")
    {
        Some("it is not logged in — sign in with that tool once in a terminal, then retry")
    } else if low.contains("command not found") || low.contains("is not recognized") {
        Some("the command could not be run — check it is still installed and on PATH")
    } else {
        None
    };

    // One line, collapsed: CLI banners are often several lines of decoration
    // around one sentence that matters.
    let snippet: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    match hint {
        Some(h) => format!("answered in prose, not JSON — {h}. It said: \"{snippet}\""),
        None => format!("answered in prose, not JSON. It said: \"{snippet}\""),
    }
}

/// Run a structured JSON conversion on the first provider that succeeds.
pub fn convert(system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let mut failures = Vec::new();

    if gemini_key().is_some() {
        match call_gemini(system, user, schema) {
            Ok(v) => return Ok(v),
            Err(e) => failures.push(format!("gemini: {e}")),
        }
    }
    if let Some(key) = groq_key() {
        // gpt-oss-120b: Groq's production-tier flagship as of 2026-08 — cheaper
        // and faster than llama-3.3-70b-versatile at the same 131K context
        // (console.groq.com/docs/models), and a better fit for a knowledge-
        // heavy task like "which artist sings this line" than the smaller model.
        let model = std::env::var("LYRIC_OVERLAY_GROQ_MODEL").unwrap_or_else(|_| "openai/gpt-oss-120b".into());
        match call_openai_compatible("https://api.groq.com/openai/v1/chat/completions", &model, &key, system, user, schema) {
            Ok(v) => return Ok(v),
            Err(e) => failures.push(format!("groq: {e}")),
        }
    }
    if let Some(key) = hf_key() {
        let model = std::env::var("LYRIC_OVERLAY_HF_MODEL").unwrap_or_else(|_| "meta-llama/Llama-3.3-70B-Instruct".into());
        match call_openai_compatible("https://router.huggingface.co/v1/chat/completions", &model, &key, system, user, schema) {
            Ok(v) => return Ok(v),
            Err(e) => failures.push(format!("hf: {e}")),
        }
    }
    if anthropic_key().is_some() {
        match call_anthropic(system, user, schema) {
            Ok(v) => return Ok(v),
            Err(e) => failures.push(format!("claude: {e}")),
        }
    }

    // The local CLI goes last, on purpose: it spends the user's own machine
    // or tokens, so a cloud key they configured is tried first. It only
    // appears once they have explicitly consented to one (see localcli.rs).
    if crate::localcli::is_ready() {
        match crate::localcli::call(system, user, schema) {
            Ok(v) => return Ok(v),
            Err(e) => failures.push(format!("local-cli: {e}")),
        }
    }

    // Every configured provider — cloud and a consented local CLI, if any —
    // just failed or none exists. This is exactly the moment offering the
    // local-CLI fallback is useful, rather than a startup nag; a no-op if
    // one's already consented, declined, or was already offered this session.
    crate::maybe_offer_localcli();

    if failures.is_empty() {
        Err("no LLM provider configured".into())
    } else {
        Err(format!("all providers failed: {}", failures.join(" | ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_json_parses() {
        assert_eq!(parse_json_loose(r#"{"a":1}"#).unwrap()["a"], 1);
    }

    #[test]
    fn a_fenced_block_parses() {
        let v = parse_json_loose("```json\n{\"a\":2}\n```").unwrap();
        assert_eq!(v["a"], 2);
    }

    #[test]
    fn json_wrapped_in_prose_parses() {
        let v = parse_json_loose("Sure! Here you go:\n{\"a\":3}\nHope that helps.").unwrap();
        assert_eq!(v["a"], 3);
    }

    #[test]
    fn nested_objects_survive_the_brace_scan() {
        // first-{ to last-} has to keep the whole structure, not the inner one.
        let v = parse_json_loose("noise {\"outer\":{\"inner\":[1,2]}} noise").unwrap();
        assert_eq!(v["outer"]["inner"][1], 2);
    }

    #[test]
    fn a_streaming_cli_envelope_yields_the_last_object() {
        // Some CLIs print progress objects per line before the real answer.
        let out = "{\"type\":\"start\"}\n{\"type\":\"progress\"}\n{\"lines\":[\"x\"]}";
        assert_eq!(parse_json_loose(out).unwrap()["lines"][0], "x");
    }

    /* -- the failures that used to all say "unparseable JSON" -- */

    #[test]
    fn a_usage_limit_says_so_and_says_what_to_do() {
        let e = parse_json_loose("Claude usage limit reached. Your limit will reset at 3pm.").unwrap_err();
        assert!(e.contains("usage limit is reached"), "{e}");
        assert!(e.contains("Settings"), "should point at the escape hatch: {e}");
        assert!(e.contains("reset at 3pm"), "the tool's own words must survive: {e}");
    }

    #[test]
    fn a_login_prompt_says_so() {
        let e = parse_json_loose("You are not logged in. Run /login to continue.").unwrap_err();
        assert!(e.contains("not logged in"), "{e}");
    }

    #[test]
    fn a_missing_command_says_so() {
        let e = parse_json_loose("'claude' is not recognized as an internal or external command").unwrap_err();
        assert!(e.contains("could not be run"), "{e}");
    }

    #[test]
    fn empty_output_is_distinguished_from_bad_output() {
        // "printed nothing" and "printed the wrong thing" need different fixes.
        let e = parse_json_loose("   \n  ").unwrap_err();
        assert!(e.contains("nothing at all"), "{e}");
    }

    #[test]
    fn an_unrecognised_reply_is_quoted_verbatim() {
        // The whole point: a message nobody anticipated is the one worth seeing.
        let e = parse_json_loose("I cannot help with that request.").unwrap_err();
        assert!(e.contains("I cannot help with that request"), "{e}");
    }

    #[test]
    fn a_long_reply_is_truncated_rather_than_flooding_the_ui() {
        let e = parse_json_loose(&"x".repeat(5000)).unwrap_err();
        assert!(e.len() < 400, "error was {} chars", e.len());
    }

    #[test]
    fn multi_line_banners_collapse_to_one_line() {
        let e = parse_json_loose("Banner\n\n   Something\n   went wrong\n").unwrap_err();
        assert!(!e.contains('\n'), "errors go into a one-line status chip: {e:?}");
    }
}
