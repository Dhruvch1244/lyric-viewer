//! Wallpaper mode — render the overlay behind the desktop icons.
//!
//! A Rust port of the Electron `wallpaper.js` using the `windows` crate instead
//! of koffi. The technique is unchanged and still a trick: Windows has no
//! "be the wallpaper" API, so we ask Progman (the desktop window) to spawn a
//! WorkerW behind the icons via the undocumented message 0x052C, then reparent
//! our window into it. Every desktop-wallpaper app on Windows does this.
//!
//! Everything is defensive: any step that does not find what it expects returns
//! an Err with a reason and the caller stays in normal overlay mode. A window
//! that fails to an invisible state is a bug report; a feature that is merely
//! missing is not.

#![cfg(windows)]

use std::ffi::c_void;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, RedrawWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    RDW_ALLCHILDREN, RDW_INVALIDATE, RDW_UPDATENOW,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetClassNameW, GetForegroundWindow, GetParent, GetWindowLongPtrW, GetWindowRect,
    IsIconic, SendMessageTimeoutW, SetParent, SetWindowLongPtrW, SetWindowPos, WindowFromPoint,
    GWL_STYLE, HWND_TOP, HWND_TOPMOST, SEND_MESSAGE_TIMEOUT_FLAGS, SWP_FRAMECHANGED, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, WS_CHILD, WS_POPUP,
};

/// Progman's "spawn a WorkerW" message. Undocumented, and the whole basis.
const WM_SPAWN_WORKER: u32 = 0x052c;
/// Return immediately if Progman is not pumping, instead of blocking the caller.
const SMTO_ABORTIFHUNG: u32 = 0x0002;
const SPAWN_TIMEOUT_MS: u32 = 250;
/// Smallest window worth treating as the desktop surface (strays are 136x39).
const MIN_DESKTOP_SIDE: i32 = 640;
const VK_LBUTTON: i32 = 0x01;

/// Rebuild an `HWND` from the raw pointer handed over by Tauri (`hwnd().0`).
/// Passing it as `isize` insulates this module from windows-crate version skew.
fn hwnd_from_raw(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn is_null(h: HWND) -> bool {
    h.0.is_null()
}

fn size_of(h: HWND) -> (i32, i32) {
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(h, &mut r).is_ok() {
            return ((r.right - r.left).max(0), (r.bottom - r.top).max(0));
        }
    }
    (0, 0)
}

fn class_name_of(h: HWND) -> String {
    if is_null(h) {
        return String::new();
    }
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// A discovered WorkerW candidate for the classic top-level layout.
struct Candidate {
    handle: HWND,
    has_def_view: bool,
    width: i32,
    height: i32,
}

struct Found {
    progman_worker: Option<HWND>,
    top_level: Vec<Candidate>,
}

/// Ask Progman to spawn its wallpaper surface, then collect the candidates.
fn collect_workers() -> Option<Found> {
    unsafe {
        let progman = FindWindowExW(None, None, w!("Progman"), PCWSTR::null()).ok()?;
        if is_null(progman) {
            return None;
        }

        // Harmless to send more than once. Three parameter pairs because builds
        // disagree about which one Progman listens to; all are no-ops once the
        // surface exists.
        for (wparam, lparam) in [(0usize, 0isize), (0x000d, 0x0001), (0x000d, 0x0000)] {
            let _ = SendMessageTimeoutW(
                progman,
                WM_SPAWN_WORKER,
                windows::Win32::Foundation::WPARAM(wparam),
                windows::Win32::Foundation::LPARAM(lparam),
                SEND_MESSAGE_TIMEOUT_FLAGS(SMTO_ABORTIFHUNG),
                SPAWN_TIMEOUT_MS,
                None,
            );
        }

        // Windows 11 layout: a full-screen WorkerW child of Progman itself.
        let mut progman_worker =
            FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null())
                .ok()
                .filter(|h| !is_null(*h));
        if let Some(h) = progman_worker {
            let (w, ht) = size_of(h);
            if w < MIN_DESKTOP_SIDE || ht < MIN_DESKTOP_SIDE / 2 {
                progman_worker = None;
            }
        }

        // Classic layout: top-level WorkerW windows, in Z-order.
        let mut top_level = Vec::new();
        let mut handle: Option<HWND> = None;
        for _ in 0..64 {
            let next = FindWindowExW(None, handle, w!("WorkerW"), PCWSTR::null())
                .ok()
                .filter(|h| !is_null(*h));
            let Some(h) = next else { break };
            let def_view = FindWindowExW(Some(h), None, w!("SHELLDLL_DefView"), PCWSTR::null())
                .ok()
                .filter(|d| !is_null(*d))
                .is_some();
            let (width, height) = size_of(h);
            top_level.push(Candidate { handle: h, has_def_view: def_view, width, height });
            handle = Some(h);
        }

        Some(Found { progman_worker, top_level })
    }
}

