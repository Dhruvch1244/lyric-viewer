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

/// What a download is *for*. Consent is per-purpose because the sizes are not
/// comparable — the speech set is ~82MB, vocal isolation alone is 165MB — and
/// a prompt that says "Whisper + a voice detector" cannot stand in for one
/// that fetches a source-separation model.
pub(crate) const PURPOSE_SPEECH: &str = "speech";
pub(crate) const PURPOSE_DIARIZATION: &str = "diarization";
pub(crate) const PURPOSE_ISOLATION: &str = "isolation";

#[derive(Serialize, Deserialize, Clone, Default)]
struct Consent {
    decided: bool,
    consented: bool,
}

/// On-disk shape.
///
/// The two legacy fields are load-bearing, not clutter: before purposes
/// existed this file was a bare `{"decided":true,"consented":true}`, and
/// anyone who has already allowed the speech download has one. Reading it as
/// the speech purpose means an upgrade does not re-ask a question the user has
/// already answered. New writes populate `purposes`; the legacy fields are
/// preserved as read so a downgrade also keeps working.
#[derive(Serialize, Deserialize, Clone, Default)]
struct ConsentFile {
    #[serde(default)]
    decided: bool,
    #[serde(default)]
    consented: bool,
    #[serde(default)]
    purposes: std::collections::BTreeMap<String, Consent>,
}

impl ConsentFile {
    fn get(&self, purpose: &str) -> Consent {
        if let Some(c) = self.purposes.get(purpose) {
            return c.clone();
        }
        if purpose == PURPOSE_SPEECH && self.decided {
            return Consent { decided: true, consented: self.consented };
        }
        Consent::default()
    }

    fn set(&mut self, purpose: &str, c: Consent) {
        if purpose == PURPOSE_SPEECH {
            // Keep the legacy pair in step, so an older build reading this
            // file still sees the speech decision.
            self.decided = c.decided;
            self.consented = c.consented;
        }
        self.purposes.insert(purpose.to_string(), c);
    }
}

fn consent_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("model-consent.json"))
}

fn load_file(app: &AppHandle) -> ConsentFile {
    consent_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn load(app: &AppHandle, purpose: &str) -> Consent {
    load_file(app).get(purpose)
}

fn save(app: &AppHandle, purpose: &str, c: &Consent) {
    let Some(path) = consent_path(app) else { return };
    let mut file = load_file(app);
    file.set(purpose, c.clone());
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(&file) {
        let _ = std::fs::write(path, s);
    }
}

/// The one outstanding question, if any. Only ever one at a time in
/// practice — every caller of `allow` runs on `Lane::Inference`, which is
/// concurrency-1 by design (two transcriptions at once would thrash cache
/// and memory for no throughput gain), so there is never a second download
/// actually racing this one to ask.
static PENDING: Mutex<Option<(String, mpsc::Sender<bool>)>> = Mutex::new(None);

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
pub(crate) fn allow(app: &AppHandle, purpose: &str, missing: &[(&'static str, u64)]) -> bool {
    if missing.is_empty() {
        return true;
    }
    let c = load(app, purpose);
    if c.decided {
        return c.consented;
    }

    let (tx, rx) = mpsc::channel();
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((purpose.to_string(), tx));

    let total: u64 = missing.iter().map(|(_, s)| s).sum();
    let _ = app.emit(
        "model-consent-needed",
        json!({
            "purpose": purpose,
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
    // The purpose comes from whichever prompt is outstanding, not from the
    // renderer — the answer has to be recorded against the question that was
    // actually asked, and only this side knows what that was.
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take();
    let purpose = pending.as_ref().map(|(p, _)| p.clone()).unwrap_or_else(|| PURPOSE_SPEECH.to_string());
    if remember {
        save(app, &purpose, &Consent { decided: true, consented: consent });
    }
    if let Some((_, tx)) = pending {
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
    // Defaults to speech: the only caller is the WebView Whisper fallback's
    // warm-up, which downloads speech models and nothing else.
    let c = load(&app, PURPOSE_SPEECH);
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

    #[test]
    fn a_pre_purposes_file_still_answers_for_speech() {
        // The upgrade path that matters: anyone who already allowed the
        // speech download has a bare {decided, consented} file. Re-asking
        // them would be a regression, and a silent one.
        let file: ConsentFile = serde_json::from_str(r#"{"decided":true,"consented":true}"#).expect("legacy shape must parse");
        let speech = file.get(PURPOSE_SPEECH);
        assert!(speech.decided && speech.consented);
    }

    #[test]
    fn a_pre_purposes_file_says_nothing_about_the_other_downloads() {
        // Consenting to 82MB of Whisper is not consent to 165MB of Demucs.
        let file: ConsentFile = serde_json::from_str(r#"{"decided":true,"consented":true}"#).unwrap();
        assert!(!file.get(PURPOSE_ISOLATION).decided);
        assert!(!file.get(PURPOSE_DIARIZATION).decided);
    }

    #[test]
    fn a_remembered_no_is_kept_apart_from_never_having_asked() {
        let mut file = ConsentFile::default();
        file.set(PURPOSE_ISOLATION, Consent { decided: true, consented: false });
        let c = file.get(PURPOSE_ISOLATION);
        assert!(c.decided, "a real no must not read as unasked");
        assert!(!c.consented);
    }

    #[test]
    fn purposes_do_not_leak_into_each_other() {
        let mut file = ConsentFile::default();
        file.set(PURPOSE_ISOLATION, Consent { decided: true, consented: true });
        assert!(!file.get(PURPOSE_DIARIZATION).decided);
        assert!(!file.get(PURPOSE_SPEECH).decided);
    }

    #[test]
    fn answering_speech_keeps_the_legacy_fields_in_step() {
        // So a rolled-back build still sees the decision.
        let mut file = ConsentFile::default();
        file.set(PURPOSE_SPEECH, Consent { decided: true, consented: true });
        assert!(file.decided && file.consented);

        // ...and a non-speech purpose must not touch them.
        let mut other = ConsentFile::default();
        other.set(PURPOSE_ISOLATION, Consent { decided: true, consented: true });
        assert!(!other.decided, "isolation consent must not masquerade as speech consent");
    }

    #[test]
    fn a_written_file_round_trips_through_json() {
        let mut file = ConsentFile::default();
        file.set(PURPOSE_SPEECH, Consent { decided: true, consented: true });
        file.set(PURPOSE_ISOLATION, Consent { decided: true, consented: false });
        let text = serde_json::to_string(&file).unwrap();
        let back: ConsentFile = serde_json::from_str(&text).unwrap();
        assert!(back.get(PURPOSE_SPEECH).consented);
        assert!(back.get(PURPOSE_ISOLATION).decided && !back.get(PURPOSE_ISOLATION).consented);
    }
}
