//! Kaldi-style fbank front end for the speaker-embedding model (`diarize.rs`).
//!
//! Unlike Whisper's log-mel (`mel.rs`, OpenAI's own recipe), the wespeaker
//! ResNet34 export this app pins documents its own required recipe directly on
//! the model card, reproduced here:
//!
//! ```text
//! kaldi.fbank(wav * 32768, num_mel_bins=80, frame_length=25, frame_shift=10,
//!             round_to_power_of_two=True, window_type="hamming",
//!             use_energy=False, snip_edges=True, dither=0.0,
//!             sample_frequency=16000)
//! feats -= feats.mean(axis=0)   // per-utterance, per-bin
//! ```
//!
//! `snip_edges=True` is the one framing choice that most affects an
//! implementation reaching for `mel.rs` as a template: Whisper's front end
//! reflect-pads so a frame is CENTRED on its hop position; Kaldi's snip-edges
//! framing does not pad at all — a frame only exists if a full `frame_length`
//! fits inside the signal, so the last few samples of a clip that don't fill
//! one more frame are simply dropped, and there is no edge padding to get
//! subtly wrong.
//!
//! `round_to_power_of_two=True` pads each windowed frame with zeros up to the
//! next power of two before the FFT (400 → 512) — it changes which frequency
//! each FFT bin represents, so the mel filterbank must be built against 512,
//! not 400, or every filter samples the wrong bins.
//!
//! Preemphasis (0.97) and DC removal are not on the card because they are
//! Kaldi's own defaults for `fbank`, applied whether or not the caller
//! mentions them — leaving them out here would silently disagree with the
//! reference the card is asking to be reproduced.
//!
//! No reference-implementation numbers are pinned in a test the way `mel.rs`
//! pins transformers.js's: validated instead by running the real pinned ONNX
//! model end-to-end against this front end (see `diarize.rs`'s module doc) —
//! deterministic, non-degenerate output, and a same-signal/different-signal
//! embedding gap of the sign a speaker-discriminating model should produce.
//! That is real evidence the pipeline works, not proof this front end is
//! bit-exact against a from-source Kaldi build; nobody has run one to compare
//! against. Treat it as plausible, not proven, same as this codebase's other
//! not-yet-cross-checked signal paths.

use rustfft::{num_complex::Complex, Fft, FftPlanner};

pub const SAMPLE_RATE: u32 = 16_000;
/// 25 ms.
pub const FRAME_LEN: usize = 400;
/// 10 ms.
pub const FRAME_SHIFT: usize = 160;
pub const N_MELS: usize = 80;
/// `round_to_power_of_two=True` on a 400-sample frame.
pub const FFT_SIZE: usize = 512;
const BINS: usize = FFT_SIZE / 2 + 1;
const PREEMPHASIS: f32 = 0.97;

/// Frame count `snip_edges=True` produces for `n` samples: only whole frames
/// count, and a track shorter than one frame produces none.
pub fn frame_count(n: usize) -> usize {
    if n < FRAME_LEN {
        0
    } else {
        1 + (n - FRAME_LEN) / FRAME_SHIFT
    }
}

fn hamming(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.54 - 0.46 * ((2.0 * std::f64::consts::PI * i as f64) / (n as f64 - 1.0)).cos()).map(|w| w as f32).collect()
}

fn hz_to_mel(hz: f64) -> f64 {
    1127.0 * (1.0 + hz / 700.0).ln()
}

fn mel_to_hz(mel: f64) -> f64 {
    700.0 * (mel / 1127.0).exp_m1()
}

/// Triangular mel filterbank over `FFT_SIZE`'s real bins, Kaldi/HTK-scaled
/// (`1127 * ln(1 + hz/700)`) — the same mel formula as `mel.rs`'s Slaney
/// scale, but without Slaney's extra linear/log-region split or per-filter
/// area normalisation, which the wespeaker recipe does not call for.
struct MelFilters {
    rows: Vec<Vec<f32>>,
}

impl MelFilters {
    fn build(num_mels: usize, low_freq: f64, high_freq: f64) -> Self {
        let mel_low = hz_to_mel(low_freq);
        let mel_high = hz_to_mel(high_freq);
        let centers: Vec<f64> = (0..num_mels + 2).map(|i| mel_to_hz(mel_low + (mel_high - mel_low) * i as f64 / (num_mels as f64 + 1.0))).collect();

        let rows = (0..num_mels)
            .map(|m| {
                let (left, center, right) = (centers[m], centers[m + 1], centers[m + 2]);
                (0..BINS)
                    .map(|k| {
                        let freq = (k as f64 * SAMPLE_RATE as f64) / FFT_SIZE as f64;
                        let w = if freq > left && freq < right {
                            if freq <= center { (freq - left) / (center - left) } else { (right - freq) / (right - center) }
                        } else {
                            0.0
                        };
                        w as f32
                    })
                    .collect()
            })
            .collect();
        Self { rows }
    }

    fn row(&self, m: usize) -> &[f32] {
        &self.rows[m]
    }
}

/// Reusable across calls so a whole track's worth of frames does not
/// replan the FFT or rebuild the filterbank per frame.
pub struct Fbank {
    filters: MelFilters,
    window: Vec<f32>,
    fft: std::sync::Arc<dyn Fft<f32>>,
    buf: Vec<Complex<f32>>,
}

