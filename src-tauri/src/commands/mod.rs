//! The `#[tauri::command]` surface, grouped by domain instead of living in
//! one file alongside all of `lib.rs`'s app state and background threads.
//! `lib.rs`'s `invoke_handler(tauri::generate_handler![...])` list is the
//! only place that needs every command name qualified by its submodule path.

pub(crate) mod artwork_cmds;
pub(crate) mod library_cmds;
pub(crate) mod lyrics_cmds;
pub(crate) mod misc;
pub(crate) mod playback;
pub(crate) mod prefs;
pub(crate) mod updater;