/// Decide which window to reparent into. Pure logic, mirrors `pickWorkerW`.
fn pick_workerw(found: &Found) -> Option<HWND> {
    if let Some(h) = found.progman_worker {
        return Some(h);
    }
    let workers = &found.top_level;
    if workers.is_empty() {
        return None;
    }
    if let Some(idx) = workers.iter().position(|w| w.has_def_view) {
        return workers.get(idx + 1).map(|c| c.handle);
    }
    // No icon host: a single desktop-sized candidate is a reasonable answer.
    let plausible: Vec<&Candidate> = workers
        .iter()
        .filter(|w| w.width >= MIN_DESKTOP_SIDE && w.height >= MIN_DESKTOP_SIDE / 2)
        .collect();
    if plausible.len() == 1 {
        Some(plausible[0].handle)
    } else {
        None
    }
}

/// Put our window behind the desktop icons.
pub fn attach(raw: isize) -> Result<(), String> {
    let hwnd = hwnd_from_raw(raw);
    let found = collect_workers().ok_or("the desktop window (Progman) was not found")?;
    let target = pick_workerw(&found).ok_or_else(|| {
        format!(
            "could not identify the desktop surface behind the icons (no Progman child, {} top-level candidates)",
            found.top_level.len()
        )
    })?;

    unsafe {
        // Popup -> child BEFORE the reparent. A merely-owned WS_POPUP window is
        // not clipped into the desktop; only WS_CHILD makes Windows draw it there.
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let as_child = (style & !(WS_POPUP.0 as isize)) | (WS_CHILD.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, as_child);

        let _ = SetParent(hwnd, Some(target));

        // The style change only applies once the frame is recalculated.
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("SetWindowPos failed: {e}"))?;

        // Force a full repaint of our window AND the WebView2 child inside it.
        // Without this a region can keep showing the real wallpaper until the
        // next paint the reparent didn't invalidate.
        let _ = RedrawWindow(Some(hwnd), None, None, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
    }
    Ok(())
}

/// Current cursor position in screen pixels, for pointer forwarding.
pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// Return our window to the desktop's top level, raised to topmost so it is not
/// left behind every other window (the old "switched back and it's invisible").
pub fn detach(raw: isize) -> Result<(), String> {
    let hwnd = hwnd_from_raw(raw);
    unsafe {
        let _ = SetParent(hwnd, None);
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let as_popup = (style & !(WS_CHILD.0 as isize)) | (WS_POPUP.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, as_popup);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("SetWindowPos failed: {e}"))?;
    }
    Ok(())
}

/// Window classes that ARE the desktop — a reparented window never hit-tests,
/// so the answerable question is "is the cursor over the desktop, not someone
/// else's window".
const DESKTOP_CLASSES: [&str; 4] = ["Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32"];

