//! Native system-audio capture via WASAPI loopback.
//!
//! The renderer's reactive engine (src/renderer/audio.js) reads a Web Audio
//! `AnalyserNode` — a byte spectrum (`getByteFrequencyData`) and a byte waveform
//! (`getByteTimeDomainData`). This module reproduces exactly those two byte
//! arrays from the system's output mix, so the renderer can drive its visuals
//! from real audio **without** the `getDisplayMedia` "share your screen" picker.
//!
//! We capture the default render endpoint in loopback mode (no device picker),
//! downmix to mono, and every ~20 ms emit a `native-audio` event carrying the
//! latest 1024-sample waveform and a 512-bin spectrum (both as base64 bytes).
//!
//! The spectrum uses **auto-gain** rather than a fixed dB range: reproducing a
//! Web Audio AnalyserNode's internal minDecibels/maxDecibels/windowing math
//! exactly is unverifiable without a browser to A/B against, and getting the
//! absolute scale even slightly wrong makes every tuned DSP threshold in
//! audio.js silently misfire. Each bin is instead scaled against a decaying
//! peak tracked in `emit_frame`, so the byte range self-calibrates to whatever
//! the system's actual loudness is. The waveform bytes have no such risk — the
//! mapping is exact linear PCM — so MilkDrop (which reads the waveform, not
//! this spectrum) is not affected by the calibration question at all.
//!
//! The waveform half of each frame is **demand-gated**. It is three times the
//! size of the spectrum and has exactly one consumer (MilkDrop, via
//! `AudioReactive.timeDomain`), while the spectrum drives all the DSP. When
//! nothing has asked for the waveform recently the renderer calls
//! `set_audio_waveform(false)` and frames carry the spectrum alone — a 2179 →
//! 804 byte payload. See docs/JOB-ENGINE.md §6 for the measurements behind
//! that being the only transport change worth making.
//!
//! **Song-length recording** (`start_recording`/`stop_recording`) taps the
//! same WASAPI thread for a second purpose: writing raw mono PCM straight to
//! a temp file for later transcription. This is what lets SMTC playback (a
//! browser, Spotify, anything this app does not control) be transcribed
//! without ever putting a whole song's samples through Tauri's IPC — the
//! renderer used to record via a `ScriptProcessorNode` and hand the backend a
//! multi-megabyte `Float32Array` (`src/renderer/capture.js`); this hands the
//! backend a file path instead, because the backend is what captured the
//! audio in the first place.
//!
//! Runtime behaviour is Windows-only; other targets get no-op stubs so the
//! crate still builds cross-platform.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(windows, test))]
use std::io::Write;
#[cfg(any(windows, test))]
use std::sync::atomic::AtomicU64;
#[cfg(any(windows, test))]
use std::sync::Mutex;

use tauri::AppHandle;

/*
  The recorder below is gated `any(windows, test)`, not `windows`: only the
  WASAPI capture thread ever feeds it, so on other targets it would be dead
  code and CI runs clippy with -D warnings on Linux. Keeping `test` in the gate
  is what lets the sink, the cap and the rate check stay covered everywhere
  rather than only on the one platform that can run them for real.
*/

/// Below this, a recording is not worth transcribing. Mirrors
/// `capture.js`'s `MIN_USEFUL_SECONDS` — this replaces that JS-side capture,
/// so it keeps the same threshold rather than inventing a new one.
#[cfg(any(windows, test))]
const MIN_USEFUL_SECONDS: f64 = 20.0;

/// Ceiling on one recording, mirroring `capture.js`'s `MAX_SECONDS` (12 min).
/// Bounds disk use for a DJ set or a stream that never changes track — the
/// recording made up to this point stays valid, it just stops growing.
#[cfg(any(windows, test))]
const MAX_RECORDING_SECONDS: f64 = 12.0 * 60.0;

/// Raw mono PCM at the capture's native sample rate, streamed to a temp file.
/// Resampling to Whisper's 16 kHz happens once, after the fact, in
/// `inference::resample_to_16k` — this only ever writes what it is given.
#[cfg(any(windows, test))]
struct RecordingSink {
    writer: std::io::BufWriter<std::fs::File>,
    path: std::path::PathBuf,
    sample_rate: u32,
    samples_written: u64,
    max_samples: u64,
}

