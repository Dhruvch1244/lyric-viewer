//! Provider-neutral LLM layer for structured (JSON) output.
//!
//! A Rust port of `llm.js`. `convert(system, user, schema)` runs a structured
//! JSON conversion on the first configured provider that succeeds, in the same
//! precedence order: Gemini → Groq → HuggingFace. (Claude went through the
//! Node SDK in Electron; it can be added as a raw API call later.) Keys come
//! from environment variables, matching keys.js's env layer.

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

/// Whether any cloud provider is configured.
pub fn is_available() -> bool {
    gemini_key().is_some() || groq_key().is_some() || hf_key().is_some()
}

/// The provider that would answer first, for the renderer's status chip.
pub fn active_provider() -> Option<&'static str> {
    if gemini_key().is_some() {
        Some("gemini")
    } else if groq_key().is_some() {
        Some("groq")
    } else if hf_key().is_some() {
        Some("huggingface")
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

/// Best-effort JSON extraction from a completion that may wrap it in prose or a
/// ```json fence.
fn parse_json_loose(text: &str) -> Result<Value, String> {
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
    Err("unparseable JSON".into())
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
        let model = std::env::var("LYRIC_OVERLAY_GROQ_MODEL").unwrap_or_else(|_| "llama-3.3-70b-versatile".into());
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

    if failures.is_empty() {
        Err("no LLM provider configured".into())
    } else {
        Err(format!("all providers failed: {}", failures.join(" | ")))
    }
}
