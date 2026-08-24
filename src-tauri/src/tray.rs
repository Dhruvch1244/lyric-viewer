//! System tray icon/menu, global hotkeys, and the overlay show/hide +
//! wallpaper toggle they both drive.

use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::playback::{cycle_display_mode, set_mode};
use crate::commands::prefs::change_offset;
use crate::state::Prefs;

/// Update the tray tooltip with the current song + any background work, so the
/// chromeless overlay has somewhere that says what it is doing.
pub(crate) fn set_tray_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// Best-effort desktop notification — silent (informational, not an alarm),
/// and a failure here (permission denied, platform unsupported) is not worth
/// surfacing over.
pub(crate) fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title("Lyric Overlay").body(body).show();
}

/// Show the overlay if hidden, hide it if shown; tell the renderer either way
/// so its render loop parks/resumes (see the onVisibility handler).
pub(crate) fn toggle_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let visible = win.is_visible().unwrap_or(true);
    if visible {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("overlay-visibility", json!({ "visible": !visible }));
}

/// Toggle full ⇄ wallpaper. A keyboard escape hatch that works no matter what
/// state pointer-forwarding or the interactive-surface lift are in — a window
/// reparented behind the desktop icons that stops taking clicks for any reason
/// must not be a dead end. See wallpaper_interact for the click-driven path.
pub(crate) fn toggle_wallpaper(app: &AppHandle) {
    let Some(st) = app.try_state::<Mutex<Prefs>>() else { return };
    let current = st.lock().unwrap_or_else(|e| e.into_inner()).display_mode.clone();
    set_mode(app, if current == "wallpaper" { "full" } else { "wallpaper" });
}

/// Build the system-tray icon + menu (Show/hide, Quit). The overlay has no
/// window chrome and hides on a hotkey, so the tray is the only thing that says
/// it is running. A failure here is non-fatal — the app runs without a tray.
pub(crate) fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

    let toggle = MenuItem::with_id(app, "toggle", "Show / hide overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Lyric Overlay")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_overlay(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                toggle_overlay(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Register the global hotkeys: Ctrl+Alt+Left/Right/0 nudge the sync offset,
/// Ctrl+Alt+H shows/hides the overlay, Ctrl+Alt+M toggles wallpaper mode,
/// Ctrl+Alt+D cycles Full/Bar/Strip.
///
/// M and D are deliberately global (work even when the window has no focus
/// and isn't clickable). For M, the click-driven wallpaper_interact path
/// depends on pointer forwarding, and wallpaper mode must never be a dead
/// end if that hiccups. For D, strip mode is click-through end to end (see
/// apply_click_through) — a global shortcut is the ONLY way out of it, not
/// just a convenience.
pub(crate) fn register_hotkeys(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if !shortcut.mods.contains(ctrl_alt) {
                return;
            }
            match shortcut.key {
                Code::ArrowLeft => change_offset(app, -100, None),
                Code::ArrowRight => change_offset(app, 100, None),
                Code::Digit0 => change_offset(app, 0, Some(0)),
                Code::KeyH => toggle_overlay(app),
                Code::KeyM => toggle_wallpaper(app),
                Code::KeyD => cycle_display_mode(app),
                _ => {}
            }
        })
        .build();

    if app.plugin(plugin).is_err() {
        return;
    }
    let gs = app.global_shortcut();
    for code in [Code::ArrowLeft, Code::ArrowRight, Code::Digit0, Code::KeyH, Code::KeyM, Code::KeyD] {
        let _ = gs.register(Shortcut::new(Some(ctrl_alt), code));
    }
}
