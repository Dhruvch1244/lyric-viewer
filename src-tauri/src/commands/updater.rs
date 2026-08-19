//! Auto-update: check GitHub for a newer signed release, download, install,
//! restart. Silent on no-update/no-network — the card only appears when
//! there's something to say. No-ops on the Microsoft Store build (see the
//! `store` feature gating in `run()`), where the Store updates the app itself.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// Last-known auto-update state, mirrored to the renderer's update card.
pub(crate) struct UpdateStore(pub(crate) Mutex<Value>);

/// Check GitHub for a newer signed release; store + emit the result. Silent on
/// no-update / no-network (the card only appears when there is something to say).
pub(crate) fn check_for_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        if let Ok(Some(update)) = updater.check().await {
            let state = json!({ "available": true, "version": update.version, "status": "available" });
            if let Some(st) = app.try_state::<UpdateStore>() {
                *st.0.lock().unwrap() = state.clone();
            }
            let _ = app.emit("update-state", state);
        }
    });
}

/// Download and install the pending update, then restart into it.
fn install_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        if let Ok(Some(update)) = updater.check().await {
            let _ = app.emit("update-state", json!({ "status": "downloading" }));
            if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                app.restart();
            } else {
                let _ = app.emit("update-state", json!({ "status": "error" }));
            }
        }
    });
}

#[tauri::command]
pub(crate) fn get_update_state(store: State<UpdateStore>) -> Value {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
pub(crate) fn update_action(action: String, app: AppHandle) {
    match action.as_str() {
        "check" => check_for_update(app),
        "install" => install_update(app),
        _ => {} // dismiss: nothing to do
    }
}
