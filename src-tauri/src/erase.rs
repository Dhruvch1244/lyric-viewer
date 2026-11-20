//! "Erase all my data" — the one control that makes the privacy policy's
//! "clear the app's data from within the app" literally true.
//!
//! WHY A MARKER AND A RESTART, NOT A DELETE IN PLACE. While the app runs it
//! holds files open in the very directory being wiped: the SQLite journal
//! (WAL + shm), the listening log, possibly a sidecar's temp file. On Windows
//! an open file cannot be deleted, so an in-place `remove_dir_all` would fail
//! half way and leave a partial wipe — the worst outcome for a privacy
//! control, because it *looks* done. Instead the command drops a marker and
//! restarts; `apply_pending` runs first thing in `setup`, before the journal,
//! prefs, keys or anything else has opened a file, and deletes everything.
//!
//! WHAT IS ERASED. Every entry under `app_config_dir` (caches, prefs, API
//! keys, listening history, play history, crash log, downloaded models and
//! videos, the journal) and `app_cache_dir` (staged updates). The WebView's
//! own storage (localStorage, IndexedDB, Cache Storage) is cleared by the
//! renderer before it calls in — it is the one store this side can't safely
//! reach while the WebView that owns it is alive.
//!
//! THE GUARD. A recursive delete driven by a path the OS handed back deserves
//! a check: the directory must be named after this app's bundle identifier,
//! so a misconfigured path resolver can never point this at a home directory.

use std::path::Path;

use tauri::{AppHandle, Manager};

const MARKER: &str = ".erase-pending";

fn guarded(dir: &Path, identifier: &str) -> bool {
    dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == identifier)
}

fn wipe_dir(dir: &Path, identifier: &str) {
    if !guarded(dir, identifier) {
        log::warn!("erase: refusing to wipe {} (not the app's own directory)", dir.display());
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
    }
}

/// Run at the very top of `setup`. A no-op unless the previous session asked
/// for an erase.
pub fn apply_pending(app: &AppHandle) {
    let id = app.config().identifier.clone();
    let Ok(config) = app.path().app_config_dir() else { return };
    if !config.join(MARKER).exists() {
        return;
    }
    wipe_dir(&config, &id);
    if let Ok(cache) = app.path().app_cache_dir() {
        wipe_dir(&cache, &id);
    }
    // Belt and braces: if the guard refused, still drop the marker so a bad
    // path can't turn every launch into an erase attempt.
    let _ = std::fs::remove_file(config.join(MARKER));
}

/// Mark the data for erasure and restart into the wipe. Never returns on
/// success.
#[tauri::command]
pub(crate) fn erase_all_local_data(app: AppHandle) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    std::fs::write(config.join(MARKER), b"").map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_only_accepts_the_apps_own_directory() {
        assert!(guarded(Path::new("/home/u/.config/com.dhruv.lyricoverlay"), "com.dhruv.lyricoverlay"));
        assert!(!guarded(Path::new("/home/u"), "com.dhruv.lyricoverlay"));
        assert!(!guarded(Path::new("/"), "com.dhruv.lyricoverlay"));
        assert!(!guarded(Path::new("C:\\Users\\u\\AppData\\Roaming"), "com.dhruv.lyricoverlay"));
    }

    #[test]
    fn wipe_empties_the_directory_but_keeps_it() {
        let root = std::env::temp_dir().join(format!("lo-erase-{}", std::process::id()));
        let dir = root.join("com.test.app");
        std::fs::create_dir_all(dir.join("lyrics")).unwrap();
        std::fs::write(dir.join("keys.json"), "{}").unwrap();
        std::fs::write(dir.join("lyrics/a.json"), "{}").unwrap();
        wipe_dir(&dir, "com.test.app");
        assert!(dir.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // Wrong identifier: untouched.
        std::fs::write(dir.join("x"), "").unwrap();
        wipe_dir(&dir, "com.other");
        assert!(dir.join("x").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
