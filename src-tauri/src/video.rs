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

/// Whether an MP4-family file is FRAGMENTED (`moof` boxes, as YouTube's DASH
/// streams are — and yt-dlp saves a video-only DASH stream as-is, with no
/// merge step to rewrite it).
///
/// WHY IT MATTERS. WebKitGTK cannot play a fragmented MP4 from a blob URL,
/// which is how the renderer loads a video: measured on a real download
/// (WebKitGTK 2.54, GStreamer 1.28), playback runs ~5s then jumps straight to
/// `ended`, the sync loop seeks back, and the cycle repeats — the video never
/// shows. The same bytes as a plain file:// URL, or remuxed to a regular MP4
/// and played from a blob, play at the full 25 fps with no dropped frames.
///
/// Walks top-level boxes only, stopping at the first `moof` (fragmented) or
/// `mdat` (a regular file's media data comes before any fragment would).
pub(crate) fn is_fragmented(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut off = 0u64;
    for _ in 0..64 {
        let mut h = [0u8; 16];
        if off + 8 > len || f.seek(SeekFrom::Start(off)).is_err() || f.read_exact(&mut h[..8]).is_err() {
            return false;
        }
        let mut size = u64::from(u32::from_be_bytes([h[0], h[1], h[2], h[3]]));
        match &h[4..8] {
            b"moof" => return true,
            b"mdat" => return false,
            _ => {}
        }
        if size == 1 {
            if f.read_exact(&mut h[8..16]).is_err() {
                return false;
            }
            size = u64::from_be_bytes([h[8], h[9], h[10], h[11], h[12], h[13], h[14], h[15]]);
        }
        if size < 8 {
            return false; // 0 = "to end of file"; anything else is malformed
        }
        off += size;
    }
    false
}

fn is_mp4_family(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["mp4", "m4v", "mov"].contains(&e.to_ascii_lowercase().as_str()))
}

/// Rewrite a fragmented MP4 in place as a regular one, with the user's
/// ffmpeg (stream copy, no re-encode: ~0.2s for a 37 MB video, measured).
/// Like yt-dlp, ffmpeg is never shipped; yt-dlp users nearly always have it,
/// and without it the file is left as it is. Ok(false) = nothing to do, or
/// no ffmpeg.
pub(crate) fn defragment(path: &Path) -> Result<bool, String> {
    if !is_mp4_family(path) || !is_fragmented(path) {
        return Ok(false);
    }
    remux_to(path, path)
}

