//! Local music videos — ▶ Video playing a file on disk instead of YouTube's
//! embedded player.
//!
//! WHY LOCAL AT ALL. The embed is a cross-origin frame: its pixels cannot be
//! read, so the shaders cannot work on the footage, the backdrop cannot take
//! its colours, and sync is only as good as a postMessage round trip. A file
//! in a `<video>` element is exact to the frame and works offline.
//!
//! WHY yt-dlp IS NEVER SHIPPED. YouTube's terms forbid downloading, and a
//! built-in downloader is what got youtube-dl a DMCA takedown in 2020. The
//! app is public on GitHub and in the Microsoft Store, so it neither bundles
//! nor installs a downloader: if the user has put `yt-dlp` on their own
//! system, a Download button appears and drives it; otherwise any video file
//! they already have can be linked to a song. Finding the binary reuses
//! `localcli::resolve_cmd`, which also searches the per-user directories
//! (`~/.local/bin`, where `pip install --user yt-dlp` lands) that a desktop
//! launcher's PATH often lacks.
//!
//! WHAT IS DOWNLOADED. Video only, at most 720p, H.264 first. The video is
//! always muted (the music comes from whatever is playing it), so an audio
//! track is dead weight; 720p keeps a four-minute video to tens of MB, which
//! matters because the renderer loads it whole into a blob (the same
//! `read_local_file` path local audio uses). H.264 first because every
//! target decodes it — WebView2 natively, WebKitGTK through gst-libav or
//! openh264 — with VP9 and then anything as fallbacks.
//!
//! WHERE. `<config>/videos/<youtube id>.<ext>`: keyed by the video, not the
//! song, so a video linked to two songs (a remix, a radio edit) is one file.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::jobs::{CancelToken, Lane, Runnable};

/// Extensions accepted for a linked file and recognised as a finished download.
pub(crate) const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov"];

/// A YouTube video id: exactly 11 of `[A-Za-z0-9_-]`. Checked before the id
/// goes anywhere near a command line or a file name.
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn videos_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("videos"))
}

/// The user's own yt-dlp, if they have one.
pub(crate) fn ytdlp() -> Option<PathBuf> {
    crate::localcli::resolve_cmd("yt-dlp")
}

/// A finished download for `id` in `dir`, if there is one.
pub(crate) fn cached_in(dir: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    VIDEO_EXTS.iter().map(|ext| dir.join(format!("{id}.{ext}"))).find(|p| p.is_file())
}

/// yt-dlp's arguments for one download into `dir`.
pub(crate) fn ytdlp_args(id: &str, dir: &Path) -> Vec<String> {
    vec![
        "--no-playlist".into(),
        "--no-mtime".into(),
        "--no-warnings".into(),
        "--newline".into(),
        "--progress-template".into(),
        "download:LVPROGRESS %(progress._percent_str)s".into(),
        "-f".into(),
        "bv*[height<=720][vcodec^=avc1]/bv*[height<=720][vcodec^=vp09]/bv*[height<=720]/b[height<=720]/b".into(),
        "-o".into(),
        dir.join(format!("{id}.%(ext)s")).to_string_lossy().into_owned(),
        "--".into(),
        format!("https://www.youtube.com/watch?v={id}"),
    ]
}

/// Percent from one of our progress lines (`LVPROGRESS  42.0%`).
pub(crate) fn parse_progress(line: &str) -> Option<f32> {
    let rest = line.trim().strip_prefix("LVPROGRESS")?.trim();
    let n: f32 = rest.trim_end_matches('%').trim().parse().ok()?;
    n.is_finite().then_some(n.clamp(0.0, 100.0))
}

/// yt-dlp's leftovers for `id` after a failed or cancelled run.
fn remove_partials(dir: &Path, id: &str) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(id) && (name.ends_with(".part") || name.ends_with(".ytdl") || name.contains(".part-")) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

pub(crate) struct DownloadJob {
    pub(crate) app: AppHandle,
    pub(crate) id: String,
    pub(crate) exe: PathBuf,
    pub(crate) dir: PathBuf,
}

impl DownloadJob {
    fn emit(&self, payload: serde_json::Value) {
        let _ = self.app.emit("video-download", payload);
    }
}

impl Runnable for DownloadJob {
    fn lane(&self) -> Lane {
        Lane::Io
    }

    fn dedup_key(&self) -> String {
        format!("video-dl:{}", self.id)
    }

    // No track: a download the user asked for keeps going when the song
    // changes — it is for the next time that song plays.

    fn run(self: Box<Self>, cancel: &CancelToken) {
        let id = self.id.clone();
        if let Err(e) = std::fs::create_dir_all(&self.dir) {
            self.emit(json!({ "id": id, "status": "error", "message": format!("could not create the videos folder: {e}") }));
            return;
        }
        let mut cmd = Command::new(&self.exe);
        cmd.args(ytdlp_args(&id, &self.dir)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.emit(json!({ "id": id, "status": "error", "message": format!("could not start yt-dlp: {e}") }));
                return;
            }
        };
        self.emit(json!({ "id": id, "status": "progress", "percent": 0.0 }));

