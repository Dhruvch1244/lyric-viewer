//! The MilkDrop preset corpus + preview thumbnails.
//!
//! A Rust port of `presetlib.js`. The presets ship as files inside the frontend
//! bundle (src/renderer/vendor/presets), so here they are read through Tauri's
//! asset resolver — which serves the embedded assets in a build and the files on
//! disk in dev — and handed to the renderer over IPC, keeping the engine frame's
//! `connect-src 'none'` boundary intact. A name is never turned into a path: the
//! index maps names to numbered files, so a lookup is a table hit.

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Read an embedded frontend asset as text (index.json, a preset file).
fn asset_text(app: &AppHandle, path: &str) -> Option<String> {
    let asset = app.asset_resolver().get(path.to_string())?;
    String::from_utf8(asset.bytes).ok()
}

/// Parse the preset index once per call: name → filename.
fn index(app: &AppHandle) -> Vec<(String, String)> {
    let Some(text) = asset_text(app, "vendor/presets/index.json") else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    json.get("presets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let name = p.get("name").and_then(|v| v.as_str())?;
                    let file = p.get("file").and_then(|v| v.as_str())?;
                    Some((name.to_string(), file.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Every preset name, sorted.
pub fn catalogue(app: &AppHandle) -> Vec<String> {
    let mut names: Vec<String> = index(app).into_iter().map(|(n, _)| n).collect();
    names.sort_by_key(|a| a.to_lowercase());
    names
}

/// One preset, parsed. None when the name is unknown or the file is broken.
pub fn preset(app: &AppHandle, name: &str) -> Option<Value> {
    let file = index(app).into_iter().find(|(n, _)| n == name).map(|(_, f)| f)?;
    let text = asset_text(app, &format!("vendor/presets/{file}"))?;
    serde_json::from_str(&text).ok()
}

// ------------------------------------------------------------- thumbnails

/// Stable filename for a preset's cached preview (a name is not a path).
fn thumb_key(name: &str) -> String {
    let mut hash: u64 = 1469598103934665603; // FNV-1a
    for b in name.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:016x}")
}

fn thumbs_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("thumbs");
    Some(dir)
}

/// Data URIs for whichever of `names` have a rendered preview, keyed by name.
pub fn thumbs_get(app: &AppHandle, names: &[String]) -> Value {
    let mut out = serde_json::Map::new();
    let Some(dir) = thumbs_dir(app) else { return Value::Object(out) };
    for name in names {
        let path = dir.join(format!("{}.jpg", thumb_key(name)));
        if let Ok(bytes) = std::fs::read(&path) {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            out.insert(name.clone(), Value::String(format!("data:image/jpeg;base64,{b64}")));
        }
    }
    Value::Object(out)
}

/// Store a rendered preview (canvas.toDataURL('image/jpeg')). Returns success.
pub fn thumb_put(app: &AppHandle, name: &str, data_url: &str) -> bool {
    let prefix = "data:image/jpeg;base64,";
    let Some(b64) = data_url.strip_prefix(prefix) else { return false };
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else { return false };
    let Some(dir) = thumbs_dir(app) else { return false };
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    std::fs::write(dir.join(format!("{}.jpg", thumb_key(name))), bytes).is_ok()
}

/// Throw away every rendered preview.
pub fn thumbs_clear(app: &AppHandle) -> bool {
    let Some(dir) = thumbs_dir(app) else { return false };
    std::fs::remove_dir_all(&dir).is_ok()
}
