//! Spotify OAuth connect + playlist import, thin wrappers over spotify.rs's
//! PKCE/HTTP logic.

use serde_json::{json, Value};
use tauri::State;

/// Whether a Spotify session is live and a client ID is even configured —
/// lets the UI show "connect" vs "import" without guessing.
#[tauri::command]
pub(crate) fn spotify_status(state: State<crate::spotify::TokenState>) -> Value {
    let has_client_id = std::env::var("SPOTIFY_CLIENT_ID").map(|s| !s.trim().is_empty()).unwrap_or(false);
    let connected = state.lock().unwrap().as_ref().map(|t| t.expires_at > std::time::Instant::now()).unwrap_or(false);
    json!({ "hasClientId": has_client_id, "connected": connected })
}

/// Run the PKCE + loopback + browser sign-in flow. Blocks the async call
/// (up to a few minutes) waiting on the user's browser — that's expected for
/// a user-initiated "connect to Spotify" click, not a bug.
#[tauri::command]
pub(crate) fn spotify_authorize(app: tauri::AppHandle, state: State<crate::spotify::TokenState>) -> Value {
    match crate::spotify::authorize(&app) {
        Ok(token) => {
            *state.lock().unwrap() = Some(token);
            json!({ "status": "ok" })
        }
        Err(e) => json!({ "status": "error", "message": e }),
    }
}

#[tauri::command]
pub(crate) fn spotify_playlists(state: State<crate::spotify::TokenState>) -> Value {
    let guard = state.lock().unwrap();
    let Some(token) = guard.as_ref() else {
        return json!({ "status": "error", "message": "not connected" });
    };
    match crate::spotify::list_playlists(token) {
        Ok(playlists) => json!({ "status": "ok", "playlists": playlists }),
        Err(e) => json!({ "status": "error", "message": e }),
    }
}

/// A playlist's tracks as "Artist - Title" text, ready to paste straight into
/// the pre-sync textarea (or hand directly to `presync_list`).
#[tauri::command]
pub(crate) fn spotify_playlist_tracks(playlist_id: String, state: State<crate::spotify::TokenState>) -> Value {
    let guard = state.lock().unwrap();
    let Some(token) = guard.as_ref() else {
        return json!({ "status": "error", "message": "not connected" });
    };
    match crate::spotify::playlist_tracks_as_text(token, &playlist_id) {
        Ok(text) => json!({ "status": "ok", "text": text }),
        Err(e) => json!({ "status": "error", "message": e }),
    }
}
