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
//! Runtime behaviour is Windows-only; other targets get no-op stubs so the
//! crate still builds cross-platform.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

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
pub fn waveform_enabled() -> bool {
    WAVEFORM.load(Ordering::Relaxed)
}

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
                }
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
}
