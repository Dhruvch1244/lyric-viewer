//! Host side of the inference sidecar: spawn it, talk to it, clean up after it.
//!
//! ONE PROCESS PER JOB, started and ended around a single transcription. The
//! alternative — a long-lived sidecar — would avoid re-loading the model each
//! time, but transcription happens once per song that has no lyrics anywhere,
//! which is rare enough that the trade goes the other way. What spawning per
//! job buys is the property JOB-ENGINE section 2.2 wanted most: when the
//! process exits, the OS reclaims every byte the model allocated. A resident
//! inference process that has held a Whisper graph does not give that memory
//! back, because the allocator keeps it.
//!
//! It also means there is no supervision state machine, no restart policy and
//! no "is the sidecar still healthy" question — the answer is always yes,
//! because it was started a moment ago for this job alone.

use std::io::{BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use inference_protocol::{read_frame, write_frame, Cue, Request, Response, Stage, PROTOCOL_VERSION};
use tauri::{AppHandle, Manager};

use crate::jobs::CancelToken;

/// Sample rate the sidecar requires. Resampling happens here, on the host,
/// because the host already owns the decode path.
pub(crate) const SAMPLE_RATE: u32 = 16_000;

/// Where the ONNX models and tokenizer live, downloaded on first use.
pub(crate) fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("models");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Locate the sidecar executable.
///
/// Next to the app's own executable in an installed build — that is where
/// Tauri's `externalBin` bundling puts it, with the target triple stripped.
/// Falls back to the cargo target directory so `cargo tauri dev` works without
/// a bundle step, and reports every path it tried on failure, because "sidecar
/// not found" with no list of candidates is a miserable thing to debug.
fn sidecar_path() -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) { "lyric-inference.exe" } else { "lyric-inference" };

    let mut tried = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate);
        }
    }
    // Dev: target/{debug,release}/lyric-inference.exe, beside the app binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for up in [dir.to_path_buf(), dir.join("..")] {
                let candidate = up.join(exe_name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
                tried.push(candidate);
            }
        }
    }
    Err(format!("inference sidecar not found; tried: {}", tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")))
}

/// Write samples to a temp file for the sidecar to memory-map.
///
/// A file rather than the pipe because a 4-minute song is ~15 MB of `f32`;
/// pushing that through stdio would copy it at least twice for no reason. The
/// host owns the file and deletes it in `Session::drop`.
fn write_pcm(job_id: u64, samples: &[f32]) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("lyric-overlay-{job_id}.pcm"));
    let file = std::fs::File::create(&path).map_err(|e| format!("cannot create PCM temp file: {e}"))?;
    let mut w = BufWriter::new(file);
    for s in samples {
        w.write_all(&s.to_le_bytes()).map_err(|e| format!("cannot write PCM: {e}"))?;
    }
    w.flush().map_err(|e| format!("cannot flush PCM: {e}"))?;
    Ok(path)
}

/// A spawned sidecar plus the temp file it is reading, both cleaned up on drop
/// — including on an early `?` return, which is most of the paths below.
struct Session {
    child: Child,
    pcm_path: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        // The child is expected to have exited already via Shutdown. Killing
        // is the backstop for the paths where it did not (a protocol error, a
        // cancellation, a panic) — an orphaned sidecar holding a model in
        // memory is exactly what this must never leave behind.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.pcm_path);
    }
}