        // stderr on its own thread (keeping the last line for the error
        // message) so a chatty run cannot fill the pipe and stall stdout.
        let last_err = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let err_handle = child.stderr.take().map(|e| {
            let last = last_err.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(e).lines().map_while(Result::ok) {
                    let l = line.trim();
                    if !l.is_empty() {
                        *last.lock().unwrap_or_else(|p| p.into_inner()) = l.to_string();
                    }
                }
            })
        });

        let mut last_sent = -10.0f32;
        let mut cancelled = false;
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if cancel.cancelled() {
                    cancelled = true;
                    let _ = child.kill();
                    break;
                }
                if let Some(p) = parse_progress(&line) {
                    // Every whole percent at most: yt-dlp prints many times a second.
                    if p - last_sent >= 1.0 || p >= 100.0 {
                        last_sent = p;
                        self.emit(json!({ "id": id, "status": "progress", "percent": p }));
                    }
                }
            }
        }
        let status = child.wait();
        if let Some(h) = err_handle {
            let _ = h.join();
        }
        if cancelled || cancel.cancelled() {
            remove_partials(&self.dir, &id);
            self.emit(json!({ "id": id, "status": "cancelled" }));
            return;
        }
        match (status, cached_in(&self.dir, &id)) {
            (Ok(s), Some(path)) if s.success() => {
                self.emit(json!({ "id": id, "status": "done", "path": path.to_string_lossy() }));
            }
            _ => {
                remove_partials(&self.dir, &id);
                let msg = last_err.lock().unwrap_or_else(|p| p.into_inner()).clone();
                let msg = if msg.is_empty() { "yt-dlp could not download this video".to_string() } else { msg };
                self.emit(json!({ "id": id, "status": "error", "message": msg }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_checked_before_touching_a_command_line() {
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(valid_id("a-b_c-d_e-f"));
        assert!(!valid_id("dQw4w9WgXc"));
        assert!(!valid_id("dQw4w9WgXcQQ"));
        assert!(!valid_id("--exec=rm -"));
        assert!(!valid_id("../../etc/p"));
        assert!(!valid_id("dQw4w9WgXc;"));
    }

    #[test]
    fn progress_lines_parse_and_others_do_not() {
        assert_eq!(parse_progress("LVPROGRESS  42.5%"), Some(42.5));
        assert_eq!(parse_progress("LVPROGRESS 100.0%"), Some(100.0));
        assert_eq!(parse_progress("  LVPROGRESS   3.1%  "), Some(3.1));
        assert_eq!(parse_progress("LVPROGRESS N/A"), None);
        assert_eq!(parse_progress("[youtube] dQw4w9WgXcQ: Downloading webpage"), None);
    }

    #[test]
    fn the_url_is_the_last_argument_after_a_separator() {
        let args = ytdlp_args("dQw4w9WgXcQ", Path::new("/tmp/v"));
        let n = args.len();
        assert_eq!(args[n - 2], "--");
        assert_eq!(args[n - 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert!(args.iter().any(|a| a.ends_with("dQw4w9WgXcQ.%(ext)s")));
    }

    /// Live: the real yt-dlp with the app's exact arguments. Needs network
    /// and a yt-dlp — `LYRIC_TEST_YTDLP=/path/to/yt-dlp cargo test
    /// --workspace -- --ignored real_ytdlp`. Uses YouTube's first upload
    /// (19s) so the download is small.
    #[test]
    #[ignore]
    fn real_ytdlp_download_reports_progress_and_lands_where_expected() {
        let exe = std::env::var("LYRIC_TEST_YTDLP").map(PathBuf::from).ok().or_else(ytdlp).expect("no yt-dlp");
        let dir = std::env::temp_dir().join(format!("lv-ytdlp-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "jNQXAC9IVRw";
        let out = Command::new(exe).args(ytdlp_args(id, &dir)).output().expect("yt-dlp did not start");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "yt-dlp failed: {}", String::from_utf8_lossy(&out.stderr));
        let progress: Vec<f32> = stdout.lines().filter_map(parse_progress).collect();
        assert!(!progress.is_empty(), "no progress lines parsed from:\n{stdout}");
        assert_eq!(progress.last().copied(), Some(100.0));
        let path = cached_in(&dir, id).expect("download not found under its id");
        assert!(std::fs::metadata(&path).unwrap().len() > 10_000);
        eprintln!("downloaded {} ({} progress lines)", path.display(), progress.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_finished_download_is_found_and_a_partial_is_not() {
        let dir = std::env::temp_dir().join(format!("lv-video-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "dQw4w9WgXcQ";
        std::fs::write(dir.join(format!("{id}.mp4.part")), b"x").unwrap();
        assert_eq!(cached_in(&dir, id), None);
        std::fs::write(dir.join(format!("{id}.webm")), b"x").unwrap();
        assert_eq!(cached_in(&dir, id), Some(dir.join(format!("{id}.webm"))));
        remove_partials(&dir, id);
        assert!(!dir.join(format!("{id}.mp4.part")).exists());
        assert!(dir.join(format!("{id}.webm")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