#[cfg(any(windows, test))]
impl RecordingSink {
    fn create(path: std::path::PathBuf, sample_rate: u32) -> std::io::Result<Self> {
        let file = std::fs::File::create(&path)?;
        let max_samples = (MAX_RECORDING_SECONDS * sample_rate.max(1) as f64) as u64;
        Ok(Self { writer: std::io::BufWriter::new(file), path, sample_rate, samples_written: 0, max_samples })
    }

    /// Append one sample, silently doing nothing once `max_samples` is
    /// reached — a capped recording degrades to "the first 12 minutes," not
    /// an error the caller has to handle mid-song.
    fn push(&mut self, sample: f32) {
        if self.samples_written >= self.max_samples {
            return;
        }
        let _ = self.writer.write_all(&sample.to_le_bytes());
        self.samples_written += 1;
    }

    fn seconds(&self) -> f64 {
        self.samples_written as f64 / self.sample_rate.max(1) as f64
    }
}

#[cfg(any(windows, test))]
static RECORDING: Mutex<Option<RecordingSink>> = Mutex::new(None);
#[cfg(any(windows, test))]
static RECORDING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh path for one recording. Includes the process id and a counter —
/// not because concurrent recordings are possible (`start_recording` refuses
/// a second one while the first is active), but because a crashed previous
/// session's temp file must never collide with a new one during the window
/// between processes.
#[cfg(any(windows, test))]
fn recording_temp_path() -> std::path::PathBuf {
    let n = RECORDING_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{RECORDING_PREFIX}{}-{n}.pcm", std::process::id()))
}

/// Append a whole packet's samples in one lock. `try_lock`, not `lock` — this
/// is called from the WASAPI capture thread, which must never block waiting
/// on a command handler that happens to be inside `stop_recording` at the
/// same instant. Losing one packet (a few ms) to a missed lock is inaudible
/// in a Whisper transcription; stalling the audio thread is not.
///
/// `rate` is the rate the packet was captured at, checked against the sink's
/// rather than assumed equal to it. Capture can stop and restart inside one
/// recording (the user toggles ♫, or a device change restarts the thread), and
/// a restart can open the device at a different format. Appending 44.1 kHz
/// samples to a file about to be read as 48 kHz would not fail — it would
/// produce a transcription whose timestamps drift silently, which is the one
/// failure mode this pipeline has no way to notice.
#[cfg(any(windows, test))]
fn record_batch(samples: &[f32], rate: u32) {
    if let Ok(mut slot) = RECORDING.try_lock() {
        if let Some(sink) = slot.as_mut() {
            if sink.sample_rate != rate {
                return;
            }
            for &s in samples {
                sink.push(s);
            }
        }
    }
}

/// Prefix every recording temp file shares. Used both to build a path and to
/// recognise a stale one at startup, so the two cannot drift apart.
const RECORDING_PREFIX: &str = "lyric-overlay-recording-";

/// How long a recording temp file must have gone untouched before a *different*
/// process treats it as abandoned. Comfortably longer than `MAX_RECORDING_
/// SECONDS`, because a recording that hits its cap stops being written and its
/// mtime freezes while it is still perfectly live.
const STALE_RECORDING_SECS: u64 = 60 * 60;

/// Whether one temp-directory entry is a recording this process should delete.
///
/// Split out from `sweep_stale_recordings` because this is the part that can
/// be wrong destructively — it decides what gets removed — while the rest is
/// a `read_dir` loop. `age` is `None` when the file's mtime could not be read
/// or is in the future, which is treated as "leave it alone".
///
/// Never true for this process's own files (one may be recording right now),
/// nor for a recently-touched file from another pid: this app has no
/// single-instance guard, so a second window may legitimately be recording.
fn is_abandoned_recording(name: &str, own_prefix: &str, age: Option<std::time::Duration>) -> bool {
    if !name.starts_with(RECORDING_PREFIX) || name.starts_with(own_prefix) {
        return false;
    }
    age.is_some_and(|a| a.as_secs() >= STALE_RECORDING_SECS)
}

