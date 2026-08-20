//! Whisper's log-mel front end.
//!
//! Whisper does not take audio. It takes an 80×3000 (or 128×3000 for
//! large-v3) log-mel spectrogram computed in one exact way, and a front end
//! that is subtly wrong produces a model that runs happily and transcribes
//! nonsense — there is no error, only bad words. So every constant here is the
//! one OpenAI's `whisper/audio.py` uses, and the tests check the output against
//! **transformers.js**, the library the WASM path being replaced already runs.
//! Matching an independent implementation is the strongest check available
//! without a reference recording; matching *this* one specifically means the
//! native path cannot regress what the WASM path already produces.
//!
//! The pipeline, in order:
//!
//! 1. Pad or truncate to exactly 30 s (480 000 samples at 16 kHz).
//! 2. Reflect-pad 200 samples either side, so frame *n* is centred on sample
//!    `n * 160` rather than starting there (`center=True` in torch's STFT).
//! 3. Per 400-sample frame, a periodic Hann window and a real FFT → 201 bins
//!    of power.
//! 4. Project through a Slaney-scaled, Slaney-normalised mel filterbank.
//! 5. `log10`, floored at 1e-10, then clamped to within 8 decades of the
//!    frame-set maximum, then `(x + 4) / 4`.
//!
//! Step 5's clamp is against the maximum of the WHOLE spectrogram, not per
//! frame. That makes the features depend on the loudest moment in the window,
//! which is why the window has to be a fixed 30 s rather than "however much
//! audio we happen to have".

use rustfft::{num_complex::Complex, Fft, FftPlanner};

pub const SAMPLE_RATE: u32 = 16_000;
/// STFT window length in samples (25 ms).
pub const N_FFT: usize = 400;
/// STFT hop in samples (10 ms) — so one mel frame is 10 ms of audio.
pub const HOP: usize = 160;
/// Whisper's context window: 30 s.
pub const CHUNK_SAMPLES: usize = 480_000;
/// Mel frames per chunk. `CHUNK_SAMPLES / HOP` exactly.
pub const N_FRAMES: usize = 3_000;
/// Real FFT bins kept, `N_FFT / 2 + 1`.
const N_BINS: usize = N_FFT / 2 + 1;
/// Mel bands for every Whisper checkpoint except large-v3, which uses 128.
/// Read from the model's config once the encoder lands; this is the default.
pub const N_MELS: usize = 80;

/// Milliseconds of audio one mel frame covers. The DTW alignment pass converts
/// decoder attention positions back to timestamps with this, so it is not just
/// a comment — it is the unit of the timing this whole path exists to produce.
pub const FRAME_MS: f32 = (HOP as f32) * 1000.0 / (SAMPLE_RATE as f32);

/// Slaney mel scale, as used by librosa/HF with `mel_scale="slaney"`.
///
/// Linear below 1 kHz, logarithmic above — the two pieces meet at exactly
/// 15.0 mel, which is what makes the constants below look arbitrary.
fn hertz_to_mel(freq: f32) -> f32 {
    const MIN_LOG_HERTZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = 15.0;
    if freq >= MIN_LOG_HERTZ {
        let logstep = 27.0 / 6.4f32.ln();
        MIN_LOG_MEL + (freq / MIN_LOG_HERTZ).ln() * logstep
    } else {
        3.0 * freq / 200.0
    }
}

fn mel_to_hertz(mel: f32) -> f32 {
    const MIN_LOG_HERTZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = 15.0;
    if mel >= MIN_LOG_MEL {
        let logstep = 6.4f32.ln() / 27.0;
        MIN_LOG_HERTZ * (logstep * (mel - MIN_LOG_MEL)).exp()
    } else {
        200.0 * mel / 3.0
    }
}

/// The mel projection matrix: `n_mels` rows of `N_BINS` weights.
///
/// Row-major and dense. It is at most 128×201 f32 — 100 KB — so the sparsity
/// of a triangular filterbank is not worth the indirection a sparse layout
/// would cost inside the inner loop.
pub struct MelFilters {
    n_mels: usize,
    weights: Vec<f32>,
}