/// Remux `src` to a regular MP4 at `dest` (which may be `src` itself).
/// Written to a `.part` beside `dest` (so `remove_partials` sweeps up a
/// failed run) and renamed into place only once ffmpeg succeeds. Ok(false)
/// when there is no ffmpeg.
fn remux_to(src: &Path, dest: &Path) -> Result<bool, String> {
    let Some(ffmpeg) = crate::localcli::resolve_cmd("ffmpeg") else { return Ok(false) };
    let tmp = dest.with_extension(format!("{}.defrag.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("mp4")));
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-nostdin", "-v", "error", "-y", "-i"])
        .arg(src)
        .args(["-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("could not start ffmpeg: {e}"))?;
    if !out.status.success() || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("ffmpeg could not remux the video: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not save the remuxed video: {e}")
    })?;
    Ok(true)
}

/// djb2 over a string, as hex — the same hand-rolled hash `track_key` uses
/// ("std first"), here naming a linked file's remuxed copy.
fn djb2_hex(s: &str) -> String {
    let h = s.bytes().fold(5381u32, |h, b| h.wrapping_mul(33) ^ u32::from(b));
    format!("{h:08x}")
}

/// What to actually play for a file the user linked. A fragmented MP4 is the
/// same blob problem as a download (`is_fragmented`), but the user's own file
/// is never rewritten: a regular-MP4 copy goes under `<videos>/linked/`,
/// named by the file's path, size and modification time so an edited file
/// gets a fresh copy and an unchanged one is remuxed only once.
/// Ok(None) = play the original. Err = fragmented and cannot be fixed here.
pub(crate) fn playable_linked(videos: &Path, src: &Path) -> Result<Option<PathBuf>, String> {
    if !is_mp4_family(src) || !is_fragmented(src) {
        return Ok(None);
    }
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let dir = videos.join("linked");
    let dest = dir.join(format!("{}.mp4", djb2_hex(&format!("{}|{}|{mtime}", src.display(), meta.len()))));
    if dest.is_file() {
        return Ok(Some(dest));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    match remux_to(src, &dest)? {
        true => Ok(Some(dest)),
        false => Err(FRAGMENTED_NO_FFMPEG.into()),
    }
}

/// Said when a fragmented MP4 cannot be remuxed for want of ffmpeg.
pub(crate) const FRAGMENTED_NO_FFMPEG: &str =
    "this video is a fragmented MP4, which this system's player cannot stream — install ffmpeg (pacman -S ffmpeg · winget install ffmpeg) and the app will fix it by itself";

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
                if let Err(e) = defragment(&path) {
                    eprintln!("[video] {e}");
                }
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

    /// Writes one top-level box: `[u32 size][4cc][payload]`.
    fn mp4_box(out: &mut Vec<u8>, kind: &[u8; 4], payload: usize) {
        out.extend_from_slice(&((8 + payload) as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend(std::iter::repeat_n(0u8, payload));
    }

    #[test]
    fn fragmented_mp4s_are_told_apart_from_regular_ones() {
        let dir = std::env::temp_dir().join(format!("lv-frag-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The layout of a real yt-dlp DASH download: ftyp, moov, sidx, then fragments.
        let mut frag = Vec::new();
        for (k, n) in [(b"ftyp", 20), (b"moov", 700), (b"sidx", 430), (b"moof", 1600), (b"mdat", 4000)] {
            mp4_box(&mut frag, k, n);
        }
        let mut flat = Vec::new();
        for (k, n) in [(b"ftyp", 20), (b"moov", 700), (b"mdat", 4000)] {
            mp4_box(&mut flat, k, n);
        }
        let (fp, rp) = (dir.join("frag.mp4"), dir.join("flat.mp4"));
        std::fs::write(&fp, &frag).unwrap();
        std::fs::write(&rp, &flat).unwrap();
        assert!(is_fragmented(&fp));
        assert!(!is_fragmented(&rp));
        assert!(!is_fragmented(&dir.join("missing.mp4")));
        std::fs::write(&fp, &frag[..10]).unwrap();
        assert!(!is_fragmented(&fp), "truncated header is not a fragment");
        assert_eq!(defragment(&rp), Ok(false), "a regular file is left alone");
        assert_eq!(playable_linked(&dir, &rp), Ok(None), "a regular linked file plays as it is");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live: remux a real fragmented download with the user's ffmpeg —
    /// `LYRIC_TEST_FRAG_MP4=~/.config/com.dhruv.lyricoverlay/videos/<id>.mp4
    /// cargo test --workspace -- --ignored real_defragment` (works on a copy).
    #[test]
    #[ignore]
    fn real_defragment_yields_a_regular_mp4() {
        let src = PathBuf::from(std::env::var("LYRIC_TEST_FRAG_MP4").expect("set LYRIC_TEST_FRAG_MP4"));
        assert!(is_fragmented(&src), "the test file is not fragmented");
        let dir = std::env::temp_dir().join(format!("lv-defrag-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("v.mp4");
        std::fs::copy(&src, &copy).unwrap();
        // A linked file: a regular copy beside it, the original untouched, and
        // the second ask served from that copy without running ffmpeg again.
        let linked = playable_linked(&dir, &copy).unwrap().expect("a copy for a fragmented file");
        assert!(!is_fragmented(&linked) && is_fragmented(&copy));
        assert_eq!(playable_linked(&dir, &copy).unwrap(), Some(linked));
        assert_eq!(defragment(&copy), Ok(true));
        assert!(!is_fragmented(&copy));
        assert!(std::fs::metadata(&copy).unwrap().len() > std::fs::metadata(&src).unwrap().len() / 2);
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
