//! Consent gate for the one-time Whisper/Silero model download (`models.rs`,
//! ~82MB across 6 files) — asked before the download starts, not after.
//!
//! Before this, `models::ensure` just ran on the first transcription with no
//! prompt and (a separate bug, now fixed) no visible progress either, so a
//! fresh install's first attempt to auto-transcribe an unsynced song spent
//! however long an 82MB fetch takes with nothing on screen saying why.
//!
//! Mirrors `localcli.rs`'s `Consent` shape: a real "no" is remembered and
//! distinct from "never asked", so declining once does not mean being asked
//! again on every subsequent unsynced song.

use std::sync::mpsc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
struct Consent {
    decided: bool,
    consented: bool,
}

fn consent_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("model-consent.json"))
}

fn load(app: &AppHandle) -> Consent {
    consent_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, c: &Consent) {
    let Some(path) = consent_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(c) {
        let _ = std::fs::write(path, s);
    }
}

/// The one outstanding question, if any. Only ever one at a time in
/// practice — every caller of `allow` runs on `Lane::Inference`, which is
/// concurrency-1 by design (two transcriptions at once would thrash cache
/// and memory for no throughput gain), so there is never a second download
/// actually racing this one to ask.
static PENDING: Mutex<Option<mpsc::Sender<bool>>> = Mutex::new(None);

/// How long to hold the Inference-lane thread open waiting for an answer.
/// Generous on purpose — the lane already blocks for the length of a whole
/// Whisper decode (models.rs's own doc comment says as much about the
/// download itself), and a person choosing whether to allow an 82MB fetch
/// may not be looking at the screen the moment it asks.
const ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Block until the model download is allowed to proceed. Returns instantly
/// (no prompt) if a real decision is already on record, or if `missing` is
/// empty — the point is to ask about the DOWNLOAD, not to nag before every
/// transcription forever once the files are already on disk.
///
/// A timeout with no answer resolves to `false` WITHOUT persisting a
/// decision — treated the same as "not now", so it asks again next time
/// rather than silently turning an unanswered prompt into a permanent no.
pub(crate) fn allow(app: &AppHandle, missing: &[(&'static str, u64)]) -> bool {
    if missing.is_empty() {
        return true;
    }
    let c = load(app);
    if c.decided {
        return c.consented;
    }

    let (tx, rx) = mpsc::channel();
    *PENDING.lock().unwrap() = Some(tx);

    let total: u64 = missing.iter().map(|(_, s)| s).sum();
    let _ = app.emit(
        "model-consent-needed",
        json!({
            "totalBytes": total,
            "files": missing.iter().map(|(name, size)| json!({ "name": name, "size": size })).collect::<Vec<_>>(),
        }),
    );

    rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or(false)
}

/// The renderer's answer to a pending (or already-timed-out) prompt.
/// `remember` persists it so `allow` never asks again; answering without
/// remembering ("just this once") leaves the next unsynced song to ask fresh.
pub(crate) fn answer(app: &AppHandle, consent: bool, remember: bool) {
    if remember {
        save(app, &Consent { decided: true, consented: consent });
    }
    if let Some(tx) = PENDING.lock().unwrap().take() {
        let _ = tx.send(consent);
    }
}

/// Read-only status for callers that have no `PENDING` sender to block on —
/// namely the WebView/WASM fallback path (`whisper.js`/`demucs.js`), which
/// downloads its own models independently of `models.rs` and so never goes
/// through `allow` above. The renderer uses this to decide whether its
/// proactive cache warm-up may run silently (already consented), must stay
/// quiet (already declined), or needs to ask for real at the point a
/// transcription is actually attempted (never decided).
#[tauri::command]
pub(crate) fn get_model_consent_status(app: AppHandle) -> serde_json::Value {
    let c = load(&app);
    json!({ "decided": c.decided, "consented": c.consented })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_consent_is_neither_decided_nor_consented() {
        let c = Consent::default();
        assert!(!c.decided);
        assert!(!c.consented);
    }
}
