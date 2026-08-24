//! Auto-update: check GitHub for a newer signed release, download + install
//! it silently in the background, then prompt only once it is actually ready
//! to restart into — never a "click to start downloading" step (the update
//! card's own copy, "is downloaded and ready. Restart now", says as much;
//! that copy did not match what the code before this fix actually did).
//! No-ops on the Microsoft Store build (see the `store` feature gating in
//! `run()`), where the Store updates the app itself.
//!
//! State shape sent to the renderer is `{phase, version?, percent?, prompt}`
//! — see onboarding-cards.js's `applyUpdateState` for the contract it reads.
//! `prompt` is decided here, not just mirrored from "an update exists", so a
//! dismissal survives a renderer reload (changing display mode reloads it,
//! but this state lives in the Rust process and does not).

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::Update;

/// Last-known auto-update state, mirrored to the renderer's update card.
pub(crate) struct UpdateStore(pub(crate) Mutex<Value>);

/// Store the new state and emit it, poison-safe — a panic elsewhere while
/// this lock is held must not turn "an update is available" into "the
/// updater is permanently broken until restart".
fn set_state(app: &AppHandle, state: Value) {
    if let Some(st) = app.try_state::<UpdateStore>() {
        let mut guard = st.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = state.clone();
    }
    let _ = app.emit("update-state", state);
}

/// Check GitHub for a newer signed release. Silent on no-update / no-network
/// (nothing to say). On finding one, downloads and installs it in the
/// background immediately — no user action gates this, only the restart
/// does — reporting progress via the small pill the whole time.
pub(crate) fn check_for_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        match updater.check().await {
            Ok(Some(update)) => download_and_install(app, update).await,
            Ok(None) => {} // already up to date — nothing to say
            Err(e) => {
                // Expected to fail often and silently (no network, GitHub
                // unreachable) — that's the documented behaviour above. Just
                // don't let a real cause vanish without a trace if someone
                // does go looking.
                log::warn!("update check failed: {e}");
            }
        }
    });
}

/// Download + install in the background, reporting real progress via the
/// SDK's own chunk callback. On success the update is on disk and only a
/// restart is needed — `prompt` goes true so the card can say so. On
/// failure, logs the actual error (previously discarded entirely, `.is_ok()`
/// only) so a real-world failure has something to debug against.
async fn download_and_install(app: AppHandle, update: Update) {
    let version = update.version.clone();
    set_state(&app, json!({ "phase": "downloading", "version": version, "percent": 0, "prompt": false }));

    let downloaded = Mutex::new(0usize);
    let app_for_progress = app.clone();
    let version_for_progress = version.clone();
    let result = update
        .download_and_install(
            move |chunk_len, content_len| {
                let mut total = downloaded.lock().unwrap_or_else(|e| e.into_inner());
                *total += chunk_len;
                let percent = content_len
                    .filter(|&len| len > 0)
                    .map(|len| ((*total as f64 / len as f64) * 100.0).min(99.0) as u32)
                    .unwrap_or(0);
                set_state(
                    &app_for_progress,
                    json!({ "phase": "downloading", "version": version_for_progress, "percent": percent, "prompt": false }),
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => set_state(&app, json!({ "phase": "ready", "version": version, "prompt": true })),
        Err(e) => {
            let message = format!("update install failed ({version}): {e}");
            log::error!("{message}");
            crate::crashlog::append_backend_error(&app, &message);
            set_state(&app, json!({ "phase": "error", "version": version, "prompt": false }));
        }
    }
}

#[tauri::command]
pub(crate) fn get_update_state(store: State<UpdateStore>) -> Value {
    store.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub(crate) fn update_action(action: String, app: AppHandle) {
    match action.as_str() {
        "check" => check_for_update(app),
        "install" => {
            // Nothing left to download by the time this fires — the install
            // already happened silently in the background (see module doc).
            // Only restart if the store actually says "ready", so a stray or
            // double click can't restart into a half-finished state.
            let ready = app
                .try_state::<UpdateStore>()
                .map(|st| {
                    let guard = st.0.lock().unwrap_or_else(|e| e.into_inner());
                    guard.get("phase").and_then(Value::as_str) == Some("ready")
                })
                .unwrap_or(false);
            if ready {
                app.restart();
            }
        }
        "dismiss" => {
            // Keep phase/version (so re-opening the app still knows what was
            // pending) but drop prompt so the card stays gone across a
            // display-mode reload within this session — see the module doc.
            if let Some(st) = app.try_state::<UpdateStore>() {
                let mut guard = st.0.lock().unwrap_or_else(|e| e.into_inner());
                if let Value::Object(ref mut map) = *guard {
                    map.insert("prompt".to_string(), Value::Bool(false));
                }
            }
        }
        _ => {}
    }
}