impl MelFilters {
    /// Build the filterbank Whisper was trained with: triangles evenly spaced
    /// on the Slaney mel scale between 0 and Nyquist, each scaled by
    /// `2 / (width in Hz)` so a flat-spectrum input reads flat across mels
    /// instead of louder in the wide high bands (`norm="slaney"`).
    pub fn slaney(n_mels: usize) -> Self {
        // Bin centre frequencies: linspace(0, sr/2, N_BINS).
        let fft_freqs: Vec<f32> = (0..N_BINS)
            .map(|i| (SAMPLE_RATE as f32 / 2.0) * i as f32 / (N_BINS - 1) as f32)
            .collect();

        // n_mels + 2 band edges, evenly spaced in mel: each filter spans the
        // edge before it to the edge after it, so it needs one extra on each end.
        let mel_min = hertz_to_mel(0.0);
        let mel_max = hertz_to_mel(SAMPLE_RATE as f32 / 2.0);
        let filter_freqs: Vec<f32> = (0..n_mels + 2)
            .map(|i| mel_to_hertz(mel_min + (mel_max - mel_min) * i as f32 / (n_mels + 1) as f32))
            .collect();

        let mut weights = vec![0f32; n_mels * N_BINS];
        for m in 0..n_mels {
            let lower = filter_freqs[m];
            let centre = filter_freqs[m + 1];
            let upper = filter_freqs[m + 2];
            let down_width = centre - lower;
            let up_width = upper - centre;
            // Slaney normalisation: unit area rather than unit peak.
            let enorm = 2.0 / (upper - lower);
            for (b, &f) in fft_freqs.iter().enumerate() {
                let rising = (f - lower) / down_width;
                let falling = (upper - f) / up_width;
                let w = rising.min(falling).max(0.0);
                weights[m * N_BINS + b] = w * enorm;
            }
        }
        Self { n_mels, weights }
    }

    pub fn n_mels(&self) -> usize {
        self.n_mels
    }

    /// One mel row's weights.
    pub fn row(&self, mel: usize) -> &[f32] {
        &self.weights[mel * N_BINS..(mel + 1) * N_BINS]
    }
}

/// Reusable log-mel extractor.
///
/// Holds the FFT plan, the window and the filterbank, because a transcription
/// runs this once per 30 s chunk and rebuilding a plan each time is pure waste.
///
/// PRECISION: the STFT runs in f32; only the power accumulation, the mel
/// projection and the log/clamp run in f64. That split was checked rather than
/// assumed — Whisper's features are clamped to eight decades below the window's
/// loudest bin, which is close enough to f32's noise floor to be worth
/// worrying about, so both variants were run against the transformers.js
/// reference. The f32 STFT agrees to **~1e-5** on every probe, against features
/// spanning a range of 2.0. The f64 STFT was not measurably better and is not
/// used.
pub struct MelSpectrogram {
    filters: MelFilters,
    window: Vec<f32>,
    fft: std::sync::Arc<dyn Fft<f32>>,
    /// Scratch, reused across frames so a 3000-frame chunk allocates nothing
    /// in its inner loop.
    buf: Vec<Complex<f32>>,
    padded: Vec<f32>,
}

