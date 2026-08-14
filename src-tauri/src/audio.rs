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
//! latest 1024-sample waveform and a 512-bin spectrum (both as base64 bytes,
//! matching the AnalyserNode's `minDecibels`/`maxDecibels`/smoothing so the DSP
//! thresholds in audio.js stay valid).
//!
//! Runtime behaviour is Windows-only; other targets get no-op stubs so the
//! crate still builds cross-platform.

use tauri::AppHandle;

#[cfg(windows)]
pub fn start_capture(app: AppHandle) {
    imp::start(app);
}

#[cfg(windows)]
pub fn stop_capture() {
    imp::stop();
}

#[cfg(not(windows))]
pub fn start_capture(_app: AppHandle) {}

#[cfg(not(windows))]
pub fn stop_capture() {}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use base64::Engine;
    use rustfft::{num_complex::Complex, FftPlanner};
    use serde_json::json;
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
    const MIN_DB: f32 = -95.0; // matches buildAnalyser() in audio.js
    const MAX_DB: f32 = -12.0;
    const SMOOTH: f32 = 0.55; // smoothingTimeConstant
    const EMIT_EVERY: Duration = Duration::from_millis(20); // ~50 Hz

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
        let bytes_per_sample = (bits / 8).max(1);
        let frame_bytes = bytes_per_sample * channels;

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

        // Circular buffer of the most recent mono samples.
        let mut ring = [0f32; FFT];
        let mut widx = 0usize;
        let win = blackman();
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT);
        let mut smooth = [0f32; BINS];
        let mut last_emit = Instant::now();

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
                    ring[widx] = mono;
                    widx = (widx + 1) % FFT;
                }
                capture.ReleaseBuffer(num_frames)?;
            }

            if last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                emit_frame(app, &ring, widx, &win, &*fft, &mut smooth);
            }
        }

        let _ = client.Stop();
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

    /// Build the waveform + spectrum bytes and emit them.
    fn emit_frame(
        app: &AppHandle,
        ring: &[f32; FFT],
        widx: usize,
        win: &[f32; FFT],
        fft: &dyn rustfft::Fft<f32>,
        smooth: &mut [f32; BINS],
    ) {
        // Unwrap the circular buffer into chronological order.
        let mut time_bytes = [128u8; FFT];
        let mut buf = vec![Complex { re: 0.0f32, im: 0.0f32 }; FFT];
        for i in 0..FFT {
            let s = ring[(widx + i) % FFT];
            // getByteTimeDomainData: 128 = zero-crossing, full-scale spans 0..255.
            let t = (s * 128.0 + 128.0).clamp(0.0, 255.0);
            time_bytes[i] = t as u8;
            buf[i] = Complex { re: s * win[i], im: 0.0 };
        }

        fft.process(&mut buf);

        let mut freq_bytes = [0u8; BINS];
        let scale = 255.0 / (MAX_DB - MIN_DB);
        for i in 0..BINS {
            let mag = (buf[i].re * buf[i].re + buf[i].im * buf[i].im).sqrt() / FFT as f32;
            // Web Audio smooths the linear magnitude before the dB conversion.
            smooth[i] = SMOOTH * smooth[i] + (1.0 - SMOOTH) * mag;
            let db = 20.0 * smooth[i].max(1e-9).log10();
            freq_bytes[i] = ((db - MIN_DB) * scale).clamp(0.0, 255.0) as u8;
        }

        let b64 = base64::engine::general_purpose::STANDARD;
        let _ = app.emit(
            "native-audio",
            json!({ "t": b64.encode(time_bytes), "f": b64.encode(freq_bytes) }),
        );
    }
}