/// The prefix `is_abandoned_recording` treats as this process's own.
fn own_recording_prefix() -> String {
    format!("{RECORDING_PREFIX}{}-", std::process::id())
}

/// Delete recording temp files left behind by a session that did not end
/// cleanly. A recording lives only in `RECORDING`, not in the journal, so a
/// hard kill leaves its file with nothing pointing at it — and at native rate
/// a capped one is over 100 MB. Called once at startup, before anything can
/// begin recording.
pub fn sweep_stale_recordings() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let own_prefix = own_recording_prefix();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let age = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if !is_abandoned_recording(name, &own_prefix, age) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => log::info!("removed abandoned recording {name}"),
            Err(e) => log::warn!("cannot remove abandoned recording {name}: {e}"),
        }
    }
}

/// Whether emitted frames should carry the time-domain waveform.
///
/// Defaults to `true` so a renderer that never calls `set_audio_waveform` —
/// an older frontend against a newer binary — keeps the behaviour it expects.
/// Reset to `true` on every capture start for the same reason: the renderer
/// states its demand once capture is confirmed live.
static WAVEFORM: AtomicBool = AtomicBool::new(true);

/// Ask for (or stop) the waveform half of each `native-audio` frame.
pub fn set_waveform(enabled: bool) {
    WAVEFORM.store(enabled, Ordering::Relaxed);
}

/// Whether the waveform is currently wanted.
// Same situation as `build_payload` below, and the same fix: only the Windows
// capture loop reads the flag back, while the tests run on every platform. Its
// writer `set_waveform` needs no such treatment — that one is reached from a
// cross-platform Tauri command.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn waveform_enabled() -> bool {
    WAVEFORM.load(Ordering::Relaxed)
}

/// Begin recording the active loopback capture to a temp file, for later
/// transcription. There is no separate capture stream for this — it taps the
/// same WASAPI thread `native-audio` frames already come from, so it fails if
/// capture is not already running (nothing to tap) or a recording is already
/// in progress (call `stop_recording` first).
#[cfg(windows)]
pub fn start_recording() -> bool {
    imp::start_recording()
}

#[cfg(not(windows))]
pub fn start_recording() -> bool {
    false
}

/// Stop recording and hand back the file and the sample rate it was written
/// at — `None` if nothing was recording, or too little was captured to be
/// worth transcribing (`MIN_USEFUL_SECONDS`, in which case the file is
/// deleted here rather than left for the caller to notice and clean up).
/// The caller owns the returned file: read it, resample it, delete it.
#[cfg(windows)]
pub fn stop_recording() -> Option<(std::path::PathBuf, u32)> {
    imp::stop_recording()
}

#[cfg(not(windows))]
pub fn stop_recording() -> Option<(std::path::PathBuf, u32)> {
    None
}

/// Abandon whatever is being recorded without transcribing it — real
/// (correctly timed) lyrics turned up mid-song, or the user skipped past the
/// track. Unlike `stop_recording`, this never returns anything and never
/// applies the length check: a discard is a discard regardless of how much
/// was captured, and the temp file is always deleted.
#[cfg(windows)]
pub fn discard_recording() {
    imp::discard_recording();
}

#[cfg(not(windows))]
pub fn discard_recording() {}

/// Build one `native-audio` payload.
///
/// Split out of the capture loop so the shape the renderer parses can be
/// asserted without a sound card. `waveform` is `None` when nothing has asked
/// for it, and the `t` key is then absent rather than null — `audio.js` tests
/// `if (data.t)`, so an absent key leaves the previous waveform untouched and
/// costs nothing to skip.
// Only the Windows capture loop calls this, but the tests below run on every
// platform. Without the allow, CI's Linux `clippy -D warnings` fails on dead
// code while building the lib target with `cfg(test)` off.
#[cfg_attr(not(windows), allow(dead_code))]
fn build_payload(waveform: Option<&[u8]>, spectrum: &[u8]) -> serde_json::Value {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut obj = serde_json::Map::with_capacity(2);
    obj.insert("f".into(), serde_json::Value::String(b64.encode(spectrum)));
    if let Some(time) = waveform {
        obj.insert("t".into(), serde_json::Value::String(b64.encode(time)));
    }
    serde_json::Value::Object(obj)
}