impl MelSpectrogram {
    pub fn new(n_mels: usize) -> Self {
        // Periodic (not symmetric) Hann — `torch.hann_window`'s default, and
        // the wrong choice here shifts every frame's energy slightly.
        let window: Vec<f32> = (0..N_FFT)
            .map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()) as f32)
            .collect();
        let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        Self {
            filters: MelFilters::slaney(n_mels),
            window,
            fft,
            buf: vec![Complex { re: 0.0, im: 0.0 }; N_FFT],
            padded: vec![0f32; CHUNK_SAMPLES + N_FFT],
        }
    }

    /// Log-mel features for one 30 s chunk, row-major `[n_mels][N_FRAMES]`.
    ///
    /// `samples` shorter than a chunk is zero-padded and longer is truncated,
    /// which is what the model's fixed input shape requires; callers that care
    /// about the tail split the audio into chunks themselves.
    ///
    /// Complexity: O(N_FRAMES · (N_FFT log N_FFT + n_mels · N_BINS)) time,
    /// O(n_mels · N_FRAMES) space for the output.
    pub fn compute(&mut self, samples: &[f32]) -> Vec<f32> {
        self.pad_and_centre(samples);

        let n_mels = self.filters.n_mels();
        let mut out = vec![0f64; n_mels * N_FRAMES];
        let mut power = vec![0f64; N_BINS];

        for frame in 0..N_FRAMES {
            let start = frame * HOP;
            for i in 0..N_FFT {
                self.buf[i] = Complex { re: self.padded[start + i] * self.window[i], im: 0.0 };
            }
            self.fft.process(&mut self.buf);
            for (b, p) in power.iter_mut().enumerate() {
                let c = self.buf[b];
                *p = (c.re as f64) * (c.re as f64) + (c.im as f64) * (c.im as f64); // power, not magnitude
            }
            for m in 0..n_mels {
                let row = self.filters.row(m);
                let mut acc = 0f64;
                for b in 0..N_BINS {
                    acc += row[b] as f64 * power[b];
                }
                out[m * N_FRAMES + frame] = acc;
            }
        }

        log_normalise(&mut out)
    }

    /// Fill `self.padded` with the chunk, reflect-padded by `N_FFT / 2` either
    /// side so frame *n* is CENTRED on sample `n * HOP`.
    ///
    /// Reflection, not zeros: zeros at the edges would read as a sudden silence
    /// and put a broadband transient into the first and last frames, which is
    /// exactly where a song's first word tends to be.
    fn pad_and_centre(&mut self, samples: &[f32]) {
        let half = N_FFT / 2;
        let n = samples.len().min(CHUNK_SAMPLES);

        self.padded.fill(0.0);
        self.padded[half..half + n].copy_from_slice(&samples[..n]);

        // numpy's 'reflect' does not repeat the edge sample: the left pad is
        // x[half], x[half-1], ..., x[1].
        for i in 0..half {
            let mirror = (half - i).min(n.saturating_sub(1));
            self.padded[i] = if n > 0 { self.padded[half + mirror] } else { 0.0 };
        }
        // The signal is zero-padded out to CHUNK_SAMPLES before this, so the
        // right-hand pad reflects zeros for anything shorter than a chunk —
        // which is what the reference implementation does too, because it pads
        // to 30 s BEFORE computing the spectrogram.
        let end = half + CHUNK_SAMPLES;
        for i in 0..half {
            let src = end - 2 - i;
            self.padded[end + i] = self.padded[src];
        }
    }
}

/// `log10`, floored, dynamic-range clamped and rescaled; f64 in, f32 out.
///
/// The clamp is against the maximum of the whole spectrogram: Whisper was
/// trained on features whose quietest represented sound is 8 decades below the
/// loudest in the same 30 s, and clamping per frame instead would make a silent
/// frame's noise floor as loud as a chorus.
///
/// The narrowing to f32 happens here, at the end — f32 is what the model takes,
/// and there is no reason to lose bits before the logarithm.
fn log_normalise(spec: &mut [f64]) -> Vec<f32> {
    let mut max = f64::NEG_INFINITY;
    for v in spec.iter_mut() {
        *v = v.max(1e-10).log10();
        if *v > max {
            max = *v;
        }
    }
    let floor = max - 8.0;
    spec.iter().map(|v| ((v.max(floor) + 4.0) / 4.0) as f32).collect()
}

#[cfg(test)]
mod tests {
    use std::f32::consts::PI;

    use super::*;

    /// Reference values captured from transformers.js's `WhisperFeatureExtractor`
    /// (@huggingface/transformers 4.2.0), the implementation the WASM path in
    /// `whisper.js` runs today. Regenerate them with
    /// `node scripts/gen-mel-reference.mjs`, which prints this file's constants
    /// directly. Signal: 0.6·sin(2π·440t) + 0.3·sin(2π·1500t) + 0.1·sin(2π·5000t).
    ///
    /// Generated in **f64** and narrowed once at the end, because that is what
    /// the JavaScript did (`Math.sin` is f64; the result lands in a
    /// `Float32Array`). Computing it in f32 instead is not a rounding detail:
    /// at t ≈ 30 s the argument to `sin` is ~83 000 radians, where f32's seven
    /// digits leave the phase visibly wrong, the sine stops being periodic in
    /// the analysis window, and the leakage lifts every quiet mel band off the
    /// floor. The first version of this test did exactly that and read as a
    /// front-end bug.
    fn reference_signal(n: usize) -> Vec<f32> {
        use std::f64::consts::PI as PI64;
        (0..n)
            .map(|i| {
                let t = i as f64 / SAMPLE_RATE as f64;
                (0.6 * (2.0 * PI64 * 440.0 * t).sin()
                    + 0.3 * (2.0 * PI64 * 1500.0 * t).sin()
                    + 0.1 * (2.0 * PI64 * 5000.0 * t).sin()) as f32
            })
            .collect()
    }

    #[test]
    fn the_mel_scale_round_trips_through_its_own_inverse() {
        for hz in [0.0f32, 100.0, 700.0, 999.0, 1000.0, 1001.0, 4000.0, 8000.0] {
            let back = mel_to_hertz(hertz_to_mel(hz));
            assert!((back - hz).abs() < 0.01, "{hz} Hz round-tripped to {back}");
        }
    }

