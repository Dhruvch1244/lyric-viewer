//! Lyric Overlay — Tauri backend.
//!
//! This is the Rust replacement for the Electron main process. It owns the
//! things the webview cannot do itself: the transparent always-on-top overlay
//! window, SMTC "now playing" detection, persisted preferences, and (in later
//! phases) wallpaper mode, the updater and the tray.
//!
//! The renderer talks to it through `window.player` (see tauri-shim.js), which
//! maps onto the `#[tauri::command]` functions and the events emitted here.
//!
//! Module map — this file itself is now just plugin wiring and the
//! setup/invoke_handler lists; everything it used to hold directly moved out:
//! - `state`: `Prefs`/`CurTrack`/`UpdateStore`, the process-wide atomics, and
//!   prefs load/save — what the rest of this crate reads and writes.
//! - `watchers`: the SMTC poll thread and the two wallpaper-mode watchers
//!   (pointer forwarding, battery/lock/fullscreen), each started once and
//!   gated on/off by an atomic rather than spawned and killed.
//! - `tray`: the tray icon/menu, global hotkeys, and overlay show/hide.
//! - `commands`: the `#[tauri::command]` handlers, grouped by domain
//!   (`prefs`, `lyrics_cmds`, `artwork_cmds`, `playback`, `updater`, `misc`).

mod align;
mod analysis;
mod artwork;
mod audio;
mod attribute;
mod commands;
mod correct;
mod crashlog;
mod genius;
mod jobs;
mod kugou;
mod llm;
mod localcli;
mod history;
mod inference;
mod journal;
mod lyrics;
mod models;
mod mood;
mod netease;
mod presets;
#[cfg(windows)]
mod smtc;
mod state;
mod translate;
mod transliterate;
mod tray;
#[cfg(windows)]
mod wallpaper;
mod watchers;

use std::sync::Mutex;

use serde_json::json;
use tauri::Manager;

