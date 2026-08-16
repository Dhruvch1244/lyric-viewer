//! A local crash/error log — the only visibility into what breaks in the
//! wild for a single-maintainer app with no telemetry service (see
//! ROADMAP.md's "single maintainer, no crash reporting" gap). Deliberately
//! local-only: nothing here is ever sent anywhere on its own. A user hitting
//! a real bug can attach it to a bug report by hand — see the "Open crash
//! log" button next to the existing report-email flow in the 🔑 panel.
//!
//! Structured `tauri_plugin_log` is debug-only (see lib.rs's `run()`) since
//! verbose logging in a release build is noise most users will never read.
//! Panics and renderer errors are a different thing: rare, always actionable,
//! and otherwise invisible once installed on someone else's machine — worth
//! capturing unconditionally.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Cap so months of use can't grow this file unboundedly. Crossing it drops
/// the OLDER half rather than truncating outright — a crash log with only
/// its most recent entries is still useful; an empty one isn't.
const MAX_BYTES: usize = 512 * 1024;

/// Serialises writes across the panic hook and `report_client_error`, which
/// can each fire from a different thread.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("crash.log"))
}

/// Seconds since the epoch, not a calendar date — avoids pulling in a
/// datetime crate for a debug log. Still monotonic and diffable, and
/// convertible with `date -d @<secs>` if a real date is ever needed.
fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn format_entry(kind: &str, ts: u64, body: &str) -> String {
    format!("[t+{ts}] {kind}: {}\n", body.trim())
}

/// If `existing` is over `max_bytes`, drop its older half at a safe UTF-8
/// char boundary (never panics on multi-byte content); otherwise returns it
/// unchanged.
fn truncate_from_middle(existing: &str, max_bytes: usize) -> String {
    if existing.len() <= max_bytes {
        return existing.to_string();
    }
    let target = existing.len() / 2;
    let boundary = existing
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= target)
        .unwrap_or(existing.len());
    existing[boundary..].to_string()
}

fn append(app: &AppHandle, kind: &str, body: &str) {
    let Some(path) = log_path(app) else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.len() > MAX_BYTES {
            let _ = fs::write(&path, truncate_from_middle(&existing, MAX_BYTES));
        }
    } else if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(format_entry(kind, timestamp(), body).as_bytes());
    }
}

/// Install a panic hook that appends every panic (message + source location)
/// to the local crash log, then chains to Rust's default hook — this is
/// additive, not a replacement for the usual stderr output a `cargo run`
/// session or Windows' own crash dialog would show.
pub fn install_panic_hook(app: AppHandle) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-string panic payload)".into());
        append(&app, "panic", &format!("{message} at {location}"));
        default_hook(info);
    }));
}

/// Append a renderer-side JS error or unhandled promise rejection, reported
/// via the `report_client_error` command (see lib.rs).
pub fn append_client_error(app: &AppHandle, message: &str) {
    append(app, "renderer", message);
}

/// Absolute path to the crash log, for the "Open crash log" button — created
/// (empty, if new) so there is always something for the file manager to open
/// rather than a "path not found" error on a machine that never crashed.
pub fn ensure_and_path(app: &AppHandle) -> Option<PathBuf> {
    let path = log_path(app)?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, "");
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_entry_includes_kind_and_trims_body() {
        let line = format_entry("panic", 42, "  boom  ");
        assert_eq!(line, "[t+42] panic: boom\n");
    }

    #[test]
    fn truncate_leaves_a_short_log_untouched() {
        let short = "one\ntwo\n";
        assert_eq!(truncate_from_middle(short, 1024), short);
    }

    #[test]
    fn truncate_drops_the_older_half_once_over_budget() {
        let long: String = (0..100).map(|i| format!("line {i}\n")).collect();
        let out = truncate_from_middle(&long, 50);
        assert!(out.len() < long.len());
        // The tail survives; the earliest lines are gone.
        assert!(out.contains("line 99"));
        assert!(!out.contains("line 0\n"));
    }

    #[test]
    fn truncate_never_panics_on_a_multibyte_char_boundary() {
        // Every other "line" is a multi-byte emoji so the raw midpoint byte
        // offset is very likely to land inside a char, not on a boundary.
        let long: String = (0..200).map(|i| format!("🔥line {i}\n")).collect();
        let out = truncate_from_middle(&long, 100);
        assert!(out.is_char_boundary(0));
        assert!(!out.is_empty());
    }
}