    #[test]
    fn the_two_pieces_of_the_mel_scale_meet_at_the_documented_point() {
        // The whole shape of the filterbank hangs off this junction being at
        // exactly 1000 Hz = 15 mel; a mismatch here mis-spaces every filter.
        assert!((hertz_to_mel(1000.0) - 15.0).abs() < 1e-4);
        assert!((mel_to_hertz(15.0) - 1000.0).abs() < 1e-2);
    }

    #[test]
    fn filters_are_triangles_that_march_up_the_spectrum() {
        let f = MelFilters::slaney(80);
        let mut previous_peak = 0usize;
        for m in 0..80 {
            let row = f.row(m);
            let peak = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(i, _)| i)
                .unwrap();
            assert!(row.iter().all(|&w| w >= 0.0), "filter {m} has a negative weight");
            assert!(peak >= previous_peak, "filter {m} peaks below filter {}", m - 1);
            previous_peak = peak;
        }
    }

    #[test]
    fn slaney_normalisation_makes_wide_high_filters_shorter_than_narrow_low_ones() {
        // This is the entire point of the norm: without it, the top filters
        // (which span thousands of Hz) would swamp the bottom ones (tens).
        let f = MelFilters::slaney(80);
        let low_peak = f.row(2).iter().cloned().fold(0f32, f32::max);
        let high_peak = f.row(79).iter().cloned().fold(0f32, f32::max);
        assert!(high_peak < low_peak, "high filter peaked at {high_peak}, low at {low_peak}");
    }

    #[test]
    fn a_chunk_produces_exactly_the_shape_the_model_expects() {
        let mut mel = MelSpectrogram::new(80);
        let out = mel.compute(&reference_signal(CHUNK_SAMPLES));
        assert_eq!(out.len(), 80 * N_FRAMES);
    }

    /// The reference numbers. A wrong window, a wrong filterbank, an off-by-one
    /// in the framing or a wrong normalisation each move these.
    #[test]
    fn a_full_chunk_matches_transformers_js() {
        let mut mel = MelSpectrogram::new(80);
        let out = mel.compute(&reference_signal(CHUNK_SAMPLES));

        let (min, max, mean) = stats(&out);
        assert_close(min, -0.522205, 1e-4, "min");
        assert_close(max, 1.477795, 1e-4, "max");
        assert_close(mean, -0.251642, 1e-4, "mean");
    }

    #[test]
    fn short_audio_is_padded_to_a_chunk_the_way_the_reference_pads_it() {
        // 1 s of tone, 29 s of silence. The dynamic-range clamp is global, so
        // the silence is what sets the floor — a per-frame clamp would show up
        // here as a completely different mean.
        let mut mel = MelSpectrogram::new(80);
        let out = mel.compute(&reference_signal(SAMPLE_RATE as usize));

        let (min, max, mean) = stats(&out);
        assert_close(min, -0.522205, 1e-4, "min");
        assert_close(max, 1.477795, 1e-4, "max");
        assert_close(mean, -0.512050, 1e-4, "mean");
    }

    #[test]
    fn individual_cells_match_the_reference_across_the_spectrogram() {
        let mut mel = MelSpectrogram::new(80);
        let out = mel.compute(&reference_signal(CHUNK_SAMPLES));
        // (mel, frame, expected) sampled from transformers.js. Frames 0 and
        // 2999 are the ones that catch a padding mistake; the middle ones catch
        // a filterbank or window mistake.
        for &(m, f, want) in REFERENCE_CELLS {
            let got = out[m * N_FRAMES + f];
            assert!(
                (got - want).abs() < 1e-4,
                "mel {m} frame {f}: got {got}, transformers.js says {want}"
            );
        }
    }

    #[test]
    fn silence_produces_a_flat_floor_rather_than_nan() {
        // log10(0) is -inf; the 1e-10 floor is what stops that reaching the
        // model as a NaN once it is scaled.
        let mut mel = MelSpectrogram::new(80);
        let out = mel.compute(&vec![0.0; CHUNK_SAMPLES]);
        assert!(out.iter().all(|v| v.is_finite()), "silence produced a non-finite feature");
        let first = out[0];
        assert!(out.iter().all(|v| (v - first).abs() < 1e-6), "silence was not flat");
    }

    #[test]
    fn a_pure_tone_lands_in_the_mel_band_that_contains_it() {
        // 440 Hz sits in the linear part of the scale: mel = 3*440/200 = 6.6,
        // and with 80 filters spanning 0..~45 mel that is filter ~11.
        let mut mel = MelSpectrogram::new(80);
        let tone: Vec<f32> = (0..CHUNK_SAMPLES)
            .map(|i| (2.0 * PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let out = mel.compute(&tone);

        let mid = N_FRAMES / 2;
        let loudest = (0..80)
            .max_by(|&a, &b| out[a * N_FRAMES + mid].partial_cmp(&out[b * N_FRAMES + mid]).unwrap())
            .unwrap();
        let expected = hertz_to_mel(440.0) / hertz_to_mel(8000.0) * 81.0;
        assert!(
            (loudest as f32 - expected).abs() < 2.0,
            "440 Hz peaked in mel {loudest}, expected near {expected:.1}"
        );
    }

    #[test]
    fn longer_than_a_chunk_is_truncated_rather_than_folded() {
        let mut mel = MelSpectrogram::new(80);
        let long = reference_signal(CHUNK_SAMPLES + 50_000);
        let exact = reference_signal(CHUNK_SAMPLES);
        assert_eq!(mel.compute(&long), mel.compute(&exact));
    }

    #[test]
    fn the_extractor_is_reusable_without_state_leaking_between_calls() {
        // It reuses its scratch buffers; a chunk must not be able to see the
        // tail of the previous one.
        let mut mel = MelSpectrogram::new(80);
        let loud = mel.compute(&reference_signal(CHUNK_SAMPLES));
        let _ = mel.compute(&vec![0.0; CHUNK_SAMPLES]);
        let again = mel.compute(&reference_signal(CHUNK_SAMPLES));
        assert_eq!(loud, again);
    }

    #[test]
    fn a_frame_is_ten_milliseconds() {
        // DTW converts attention positions to timestamps with this constant.
        assert!((FRAME_MS - 10.0).abs() < 1e-6);
        assert_eq!(CHUNK_SAMPLES / HOP, N_FRAMES);
    }

    fn stats(v: &[f32]) -> (f32, f32, f32) {
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        let mut sum = 0f64;
        for &x in v {
            if x < min {
                min = x;
            }
            if x > max {
                max = x;
            }
            sum += x as f64;
        }
        (min, max, (sum / v.len() as f64) as f32)
    }

    fn assert_close(got: f32, want: f32, tol: f32, what: &str) {
        assert!((got - want).abs() < tol, "{what}: got {got}, transformers.js says {want}");
    }

    /// `(mel, frame, value)` from transformers.js, for the 30 s reference
    /// signal. Placed last because it is data, not logic.
    ///
    /// Frames 0, 1 and 2999 are the interesting ones: they sit against the
    /// reflect padding, where a sine that starts at zero with positive slope
    /// gets mirrored into a corner and splatters energy across every band.
    /// That is why they read loud in mel bands the tone has no energy in — and
    /// it is exactly what makes them a sharp test of the padding.
    const REFERENCE_CELLS: &[(usize, usize, f32)] = &[
        (0, 0, 1.053216),
        (0, 1, 0.541324),
        (0, 2, -0.522205),
        (0, 50, -0.522205),
        (0, 99, -0.522205),
        (0, 100, -0.522205),
        (0, 1499, -0.522205),
        (0, 2999, 0.541116),
        (1, 0, 1.056179),
        (1, 1, 0.545016),
        (1, 2, -0.522205),
        (1, 50, -0.522205),
        (1, 99, -0.522205),
        (1, 100, -0.522205),
        (1, 1499, -0.522205),
        (1, 2999, 0.545550),
        (13, 0, 1.281173),
        (13, 1, 0.526957),
        (13, 2, -0.522205),
        (13, 50, -0.522205),
        (13, 99, -0.522205),
        (13, 100, -0.522205),
        (13, 1499, -0.522205),
        (13, 2999, 0.538288),
        (40, 0, 0.896933),
        (40, 1, 0.390617),
        (40, 2, 0.025099),
        (40, 50, 0.025099),
        (40, 99, 0.025098),
        (40, 100, 0.025099),
        (40, 1499, 0.025098),
        (40, 2999, 0.354671),
        (79, 0, 0.334240),
        (79, 1, -0.175919),
        (79, 2, -0.522205),
        (79, 50, -0.522205),
        (79, 99, -0.522205),
        (79, 100, -0.522205),
        (79, 1499, -0.522205),
        (79, 2999, -0.479864),
    ];
}