/// Run one transcription. Blocking — it belongs on the job engine's Inference
/// lane, which is concurrency 1.
///
/// `progress` is called on this thread as the sidecar reports; it must not
/// block for long.
pub(crate) fn transcribe(
    app: &AppHandle,
    job_id: u64,
    samples: &[f32],
    language: Option<String>,
    cancel: &CancelToken,
    mut progress: impl FnMut(Stage, u8),
) -> Result<Vec<Cue>, String> {
    let exe = sidecar_path()?;
    let models = model_dir(app).ok_or("no config directory for models")?;
    let pcm_path = write_pcm(job_id, samples)?;

    let mut cmd = Command::new(&exe);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up on spawn.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Belt and braces with the sidecar's own SetPriorityClass call: if it
        // is set here the child is born low-priority, so even its startup and
        // model load cannot outrank the app.
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_file(&pcm_path);
        format!("cannot start the inference sidecar at {}: {e}", exe.display())
    })?;

    let stdin = child.stdin.take().ok_or("sidecar has no stdin")?;
    let stdout = child.stdout.take().ok_or("sidecar has no stdout")?;
    let stderr = child.stderr.take();

    // Drain stderr on its own thread throughout, not after exit: the sidecar
    // logs while it works, and a full pipe buffer would block it mid-job.
    let log = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut se) = stderr {
            let _ = se.read_to_string(&mut buf);
        }
        buf
    });

    let mut session = Session { child, pcm_path };
    let mut w = BufWriter::new(stdin);
    let mut r = BufReader::new(stdout);

    // Handshake first, so a stale or mismatched binary is diagnosed here
    // rather than as a confusing failure halfway through a job.
    write_frame(&mut w, &Request::Hello { version: PROTOCOL_VERSION }).map_err(|e| format!("cannot greet the sidecar: {e}"))?;
    match read_frame::<_, Response>(&mut r) {
        Ok(Some(Response::Ready { version, runtime })) => {
            if version != PROTOCOL_VERSION {
                return Err(format!("sidecar speaks protocol {version}, this build speaks {PROTOCOL_VERSION} — reinstall"));
            }
            log::info!("inference sidecar ready: {runtime}");
        }
        Ok(Some(other)) => return Err(format!("sidecar answered the handshake with {other:?}")),
        Ok(None) => return Err(format!("sidecar exited during the handshake; log: {}", log.join().unwrap_or_default())),
        Err(e) => return Err(format!("sidecar handshake failed: {e}")),
    }

    write_frame(
        &mut w,
        &Request::Transcribe {
            job_id,
            pcm_path: session.pcm_path.to_string_lossy().into_owned(),
            sample_rate: SAMPLE_RATE,
            model_dir: models.to_string_lossy().into_owned(),
            language,
            vad: true,
        },
    )
    .map_err(|e| format!("cannot send the transcription request: {e}"))?;

    let mut cancelled_sent = false;
    let outcome = loop {
        // Checked between frames. Cooperative by nature — the sidecar stops at
        // its next span boundary, it does not abandon a model run in flight.
        if cancel.cancelled() && !cancelled_sent {
            let _ = write_frame(&mut w, &Request::Cancel { job_id });
            cancelled_sent = true;
        }
        match read_frame::<_, Response>(&mut r) {
            Ok(Some(Response::Progress { stage, pct, .. })) => progress(stage, pct),
            Ok(Some(Response::Result { cues, .. })) => break Ok(cues),
            Ok(Some(Response::Error { message, .. })) => break Err(message),
            Ok(Some(Response::Ready { .. })) | Ok(Some(Response::Bye)) => continue,
            Ok(None) => break Err(format!("sidecar exited without answering; log: {}", log.join().unwrap_or_default())),
            Err(e) => break Err(format!("sidecar response stream broke: {e}")),
        }
    };

    // Ask for a clean exit so the process is not killed mid-write. `Session`'s
    // Drop still kills it if this does not land, so a wedged sidecar cannot
    // outlive the job either way.
    let _ = write_frame(&mut w, &Request::Shutdown);
    let _ = w.flush();
    let _ = session.child.wait();

    outcome
}