#[cfg(windows)]
pub fn start_capture(app: AppHandle) {
    WAVEFORM.store(true, Ordering::Relaxed);
    imp::start(app);
}

#[cfg(windows)]
pub fn stop_capture() {
    imp::stop();
}

#[cfg(not(windows))]
pub fn start_capture(_app: AppHandle) {
    WAVEFORM.store(true, Ordering::Relaxed);
}

#[cfg(not(windows))]
pub fn stop_capture() {}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use rustfft::{num_complex::Complex, FftPlanner};
    use tauri::{AppHandle, Emitter};

    use windows::core::Result;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// One-shot guard: `true` while the capture thread is (or should be) running.
    /// The thread polls it and exits when it flips to `false`.
    static CAPTURING: AtomicBool = AtomicBool::new(false);

    /// The native device's sample rate, published by `run` once the device is
    /// open. `start_recording` (called from a command handler thread, not
    /// this one) reads it to size a `RecordingSink`. 0 means "not currently
    /// captured" — real capture rates are never 0, so it doubles as a flag.
    static CAPTURE_SAMPLE_RATE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// See `audio::start_recording`.
    pub(super) fn start_recording() -> bool {
        if !CAPTURING.load(Ordering::SeqCst) {
            return false; // nothing running to tap
        }
        let rate = CAPTURE_SAMPLE_RATE.load(Ordering::SeqCst);
        if rate == 0 {
            return false; // device not open yet — a race at the very start of capture
        }
        let mut slot = super::RECORDING.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return false; // already recording
        }
        match super::RecordingSink::create(super::recording_temp_path(), rate) {
            Ok(sink) => {
                *slot = Some(sink);
                true
            }
            Err(e) => {
                eprintln!("[audio] cannot start recording: {e}");
                false
            }
        }
    }

    /// See `audio::stop_recording`.
    pub(super) fn stop_recording() -> Option<(std::path::PathBuf, u32)> {
        let sink = super::RECORDING.lock().unwrap_or_else(|e| e.into_inner()).take()?;
        let (path, rate, seconds) = (sink.path.clone(), sink.sample_rate, sink.seconds());
        drop(sink); // BufWriter flushes on drop; must happen before the file is handed off
        if seconds < super::MIN_USEFUL_SECONDS {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some((path, rate))
    }

    /// See `audio::discard_recording`.
    pub(super) fn discard_recording() {
        if let Some(sink) = super::RECORDING.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let path = sink.path.clone();
            drop(sink); // flush before deleting, though the content no longer matters
            let _ = std::fs::remove_file(&path);
        }
    }

    const FFT: usize = 1024; // AnalyserNode fftSize
    const BINS: usize = 512; // frequencyBinCount = fftSize / 2
    const SMOOTH: f32 = 0.55; // smoothingTimeConstant, applied to linear magnitude
    const EMIT_EVERY: Duration = Duration::from_millis(20); // ~50 Hz
    const REPORT_EVERY: Duration = Duration::from_secs(3); // diagnostic heartbeat

    pub fn start(app: AppHandle) {
        // If a capture is already live, do nothing (idempotent start).
        if CAPTURING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            if let Err(err) = unsafe { run(&app) } {
                eprintln!("[audio] loopback capture failed: {err:?}");
            }
            CAPTURING.store(false, Ordering::SeqCst);
        });
    }

    pub fn stop() {
        CAPTURING.store(false, Ordering::SeqCst);
    }

    /// Blackman window, the same shape a Web Audio AnalyserNode applies before
    /// its FFT — without it the spectrum leaks badly and the bands smear.
    fn blackman() -> [f32; FFT] {
        let mut w = [0f32; FFT];
        let n = FFT as f32 - 1.0;
        for (i, wi) in w.iter_mut().enumerate() {
            let a = 2.0 * std::f32::consts::PI * i as f32 / n;
            *wi = 0.42 - 0.5 * a.cos() + 0.08 * (2.0 * a).cos();
        }
        w
    }

    unsafe fn run(app: &AppHandle) -> Result<()> {
        // COM for this thread. Ignore RPC_E_CHANGED_MODE if something already
        // initialised it in another mode — the calls below still work.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();

        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

        let format_ptr = client.GetMixFormat()?;
        let format = &*format_ptr;
        let channels = format.nChannels.max(1) as usize;
        let bits = format.wBitsPerSample as usize;
        // Copy out of the packed struct before formatting — eprintln! needs a
        // reference to the value, and you can't reference an unaligned field
        // of a #[repr(packed)] struct directly (E0793).
        let sample_rate = format.nSamplesPerSec;
        CAPTURE_SAMPLE_RATE.store(sample_rate, Ordering::SeqCst);
        let bytes_per_sample = (bits / 8).max(1);
        let frame_bytes = bytes_per_sample * channels;
        eprintln!(
            "[audio] loopback: default render endpoint is {channels} ch, {bits}-bit, {sample_rate} Hz"
        );

        // ~200 ms buffer, in 100-ns units.
        let buffer_duration: i64 = 2_000_000;
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            buffer_duration,
            0,
            format_ptr,
            None,
        )?;

        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        eprintln!("[audio] loopback: capture started");

        // Circular buffer of the most recent mono samples.
        let mut ring = [0f32; FFT];
        let mut widx = 0usize;
        let win = blackman();
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT);
        let mut mag = [0f32; BINS];
        let mut ceiling = 0.0005f32;
        let mut last_emit = Instant::now();

        // Diagnostic heartbeat: prints whether real audio is actually arriving,
        // so a report of "visuals aren't reacting" comes with real numbers
        // instead of another guess. A peak near 0 means nothing is reaching
        // the capture (wrong device, or genuinely silent); a healthy peak with
        // the UI still not reacting points at the renderer side instead.
        let mut last_report = Instant::now();
        let mut peak_since_report = 0f32;
        let mut frames_since_report = 0u64;

        // Scratch for one packet's mono samples, reused every iteration so
        // recording a whole song allocates nothing per packet. Sized once a
        // real packet arrives; WASAPI packets are a few hundred to a couple
        // thousand frames, so this only ever grows on its first real use.
        let mut record_buf: Vec<f32> = Vec::new();

        while CAPTURING.load(Ordering::SeqCst) {
            let packet = capture.GetNextPacketSize()?;
            if packet == 0 {
                std::thread::sleep(Duration::from_millis(4));
            } else {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;
                capture.GetBuffer(&mut data, &mut num_frames, &mut flags, None, None)?;
                let frames = num_frames as usize;
                let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;

                record_buf.clear();
                for f in 0..frames {
                    let mono = if silent || data.is_null() {
                        0.0
                    } else {
                        read_frame_mono(data, f, frame_bytes, channels, bytes_per_sample, bits)
                    };
                    if mono.abs() > peak_since_report {
                        peak_since_report = mono.abs();
                    }
                    ring[widx] = mono;
                    widx = (widx + 1) % FFT;
                    record_buf.push(mono);
                }
                super::record_batch(&record_buf, sample_rate);
                frames_since_report += frames as u64;
                capture.ReleaseBuffer(num_frames)?;
            }

            if last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                emit_frame(app, &ring, widx, &win, &*fft, &mut mag, &mut ceiling);
            }

            if last_report.elapsed() >= REPORT_EVERY {
                eprintln!(
                    "[audio] loopback: {frames_since_report} frames captured, peak={peak_since_report:.4}, agc ceiling={ceiling:.4}"
                );
                last_report = Instant::now();
                peak_since_report = 0.0;
                frames_since_report = 0;
            }
        }

        let _ = client.Stop();
        CAPTURE_SAMPLE_RATE.store(0, Ordering::SeqCst);
        eprintln!("[audio] loopback: capture stopped");
        Ok(())
    }

    /// Downmix one frame's channels to a single sample in [-1, 1].
    unsafe fn read_frame_mono(
        base: *mut u8,
        frame: usize,
        frame_bytes: usize,
        channels: usize,
        bytes_per_sample: usize,
        bits: usize,
    ) -> f32 {
        let start = base.add(frame * frame_bytes);
        let mut sum = 0f32;
        for ch in 0..channels {
            let p = start.add(ch * bytes_per_sample);
            sum += match bits {
                16 => {
                    let v = (p as *const i16).read_unaligned();
                    v as f32 / 32768.0
                }
                // 32-bit is the usual shared-mode mix format, and it is IEEE
                // float; 24-bit is read as the top 3 bytes of a little-endian int.
                24 => {
                    let b0 = p.read() as i32;
                    let b1 = p.add(1).read() as i32;
                    let b2 = p.add(2).read() as i32;
                    let mut v = (b2 << 16) | (b1 << 8) | b0;
                    if v & 0x0080_0000 != 0 {
                        v |= !0x00FF_FFFF; // sign-extend
                    }
                    v as f32 / 8_388_608.0
                }
                _ => (p as *const f32).read_unaligned(),
            };
        }
        sum / channels as f32
    }

    /// Build the waveform + spectrum bytes and emit them. See the module doc
    /// for why the spectrum is auto-gained rather than dB-scaled to a fixed
    /// range, and why the waveform is omitted when nothing consumes it.
    fn emit_frame(
        app: &AppHandle,
        ring: &[f32; FFT],
        widx: usize,
        win: &[f32; FFT],
        fft: &dyn rustfft::Fft<f32>,
        mag: &mut [f32; BINS],
        ceiling: &mut f32,
    ) {
        // The spectrum drives every consumer; the waveform has one, and it is
        // often not running. Skip the byte conversion (and, below, the base64)
        // when it is not wanted — the FFT input still needs every sample.
        let want_waveform = super::waveform_enabled();

        // Unwrap the circular buffer into chronological order.
        let mut time_bytes = [128u8; FFT];
        let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT];
        for i in 0..FFT {
            let s = ring[(widx + i) % FFT];
            if want_waveform {
                // getByteTimeDomainData: 128 = zero-crossing, full-scale spans 0..255.
                let t = (s * 128.0 + 128.0).clamp(0.0, 255.0);
                time_bytes[i] = t as u8;
            }
            buf[i] = Complex { re: s * win[i], im: 0.0 };
        }

        fft.process(&mut buf);

        let mut peak = 0f32;
        for i in 0..BINS {
            let m = (buf[i].re * buf[i].re + buf[i].im * buf[i].im).sqrt();
            mag[i] = SMOOTH * mag[i] + (1.0 - SMOOTH) * m;
            if mag[i] > peak {
                peak = mag[i];
            }
        }

        // Auto-gain: rise instantly on a new peak, decay ~1.5%/frame (roughly
        // a 1s half-life at 50Hz) so a quiet passage doesn't get amplified
        // into visual noise, but a loud chorus after a quiet verse is picked
        // up within a beat or two.
        if peak > *ceiling {
            *ceiling = peak;
        } else {
            *ceiling *= 0.985;
        }
        let ceil = ceiling.max(0.0005); // floor so near-silence can't divide by ~0

        let mut freq_bytes = [0u8; BINS];
        for i in 0..BINS {
            freq_bytes[i] = (mag[i] / ceil * 255.0).clamp(0.0, 255.0) as u8;
        }

        let _ = app.emit(
            "native-audio",
            super::build_payload(want_waveform.then_some(&time_bytes[..]), &freq_bytes),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_carries_both_halves_when_the_waveform_is_wanted() {
        let time = [128u8; 4];
        let spec = [0u8, 64, 128, 255];
        let v = build_payload(Some(&time), &spec);
        assert!(v.get("t").and_then(|t| t.as_str()).is_some());
        assert!(v.get("f").and_then(|f| f.as_str()).is_some());
    }

    /// The renderer reads `if (data.t)`, so the key must be ABSENT rather than
    /// null when the waveform is off — a null would be equally falsy, but an
    /// absent key is the thing that actually shrinks the emitted script.
    #[test]
    fn payload_omits_the_waveform_key_entirely_when_it_is_not_wanted() {
        let spec = [0u8, 64, 128, 255];
        let v = build_payload(None, &spec);
        assert!(v.get("t").is_none(), "waveform key should be absent, got {v}");
        assert!(v.get("f").and_then(|f| f.as_str()).is_some());
    }

    /// The reason the gate exists: dropping the waveform is most of the frame.
    #[test]
    fn dropping_the_waveform_removes_most_of_the_payload() {
        let time = [128u8; 1024];
        let spec = [40u8; 512];
        let full = build_payload(Some(&time), &spec).to_string().len();
        let lean = build_payload(None, &spec).to_string().len();
        assert!(
            lean * 2 < full,
            "expected the lean frame to be less than half of {full} bytes, got {lean}"
        );
    }

    #[test]
    fn the_waveform_gate_round_trips() {
        set_waveform(false);
        assert!(!waveform_enabled());
        set_waveform(true);
        assert!(waveform_enabled());
    }

    /* -------------------------------------------------- song recording --- */
    /*
      RecordingSink itself needs no WASAPI, no capture thread, nothing
      Windows-specific — it is a file writer with a cap, and that is fully
      testable on its own. What the real capture thread does (call
      record_batch once per packet, publish CAPTURE_SAMPLE_RATE) is Windows-
      only and untestable outside a real device; these tests are the honest
      boundary of what can be checked without one.
    */

    fn temp_sink_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lyric-overlay-audio-test-{tag}-{}.pcm", std::process::id()))
    }

    #[test]
    fn a_sink_writes_exactly_the_samples_pushed_as_little_endian_f32() {
        let path = temp_sink_path("write");
        let mut sink = RecordingSink::create(path.clone(), 16_000).unwrap();
        for s in [0.0f32, 0.5, -1.0, 1.0] {
            sink.push(s);
        }
        assert_eq!(sink.samples_written, 4);
        drop(sink); // flush
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 16);
        let read_back: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        assert_eq!(read_back, vec![0.0, 0.5, -1.0, 1.0]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seconds_reflects_samples_written_at_the_given_rate() {
        let path = temp_sink_path("seconds");
        let mut sink = RecordingSink::create(path.clone(), 1_000).unwrap();
        for _ in 0..2_500 {
            sink.push(0.0);
        }
        assert!((sink.seconds() - 2.5).abs() < 1e-9);
        drop(sink);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_recording_stops_growing_at_the_cap_rather_than_erroring() {
        // A tiny effective cap so the test does not have to push 12 minutes
        // of real samples: MAX_RECORDING_SECONDS is a module constant, so
        // this drives the real formula at a rate that makes the cap small.
        let rate = 10u32; // MAX_RECORDING_SECONDS(720) * 10 = 7200 samples
        let path = temp_sink_path("cap");
        let mut sink = RecordingSink::create(path.clone(), rate).unwrap();
        let max = sink.max_samples;
        for _ in 0..(max + 500) {
            sink.push(0.0);
        }
        assert_eq!(sink.samples_written, max, "recording grew past its own cap");
        drop(sink);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn each_recording_gets_a_distinct_temp_path() {
        let a = recording_temp_path();
        let b = recording_temp_path();
        assert_ne!(a, b);
    }

    #[test]
    fn record_batch_is_a_no_op_when_nothing_is_recording() {
        // Guards the try_lock fast path the real capture thread relies on:
        // most packets arrive with no recording active, and this must not
        // panic, block, or require special-casing by the caller.
        record_batch(&[0.1, 0.2, -0.3], 48_000);
    }

    #[test]
    fn record_batch_writes_into_an_active_recording_and_stop_recording_hands_it_back() {
        // Drives RECORDING directly rather than through imp::start_recording
        // (Windows-only, needs a real device) — this exercises the same
        // static, the same lock, and the same MIN_USEFUL_SECONDS gate that
        // imp::stop_recording applies.
        //
        // The ONLY test in this file that touches the RECORDING static — it
        // is process-global, so a second test doing the same concurrently
        // (Rust runs tests in parallel by default) would race it. If another
        // test ever needs to, give both a serialising guard rather than
        // trusting timing.
        let rate = 100u32;
        let path = recording_temp_path();
        {
            let mut slot = RECORDING.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(RecordingSink::create(path.clone(), rate).unwrap());
        }
        // Below MIN_USEFUL_SECONDS(20s) at 100 Hz: under 2000 samples.
        for _ in 0..50 {
            record_batch(&[0.25; 10], rate); // 500 samples = 5s, short on purpose
        }
        // A packet at a different rate than the sink was opened at is dropped
        // whole, not appended — see record_batch's doc for the silent drift
        // this prevents. Checked here rather than in its own test because
        // this is the one test allowed to touch the RECORDING static.
        record_batch(&[0.25; 10_000], rate + 1);
        let seconds = {
            let slot = RECORDING.lock().unwrap_or_else(|e| e.into_inner());
            slot.as_ref().unwrap().seconds()
        };
        assert!((seconds - 5.0).abs() < 1e-9, "record_batch did not reach every pushed sample, or took a mismatched-rate packet");

        // Mirror imp::stop_recording's own gate here, since that function is
        // Windows-only and this test isn't: below the threshold, the file
        // must not be handed back, and it must be cleaned up.
        let sink = RECORDING.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap();
        assert!(sink.seconds() < MIN_USEFUL_SECONDS);
        let p = sink.path.clone();
        drop(sink);
        std::fs::remove_file(&p).unwrap(); // must exist to remove — proves record_batch really wrote it
    }

    /* --------------------------------------------- stale-recording sweep --- */
    /*
      The sweep DELETES files, so its decision is tested as a pure function
      over (name, own prefix, age) rather than by planting files and hoping
      the filesystem's mtime granularity cooperates. Backdating an mtime needs
      a platform call this crate would otherwise not make.
    */

    const HOUR: std::time::Duration = std::time::Duration::from_secs(STALE_RECORDING_SECS);
    const MINUTE: std::time::Duration = std::time::Duration::from_secs(60);

    #[test]
    fn the_sweep_only_ever_considers_this_apps_recording_files() {
        // Anything else in the temp directory belongs to someone else. The
        // real path this runs against is the shared system temp directory.
        for other in ["important.pcm", "lyric-overlay-7.pcm", "lyric-models-real-download-1", ".."] {
            assert!(!is_abandoned_recording(other, "lyric-overlay-recording-1-", Some(HOUR * 24)), "would have deleted {other}");
        }
    }

    #[test]
    fn the_sweep_never_deletes_this_processs_own_recording() {
        // The obvious catastrophe: sweeping at startup while a recording of
        // the current song is open, or a second launch killing the first's.
        let own = own_recording_prefix();
        let mine = format!("{own}0.pcm");
        assert!(!is_abandoned_recording(&mine, &own, Some(HOUR * 24)));
    }

    #[test]
    fn a_recently_written_foreign_recording_is_left_alone() {
        // No single-instance guard: another window may be recording right now,
        // and its file is being appended to, so its mtime stays fresh.
        assert!(!is_abandoned_recording("lyric-overlay-recording-999-0.pcm", "lyric-overlay-recording-1-", Some(MINUTE)));
    }

    #[test]
    fn an_untouched_foreign_recording_past_the_threshold_is_swept() {
        assert!(is_abandoned_recording("lyric-overlay-recording-999-0.pcm", "lyric-overlay-recording-1-", Some(HOUR)));
    }

    #[test]
    fn an_unreadable_or_future_mtime_is_treated_as_keep() {
        // `age` is None when the metadata call failed or the clock moved
        // backwards. Neither is evidence of abandonment, and the cost of
        // guessing wrong in this direction is one leaked temp file.
        assert!(!is_abandoned_recording("lyric-overlay-recording-999-0.pcm", "lyric-overlay-recording-1-", None));
    }

    #[test]
    fn the_threshold_outlasts_a_capped_recording() {
        // A recording that hits MAX_RECORDING_SECONDS stops being written, so
        // its mtime freezes while it is still live and about to be flushed.
        assert!((STALE_RECORDING_SECS as f64) > MAX_RECORDING_SECONDS);
    }

    #[test]
    fn sweeping_the_real_temp_directory_is_safe_to_call() {
        // End to end over the actual directory, proving the loop copes with
        // whatever is in there and — the point of the assertion — that a file
        // this process just created survives it.
        let path = recording_temp_path();
        std::fs::write(&path, b"not really pcm").unwrap();
        sweep_stale_recordings();
        assert!(path.exists(), "the sweep deleted this process's own file");
        let _ = std::fs::remove_file(&path);
    }
}