impl Fbank {
    pub fn new() -> Self {
        Self {
            filters: MelFilters::build(N_MELS, 20.0, SAMPLE_RATE as f64 / 2.0),
            window: hamming(FRAME_LEN),
            fft: FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE),
            buf: vec![Complex { re: 0.0, im: 0.0 }; FFT_SIZE],
        }
    }

    /// Log-mel-ish fbank features for a whole clip, row-major
    /// `[frame][N_MELS]` (frame-major, unlike `mel.rs`'s mel-major layout —
    /// this model's `(batch, T, 80)` input wants time as the middle axis).
    /// `samples` is 16 kHz mono in `[-1, 1]`.
    pub fn compute(&mut self, samples: &[f32]) -> Vec<f32> {
        let frames = frame_count(samples.len());
        let mut out = vec![0f32; frames * N_MELS];
        let mut power = vec![0f64; BINS];

        for f in 0..frames {
            let start = f * FRAME_SHIFT;
            let mut frame: Vec<f64> = samples[start..start + FRAME_LEN].iter().map(|&s| s as f64 * 32768.0).collect();

            // remove_dc_offset
            let mean: f64 = frame.iter().sum::<f64>() / FRAME_LEN as f64;
            for s in frame.iter_mut() {
                *s -= mean;
            }
            // preemphasis — Kaldi leaves the first sample as-is (there is no
            // sample before it to subtract).
            for i in (1..FRAME_LEN).rev() {
                frame[i] -= PREEMPHASIS as f64 * frame[i - 1];
            }

            for (i, slot) in self.buf.iter_mut().enumerate() {
                let windowed = if i < FRAME_LEN { frame[i] as f32 * self.window[i] } else { 0.0 };
                *slot = Complex { re: windowed, im: 0.0 };
            }
            self.fft.process(&mut self.buf);
            for (b, p) in power.iter_mut().enumerate() {
                let c = self.buf[b];
                *p = (c.re as f64) * (c.re as f64) + (c.im as f64) * (c.im as f64);
            }
            for m in 0..N_MELS {
                let row = self.filters.row(m);
                let mut acc = 0f64;
                for (k, &w) in row.iter().enumerate() {
                    acc += w as f64 * power[k];
                }
                out[f * N_MELS + m] = acc.max(1e-10).ln() as f32;
            }
        }

        // Per-utterance, per-bin mean subtraction (the card's `feats -=
        // feats.mean(axis=0)`), over THIS clip's frames only — deliberately
        // local rather than a running/global mean, matching the offline,
        // whole-clip nature of every other per-song pass in this codebase
        // (beat/key/structure/loudness all measure the one track they run on).
        for m in 0..N_MELS {
            let mut mean = 0f32;
            for f in 0..frames {
                mean += out[f * N_MELS + m];
            }
            mean /= frames.max(1) as f32;
            for f in 0..frames {
                out[f * N_MELS + m] -= mean;
            }
        }
        out
    }
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_count_matches_snip_edges_true() {
        assert_eq!(frame_count(0), 0);
        assert_eq!(frame_count(FRAME_LEN - 1), 0, "a clip shorter than one frame produces none");
        assert_eq!(frame_count(FRAME_LEN), 1);
        assert_eq!(frame_count(FRAME_LEN + FRAME_SHIFT), 2);
        assert_eq!(frame_count(FRAME_LEN + FRAME_SHIFT - 1), 1, "a partial trailing frame is dropped, not padded");
    }

    #[test]
    fn mel_scale_round_trips() {
        for hz in [0.0, 100.0, 1000.0, 4000.0, 8000.0] {
            let back = mel_to_hz(hz_to_mel(hz));
            assert!((back - hz).abs() < 1e-6, "{hz} round-tripped to {back}");
        }
    }

    #[test]
    fn filters_march_up_the_spectrum_without_negative_weights() {
        let filters = MelFilters::build(N_MELS, 20.0, SAMPLE_RATE as f64 / 2.0);
        let mut previous_peak = 0usize;
        for m in 0..N_MELS {
            let row = filters.row(m);
            assert!(row.iter().all(|&w| w >= 0.0), "filter {m} has a negative weight");
            let peak = row.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|(i, _)| i).unwrap();
            assert!(peak >= previous_peak, "filter {m} peaks below filter {}", m - 1);
            previous_peak = peak;
        }
    }

    #[test]
    fn compute_produces_the_documented_shape() {
        let mut fb = Fbank::new();
        let samples = vec![0.0f32; SAMPLE_RATE as usize]; // 1s of silence
        let out = fb.compute(&samples);
        let expected_frames = frame_count(samples.len());
        assert_eq!(out.len(), expected_frames * N_MELS);
    }

    #[test]
    fn per_bin_mean_is_zero_after_normalisation() {
        let mut fb = Fbank::new();
        let samples: Vec<f32> = (0..SAMPLE_RATE as usize).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
        let out = fb.compute(&samples);
        let frames = frame_count(samples.len());
        for m in 0..N_MELS {
            let mean: f32 = (0..frames).map(|f| out[f * N_MELS + m]).sum::<f32>() / frames as f32;
            assert!(mean.abs() < 1e-3, "bin {m} mean {mean} was not normalised to ~0");
        }
    }

    #[test]
    fn silence_and_tone_produce_different_non_degenerate_features() {
        let mut fb = Fbank::new();
        let silence = vec![0.0f32; SAMPLE_RATE as usize];
        let tone: Vec<f32> = (0..SAMPLE_RATE as usize).map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.5).collect();
        let a = fb.compute(&silence);
        let b = fb.compute(&tone);
        assert!(a.iter().all(|v| v.is_finite()));
        assert!(b.iter().all(|v| v.is_finite()));
        assert_ne!(a, b);
    }
}