/// Resample to 16 kHz mono, which is the only rate Whisper accepts.
///
/// Linear interpolation, deliberately: the input is already a mono mixdown of
/// a lossy stream being fed to a speech model whose own front end reduces it
/// to 80 mel bins. A windowed-sinc resampler would be more correct and
/// completely inaudible to the thing consuming it.
pub(crate) fn resample_to_16k(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || samples.is_empty() || from_rate == 0 {
        return samples.to_vec();
    }
    let ratio = SAMPLE_RATE as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let lo = src.floor() as usize;
        let hi = (lo + 1).min(samples.len() - 1);
        let frac = (src - lo as f64) as f32;
        let a = samples[lo.min(samples.len() - 1)];
        let b = samples[hi];
        out.push(a + (b - a) * frac);
    }
    out
}

/// True when a sidecar binary is present, so callers can decide before doing
/// expensive preparation (decoding and resampling a whole song).
pub(crate) fn available() -> bool {
    sidecar_path().is_ok()
}

/// Convert the sidecar's cues into the app's own cue shape.
pub(crate) fn to_lyric_cues(cues: Vec<Cue>) -> Vec<crate::lyrics::Cue> {
    cues.into_iter()
        .map(|c| crate::lyrics::Cue {
            time_ms: c.time_ms as i64,
            end_ms: Some(c.end_ms as i64),
            text: c.text,
            words: if c.words.is_empty() {
                None
            } else {
                Some(
                    c.words
                        .into_iter()
                        .map(|w| crate::lyrics::WordTiming { word: w.word, start_ms: w.start_ms as i64, end_ms: w.end_ms as i64 })
                        .collect(),
                )
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_is_a_no_op_at_the_target_rate() {
        let s: Vec<f32> = (0..100).map(|i| i as f32).collect();
        assert_eq!(resample_to_16k(&s, SAMPLE_RATE), s);
    }

    #[test]
    fn downsampling_48k_to_16k_thirds_the_length() {
        let s = vec![0.5f32; 48_000];
        let out = resample_to_16k(&s, 48_000);
        assert_eq!(out.len(), 16_000);
        // A constant signal must stay constant through interpolation.
        assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn upsampling_8k_to_16k_doubles_the_length() {
        let s = vec![0.25f32; 8_000];
        assert_eq!(resample_to_16k(&s, 8_000).len(), 16_000);
    }

    #[test]
    fn resampling_preserves_a_ramp_monotonically() {
        let s: Vec<f32> = (0..48_000).map(|i| i as f32 / 48_000.0).collect();
        let out = resample_to_16k(&s, 48_000);
        assert!(out.windows(2).all(|w| w[1] >= w[0]), "interpolation must not reorder a monotonic signal");
        assert!((out[0] - 0.0).abs() < 1e-3);
        assert!((out[out.len() - 1] - 1.0).abs() < 1e-2);
    }

    #[test]
    fn empty_and_degenerate_input_does_not_panic() {
        assert!(resample_to_16k(&[], 44_100).is_empty());
        assert!(resample_to_16k(&[1.0], 0).len() == 1);
    }

    #[test]
    fn cues_carry_their_word_timing_across_the_conversion() {
        let cues = vec![Cue {
            time_ms: 100,
            end_ms: 900,
            text: "two words".into(),
            words: vec![
                inference_protocol::Word { word: "two".into(), start_ms: 100, end_ms: 400 },
                inference_protocol::Word { word: "words".into(), start_ms: 500, end_ms: 900 },
            ],
        }];
        let out = to_lyric_cues(cues);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].time_ms, 100);
        assert_eq!(out[0].end_ms, Some(900));
        let words = out[0].words.as_ref().expect("word timing must survive; align.rs needs it");
        assert_eq!(words.len(), 2);
        assert_eq!(words[1].word, "words");
        assert_eq!(words[1].start_ms, 500);
    }

    #[test]
    fn a_cue_without_words_converts_to_none_rather_than_an_empty_list() {
        let cues = vec![Cue { time_ms: 0, end_ms: 10, text: "x".into(), words: vec![] }];
        assert!(to_lyric_cues(cues)[0].words.is_none());
    }
}