// Re-exported at the crate root so the modules that reach into what used to be
// lib.rs's own top-level statics (crashlog.rs, llm.rs) need no changes:
// `crate::CRASH_REPORTING_ENABLED` and `crate::maybe_offer_localcli()` both
// still resolve. `AlwaysOnTopGuard` is deliberately NOT re-exported: every
// consumer left (commands/playback.rs, commands/lyrics_cmds.rs) is inside
// this crate's own tree and takes it from `crate::state` directly.
pub(crate) use state::{maybe_offer_localcli, CRASH_REPORTING_ENABLED};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The getDisplayMedia share-picker bypass for loopback audio is set via the
    // window's `additionalBrowserArgs` in tauri.conf.json — that is the path wry
    // actually passes to WebView2 (the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env
    // var is ignored once wry sets args through the API).

    // The GitHub self-updater is compiled in for the standalone (NSIS) build
    // only. The Microsoft Store build (`--features store`) is a read-only
    // package updated by the Store itself, so the updater plugin is omitted
    // there — which also makes check_for_update()/install_update() silent
    // no-ops via their `app.updater()` guards.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(feature = "store"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // Same store exclusion as the updater above: Store builds use the AppX
    // StartupTask extension for launch-on-startup, not a registry Run key.
    #[cfg(not(feature = "store"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = state::APP_HANDLE.set(handle.clone());
            crashlog::install_panic_hook(handle.clone());
            let _ = tray::build_tray(&handle);
            tray::register_hotkeys(&handle);

            // Load persisted prefs into shared state. All four modes (full,
            // bar, strip, wallpaper) are real; only an unrecognised value
            // (e.g. from a future/rolled-back version) gets coerced.
            let mut prefs = state::load_prefs(&handle);
            if !matches!(prefs.display_mode.as_str(), "full" | "bar" | "strip" | "wallpaper") {
                prefs.display_mode = "full".into();
            }
            let mode = prefs.display_mode.clone();
            CRASH_REPORTING_ENABLED.store(prefs.crash_reporting_enabled, std::sync::atomic::Ordering::Relaxed);
            app.manage(Mutex::new(prefs));
            app.manage(Mutex::new(state::CurTrack::default()));
            #[cfg(windows)]
            app.manage(Mutex::<Option<smtc::Session>>::new(None));
            app.manage(commands::updater::UpdateStore(Mutex::new(json!({ "available": false }))));

            // Recording temp files a previous session left behind (audio.rs).
            // Unlike a transcription, a recording is not journaled — it is
            // only worth resuming while its song is still playing — so a hard
            // kill leaves a file with nothing pointing at it, and a capped one
            // is over 100 MB at native rate.
            audio::sweep_stale_recordings();

            // The transcription journal (JOB-ENGINE section 4 / 7.1). Opened
            // before anything can submit a transcription job, and swept
            // immediately after — any row still present at this exact moment
            // was left by a session that did not end cleanly (see journal.rs's
            // module doc for why presence alone means that).
            if let Some(journal) = journal::open(&handle) {
                let stale = journal.take_stale();
                app.manage(journal);
                if !stale.is_empty() {
                    log::info!("resuming {} transcription(s) left over from a previous session", stale.len());
                    commands::lyrics_cmds::resume_stale_transcriptions(handle.clone(), stale);
                }
            }

            // Apply any keys saved via the 🔑 panel, then check for an update.
            commands::prefs::load_api_keys(&handle);
            commands::updater::check_for_update(handle.clone());

            // Fill the remembered display mode's monitor. If that mode is
            // wallpaper, reparent immediately — apply_wallpaper only fires on
            // a *transition*, and startup has no prior mode to transition
            // from. The real "wallpaper" string is passed through (not
            // translated to "full") so it lands on whichever monitor the
            // cursor is on at launch, not always the primary one.
            commands::playback::set_mode(&handle, &mode);
            if mode == "wallpaper" {
                watchers::apply_wallpaper(&handle, "full", "wallpaper");
            }

            // Begin streaming "now playing" from Windows, and (Windows only)
            // the pointer-forwarding loop wallpaper mode needs for clicks to
            // reach a window reparented behind the desktop icons, plus the
            // battery/lock/fullscreen watcher that pauses it.
            watchers::start_smtc(handle.clone());
            watchers::start_pointer_forwarding(handle.clone());
            watchers::start_power_watcher(handle.clone());

            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::prefs::get_prefs,
            commands::prefs::get_offset,
            commands::prefs::set_offset,
            commands::prefs::set_script,
            commands::prefs::set_show_translation,
            commands::prefs::get_display_mode,
            commands::prefs::set_display_mode,
            commands::playback::start_audio_capture,
            commands::playback::stop_audio_capture,
            commands::playback::set_audio_waveform,
            commands::playback::start_native_song_recording,
            commands::playback::discard_native_song_recording,
            commands::prefs::set_autostart,
            commands::prefs::get_autostart,
            commands::prefs::get_transcribe_config,
            commands::prefs::set_transcribe_config,
            commands::lyrics_cmds::request_translation,
            commands::misc::get_provider_status,
            commands::misc::localcli_detect,
            commands::misc::localcli_status,
            commands::misc::localcli_consent,
            commands::updater::get_update_state,
            commands::updater::update_action,
            commands::lyrics_cmds::list_synced,
            commands::misc::milkdrop_catalogue,
            commands::misc::milkdrop_preset,
            commands::misc::milkdrop_thumb_get,
            commands::misc::milkdrop_thumb_put,
            commands::misc::milkdrop_thumb_clear,
            commands::prefs::set_api_key,
            commands::lyrics_cmds::save_beatmap,
            commands::lyrics_cmds::save_heatmap,
            commands::lyrics_cmds::presync_list,
            commands::lyrics_cmds::precompute_tracks,
            commands::lyrics_cmds::transcribe_local_file,
            commands::lyrics_cmds::stop_native_song_recording,
            commands::misc::report_jobs,
            commands::misc::report_client_error,
            commands::misc::open_crash_log,
            commands::prefs::set_crash_reporting,
            commands::misc::wallpaper_interact,
            commands::artwork_cmds::artwork_candidates,
            commands::artwork_cmds::choose_artwork,
            commands::artwork_cmds::clear_artwork_choice,
            commands::lyrics_cmds::import_lyrics,
            commands::lyrics_cmds::clear_manual_lyrics,
            commands::misc::resync_smtc,
            commands::playback::open_local_files,
            commands::playback::open_local_folder,
            commands::playback::read_local_file,
            commands::playback::set_local_track,
            commands::playback::end_local_playback,
            commands::playback::analyze_local_file,
            commands::lyrics_cmds::transcribe_audio,
            commands::lyrics_cmds::report_transcribe_progress,
            commands::lyrics_cmds::finalize_transcription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