/// Left-button state: `down` is now, `pressed_since` catches a click that came
/// and went between polls. Only meaningful when the cursor is over our surface.
pub fn mouse_state() -> (bool, bool) {
    let state = unsafe { GetAsyncKeyState(VK_LBUTTON) } as u16;
    ((state & 0x8000) != 0, (state & 0x0001) != 0)
}

/// Whether forwarded input should be delivered: true when the cursor is over the
/// desktop (or, if a layout allows it, over our own reparented window).
pub fn is_cursor_over_desktop(our_raw: isize, x: i32, y: i32) -> bool {
    unsafe {
        let at = WindowFromPoint(POINT { x, y });
        if is_null(at) {
            return false;
        }
        if DESKTOP_CLASSES.contains(&class_name_of(at).as_str()) {
            return true;
        }
        let ours = hwnd_from_raw(our_raw).0;
        let mut walk = at;
        for _ in 0..8 {
            if walk.0 == ours {
                return true;
            }
            match GetParent(walk) {
                Ok(p) if !is_null(p) => walk = p,
                _ => break,
            }
        }
        false
    }
}

// ------------------------------------------------ power-aware auto-suspend
//
// Wallpaper Engine and Lively Wallpaper both stop rendering when they'd
// otherwise be pure waste: running on battery, behind a locked screen, or
// behind another app's exclusive fullscreen (a game). A reparented window
// behind the icons has no way to know any of this on its own — nothing
// tells it the icons are covered — so `start_power_watcher` in lib.rs polls
// these three checks and the renderer parks its render loop on the result.

/// True when running on battery power. `None` means the query failed or the
/// line status is unknown (some desktops/VMs report this) — callers should
/// treat that as "don't suspend" rather than guess.
pub fn on_battery() -> Option<bool> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status).ok()? };
    match status.ACLineStatus {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

/// True while the workstation is locked, or a secure-desktop prompt (UAC) is
/// up. `OpenInputDesktop` can only open the desktop actually receiving
/// input, so it fails exactly when something else — winlogon's lock screen,
/// consent.exe — owns it instead of the interactive desktop we're on.
pub fn is_locked() -> bool {
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
            Ok(hdesk) => {
                let _ = CloseDesktop(hdesk);
                false
            }
            Err(_) => true,
        }
    }
}

/// True when the foreground window looks like an exclusive/borderless
/// fullscreen app on its own monitor — a game, a video player — rather than
/// the desktop, the taskbar, or our own reparented window.
pub fn foreground_is_fullscreen(our_raw: isize) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if is_null(fg) {
            return false;
        }
        if fg.0 == hwnd_from_raw(our_raw).0 {
            return false;
        }
        if DESKTOP_CLASSES.contains(&class_name_of(fg).as_str()) {
            return false;
        }
        if IsIconic(fg).as_bool() {
            return false;
        }
        let mut wr = RECT::default();
        if GetWindowRect(fg, &mut wr).is_err() {
            return false;
        }
        let hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return false;
        }
        let mr = mi.rcMonitor;
        wr.left <= mr.left && wr.top <= mr.top && wr.right >= mr.right && wr.bottom >= mr.bottom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a real fullscreen app; whatever has focus when this runs (a
    /// terminal, an editor) is exactly the "must not false-positive on an
    /// ordinary window" case. Manually cross-check on_battery()/is_locked()
    /// against `powercfg /batteryreport` or the taskbar power icon — there is
    /// no automated ground truth for "is this desktop plugged in right now".
    #[test]
    #[ignore] // live desktop state — run with `cargo test -- --ignored` interactively
    fn live_power_state_reads_without_panicking() {
        let battery = on_battery();
        let locked = is_locked();
        eprintln!("on_battery: {battery:?}, is_locked: {locked}");
        // A running, unlocked interactive session (this test can only run in
        // one) must never itself report as locked.
        assert!(!locked, "test process is definitionally on the input desktop");
        let fullscreen = foreground_is_fullscreen(0);
        eprintln!("foreground_is_fullscreen (raw=0, i.e. never 'us'): {fullscreen}");
    }
}
