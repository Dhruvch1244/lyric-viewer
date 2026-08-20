//! Offline beat tracking — the whole song's grid, computed once.
//!
//! **The bug this exists to fix is measured, not theoretical.** On a real 138
//! BPM track the live estimator (`src/renderer/tempo.js`) reported 174. That is
//! not a tuning problem: a causal estimator watching a rolling window drifts by
//! construction, because it has to commit to an answer before the evidence that
//! would settle it has arrived, and a syncopated bar inside its window is
//! indistinguishable from a faster tempo. An offline pass has the whole song and
//! no such excuse.
//!
//! The algorithm is Ellis's dynamic-programming beat tracker (2007), which is
//! the standard answer to exactly this and is ~150 lines of arithmetic:
//!
//! 1. **Onset strength envelope** — half-wave-rectified spectral flux over
//!    log-spaced bands, normalised against its own local mean so a quiet intro
//!    and a loud chorus contribute equally.
//! 2. **One global tempo** — autocorrelation of that envelope, weighted by a
//!    log-Gaussian centred on 120 BPM. The weighting is what resolves the
//!    octave ambiguity that makes a tracker report 69 or 276 for a 138 BPM
//!    song: a click train's autocorrelation peaks at every multiple of the
//!    period, and nothing in the signal itself says which one is "the" tempo.
//! 3. **A beat grid by dynamic programming** — every beat is placed where the
//!    onset envelope is strong *and* the spacing from the previous beat is
//!    close to the global period, maximised over the entire song at once. This
//!    is the step a streaming tracker cannot do, and the reason the result
//!    cannot drift: there is one period for the whole track.
//!
//! `aubio` would also do this, but it binds to a C library and building that on
//! Windows is a real burden (JOB-ENGINE §5.3). `rustfft` is already a
//! dependency, so this adds nothing.
//!
//! Everything here is numbers in, numbers out, and is tested against click
//! trains whose answer is known by construction — including one at 138 BPM,
//! because that is the case that was actually wrong.

use rustfft::{num_complex::Complex, FftPlanner};

/// STFT window. ~46 ms at 44.1 kHz: long enough to resolve low bands, short
/// enough that a kick does not smear across two frames.
const FFT_SIZE: usize = 2048;
/// STFT hop. ~11.6 ms at 44.1 kHz, so the grid can place a beat to about a
/// hundredth of a second — well inside what anyone can see.
const HOP: usize = 512;
/// Log-spaced flux bands. Enough to separate a kick from a hat; few enough
/// that one noisy bin cannot dominate.
const BANDS: usize = 40;
const BAND_LOW_HZ: f64 = 30.0;
const BAND_HIGH_HZ: f64 = 8_000.0;

/// Tempo search range. Below 60 and above 200 is either a mis-octave or not
/// something this app's visuals can use.
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Centre of the perceptual weighting — the tempo listeners default to when
/// the signal is ambiguous. Ellis's own value.
const TEMPO_BIAS_BPM: f64 = 120.0;
/// Width of that weighting, in octaves. One octave: 60 and 240 BPM are
/// penalised by the same amount, and neither is ruled out.
const TEMPO_BIAS_OCTAVES: f64 = 1.0;
/// How hard the DP insists on even spacing, against how strongly it wants to
/// land on an onset. Ellis's α. Higher means a more rigid grid.
const TIGHTNESS: f64 = 400.0;
/// Window for the envelope's local mean, in seconds. Long enough to span a bar
/// at any tempo in range, so subtracting it removes the arrangement's dynamics
/// rather than the beats.
const LOCAL_MEAN_SECS: f64 = 1.5;
/// Below this much audio there is not enough evidence for a global tempo.
const MIN_SECONDS: f64 = 10.0;

/// A song's measured beat grid.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Beats {
    /// Tempo in BPM, taken from the *grid's* own median spacing rather than
    /// from the autocorrelation lag — the lag is quantised to whole frames
    /// (±1.5 BPM at 120), the grid is not.
    pub bpm: f64,
    /// Every beat, in milliseconds from the start of the track.
    #[serde(rename = "beatsMs")]
    pub beats_ms: Vec<f64>,
    /// Normalised autocorrelation at the chosen period, 0..1. How periodic the
    /// track actually is — a rubato piano piece scores low and *should*.
    pub confidence: f64,
}

/// Track the beats in mono PCM.
///
/// `None` when there is too little audio, no sample rate, or nothing periodic
/// enough to place a grid on. All three are ordinary — an ambient track has no
/// beat and saying so is the correct answer.
pub fn track(samples: &[f32], sample_rate: u32) -> Option<Beats> {
    if sample_rate == 0 || (samples.len() as f64) < MIN_SECONDS * sample_rate as f64 {
        return None;
    }
    let fps = sample_rate as f64 / HOP as f64;
    let envelope = onset_envelope(samples, sample_rate);
    let (period_frames, confidence) = estimate_period(&envelope, fps)?;
    let beats = dp_beats(&envelope, period_frames);
    if beats.len() < 2 {
        return None;
    }

    // Frame index → time at the window's CENTRE, not its start. The STFT is
    // not centre-padded, so frame f covers samples [f·HOP, f·HOP+FFT_SIZE) and
    // a transient inside it is detected across the whole window's worth of
    // frames. Reporting the start puts every beat about half a window early —
    // 23 ms at 44.1 kHz, which is visible.
    let centre_ms = FFT_SIZE as f64 * 500.0 / sample_rate as f64;
    let beats_ms: Vec<f64> = beats.iter().map(|&f| f as f64 * 1000.0 / fps + centre_ms).collect();
    let bpm = 60_000.0 / median_interval(&beats_ms)?;
    // The DP is bounded to [period/2, 2*period] per step, so the median cannot
    // land outside the search range unless the maths is wrong. Checked rather
    // than assumed, because a bad tempo is not visibly a bug — it is a beat
    // clock that feels slightly off and nobody can say why.
    if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
        return None;
    }
    Some(Beats { bpm, beats_ms, confidence })
}

/// Half-wave-rectified spectral flux over log-spaced bands, normalised.
///
/// Split out and public to the crate's tests because it is the input every
/// later step trusts: a flat envelope produces a confident-looking tempo from
/// pure noise.
fn onset_envelope(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.len() < FFT_SIZE {
        return Vec::new();
    }
    let bins = FFT_SIZE / 2 + 1;
    let edges = band_edges(sample_rate, bins);

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = std::f32::consts::TAU * i as f32 / FFT_SIZE as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect();

    let frames = (samples.len() - FFT_SIZE) / HOP + 1;
    let mut flux = vec![0.0_f32; frames];
    let mut buf = vec![Complex::new(0.0_f32, 0.0); FFT_SIZE];
    let mut prev = [0.0_f32; BANDS];
    let mut cur = [0.0_f32; BANDS];

    for (f, out) in flux.iter_mut().enumerate() {
        let start = f * HOP;
        for (slot, (&s, &w)) in buf.iter_mut().zip(samples[start..start + FFT_SIZE].iter().zip(&window)) {
            *slot = Complex::new(s * w, 0.0);
        }
        fft.process(&mut buf);

        for (b, band) in cur.iter_mut().enumerate() {
            let sum: f32 = buf[edges[b]..edges[b + 1]].iter().map(|c| c.norm()).sum();
            // Log compression, the standard move here: without it a loud
            // chorus's flux dwarfs a quiet verse's and the DP places every
            // beat in the chorus.
            *band = (1.0 + sum).ln();
        }
        if f > 0 {
            *out = cur.iter().zip(&prev).map(|(c, p)| (c - p).max(0.0)).sum();
        }
        prev.copy_from_slice(&cur);
    }

    normalise(&mut flux, sample_rate as f64 / HOP as f64);
    flux
}

/// Subtract a moving local mean and half-wave rectify, then scale to unit
/// standard deviation.
///
/// The local mean is what makes an intro and a drop contribute comparably;
/// without it the DP's "land on an onset" term is dominated by whichever
/// section was mastered loudest, and the grid drifts there.
fn normalise(flux: &mut [f32], fps: f64) {
    if flux.is_empty() {
        return;
    }
    let n = flux.len();
    let half = ((LOCAL_MEAN_SECS * fps) as usize / 2).max(1);
    // Prefix sums, so the moving mean is O(n) rather than O(n·window) — this
    // runs over a whole song's frames.
    let mut prefix = vec![0.0_f64; n + 1];
    for (i, &v) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + v as f64;
    }
    for (i, v) in flux.iter_mut().enumerate() {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        let mean = ((prefix[hi] - prefix[lo]) / (hi - lo) as f64) as f32;
        *v = (*v - mean).max(0.0);
    }

    let mean = flux.iter().map(|&v| v as f64).sum::<f64>() / flux.len() as f64;
    let var = flux.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / flux.len() as f64;
    let sd = var.sqrt();
    if sd > 1e-9 {
        let s = (1.0 / sd) as f32;
        for v in flux.iter_mut() {
            *v *= s;
        }
    }
}

/// Bin index at each of `BANDS + 1` log-spaced band edges.
///
/// Forced strictly increasing rather than merely computed: at a low sample
/// rate the bottom bands are narrower than one FFT bin and several edges round
/// to the same index, which produces an always-zero band — flux that reads as
/// "nothing ever happens here" instead of as a missing band.
fn band_edges(sample_rate: u32, bins: usize) -> Vec<usize> {
    let nyquist = sample_rate as f64 / 2.0;
    let high = BAND_HIGH_HZ.min(nyquist * 0.99);
    let low = BAND_LOW_HZ.min(high / 2.0);
    let ratio = (high / low).ln();
    let mut edges = Vec::with_capacity(BANDS + 1);
    let mut next = 0usize;
    for b in 0..=BANDS {
        let hz = low * (ratio * b as f64 / BANDS as f64).exp();
        let bin = (hz / nyquist * (bins - 1) as f64).round() as usize;
        // Every band is at least one bin wide, and the last edge still fits
        // inside the spectrum: BANDS+1 edges need BANDS+1 distinct bins.
        let ceiling = bins - 1 - (BANDS - b);
        let edge = bin.max(next).min(ceiling);
        edges.push(edge);
        next = edge + 1;
    }
    edges
}

/// The single global beat period, in frames, plus how periodic the track is.
///
/// Weighted autocorrelation. The weighting is not cosmetic: a click train's
/// autocorrelation peaks just as hard at twice and three times the true
/// period, and nothing in the signal distinguishes them. A log-Gaussian
/// centred on 120 BPM encodes what a listener would tap.
fn estimate_period(envelope: &[f32], fps: f64) -> Option<(f64, f64)> {
    let min_lag = (60.0 * fps / MAX_BPM).floor().max(2.0) as usize;
    let max_lag = (60.0 * fps / MIN_BPM).ceil() as usize;
    if envelope.len() < max_lag * 2 {
        return None;
    }

    let energy: f64 = envelope.iter().map(|&v| (v as f64) * (v as f64)).sum();
    if energy <= 1e-9 {
        return None; // silence, or an envelope that never moved
    }

    let mut best = (0usize, f64::NEG_INFINITY, 0.0f64);
    for lag in min_lag..=max_lag.min(envelope.len() - 1) {
        let n = envelope.len() - lag;
        let dot: f64 = (0..n).map(|i| envelope[i] as f64 * envelope[i + lag] as f64).sum();
        // Divided by the overlap, not by the full length: the raw
        // autocorrelation of a finite signal falls off linearly with lag, so
        // without this every slow tempo is penalised for being slow.
        let r = dot / (n as f64).max(1.0) * envelope.len() as f64 / energy;
        let bpm = 60.0 * fps / lag as f64;
        let weighted = r * tempo_weight(bpm);
        if weighted > best.1 {
            best = (lag, weighted, r);
        }
    }
    if best.0 == 0 {
        return None;
    }
    Some((best.0 as f64, best.2.clamp(0.0, 1.0)))
}

/// Perceptual prior over tempo: a log-Gaussian centred on `TEMPO_BIAS_BPM`.
fn tempo_weight(bpm: f64) -> f64 {
    let octaves = (bpm / TEMPO_BIAS_BPM).log2() / TEMPO_BIAS_OCTAVES;
    (-0.5 * octaves * octaves).exp()
}

/// Ellis's dynamic program: the beat sequence maximising
/// `Σ onset(t) + α · Σ −ln(Δ/period)²` over the whole track.
///
/// The second term is what a streaming tracker cannot have. It scores the
/// *whole* sequence's regularity at once, so one syncopated bar cannot pull the
/// grid — it would have to pay for every beat after it too.
fn dp_beats(envelope: &[f32], period: f64) -> Vec<usize> {
    let n = envelope.len();
    if n == 0 || period < 2.0 {
        return Vec::new();
    }
    let lo = (period * 0.5).round().max(1.0) as usize;
    let hi = (period * 2.0).round() as usize;

    let mut score = vec![0.0_f64; n];
    let mut back = vec![usize::MAX; n];

    for t in 0..n {
        let mut best = f64::NEG_INFINITY;
        let mut best_prev = usize::MAX;
        if t >= lo {
            let first = t.saturating_sub(hi);
            for (offset, &prev_score) in score[first..=(t - lo)].iter().enumerate() {
                let prev = first + offset;
                let delta = (t - prev) as f64;
                let penalty = -TIGHTNESS * (delta / period).ln().powi(2);
                let candidate = prev_score + penalty;
                if candidate > best {
                    best = candidate;
                    best_prev = prev;
                }
            }
        }
        // A frame with no reachable predecessor starts a chain rather than
        // being unreachable — otherwise no beat could ever be first.
        score[t] = envelope[t] as f64 + if best.is_finite() { best } else { 0.0 };
        back[t] = best_prev;
    }

    // Start the backtrace from the best score in the final period's worth of
    // frames, not from the global maximum: scores grow monotonically along a
    // chain, so the global maximum is always near the end anyway, and
    // restricting it keeps a freak late spike from truncating the grid.
    let tail_start = n.saturating_sub(hi.max(1));
    let Some(mut cursor) = (tail_start..n).max_by(|&a, &b| score[a].total_cmp(&score[b])) else {
        return Vec::new();
    };

    let mut beats = vec![cursor];
    while back[cursor] != usize::MAX {
        cursor = back[cursor];
        beats.push(cursor);
    }
    beats.reverse();
    beats
}

/// Median gap between consecutive beats, in the same unit as the input.
fn median_interval(beats_ms: &[f64]) -> Option<f64> {
    if beats_ms.len() < 2 {
        return None;
    }
    let mut gaps: Vec<f64> = beats_ms.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_by(f64::total_cmp);
    let mid = gaps.len() / 2;
    let m = if gaps.len() % 2 == 0 { (gaps[mid - 1] + gaps[mid]) / 2.0 } else { gaps[mid] };
    (m > 0.0).then_some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// A click train at an exact tempo: a short decaying burst of noise on
    /// every beat, silence between. Noise rather than a tone because a tone's
    /// energy sits in one band and the flux over 40 bands would barely move —
    /// the same reason a real kick is broadband.
    fn clicks(bpm: f64, seconds: f64) -> Vec<f32> {
        let n = (seconds * SR as f64) as usize;
        let period = 60.0 / bpm * SR as f64;
        let mut out = vec![0.0_f32; n];
        // A fixed linear congruential sequence, so the test is deterministic
        // across runs and platforms without pulling in a rand crate.
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rand = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        let mut beat = 0.0;
        while (beat as usize) < n {
            let at = beat as usize;
            let len = (SR as f64 * 0.03) as usize; // 30 ms burst
            for i in 0..len.min(n - at) {
                let decay = 1.0 - i as f32 / len as f32;
                out[at + i] += rand() * decay * decay;
            }
            beat += period;
        }
        out
    }

    fn bpm_of(bpm: f64) -> f64 {
        track(&clicks(bpm, 30.0), SR).unwrap_or_else(|| panic!("no beats found at {bpm} BPM")).bpm
    }

    #[test]
    fn a_138_bpm_track_reads_as_138() {
        // The measured bug, by name: the live estimator read this as 174.
        // Anything within 2% is the grid landing on the right period; the old
        // failure was 26% out.
        let got = bpm_of(138.0);
        assert!((got - 138.0).abs() / 138.0 < 0.02, "read {got:.1} BPM, expected 138");
    }

    #[test]
    fn tempi_across_the_range_are_recovered() {
        for expected in [72.0, 90.0, 110.0, 128.0, 150.0, 174.0] {
            let got = bpm_of(expected);
            assert!((got - expected).abs() / expected < 0.02, "read {got:.1} BPM, expected {expected}");
        }
    }

    #[test]
    fn the_grid_lands_on_the_clicks_not_merely_at_the_right_spacing() {
        // A grid can have exactly the right tempo and be half a beat out of
        // phase, which looks correct in every BPM assertion and wrong in every
        // visual. Each beat must sit within one STFT hop of a real click.
        let bpm = 128.0;
        let beats = track(&clicks(bpm, 30.0), SR).unwrap();
        let period_ms = 60_000.0 / bpm;
        // Two hops. A beat can only be placed on a frame boundary, and the
        // transient is spread across the analysis window, so one hop of
        // quantisation plus one of smear is the honest floor — and it is
        // tight enough that dropping the window-centre correction fails here.
        let tolerance = 2.0 * HOP as f64 * 1000.0 / SR as f64;
        for &b in &beats.beats_ms {
            let offset = (b % period_ms).min(period_ms - b % period_ms);
            assert!(offset <= tolerance, "beat at {b:.0}ms is {offset:.0}ms off the grid (tolerance {tolerance:.0}ms)");
        }
    }

    #[test]
    fn the_grid_covers_the_whole_song_rather_than_a_confident_fragment() {
        let beats = track(&clicks(120.0, 30.0), SR).unwrap();
        // 30 s at 120 BPM is 60 beats; the STFT cannot see the last window, so
        // allow a couple missing at each end.
        assert!(beats.beats_ms.len() >= 56, "only {} beats over 30s at 120 BPM", beats.beats_ms.len());
        assert!(beats.beats_ms[0] < 2_000.0, "grid starts at {:.0}ms", beats.beats_ms[0]);
        assert!(*beats.beats_ms.last().unwrap() > 28_000.0, "grid ends at {:.0}ms", beats.beats_ms.last().unwrap());
    }

    #[test]
    fn beats_are_strictly_increasing() {
        let beats = track(&clicks(100.0, 30.0), SR).unwrap();
        assert!(beats.beats_ms.windows(2).all(|w| w[1] > w[0]), "the grid went backwards");
    }

    #[test]
    fn a_steady_click_train_is_reported_as_confident() {
        assert!(track(&clicks(120.0, 30.0), SR).unwrap().confidence > 0.3);
    }

    #[test]
    fn silence_has_no_beat_rather_than_a_confident_wrong_one() {
        // The failure that matters: a tracker that always answers will hand
        // the visuals a beat clock for an ambient track and pulse to nothing.
        assert!(track(&vec![0.0; SR as usize * 30], SR).is_none());
    }

    #[test]
    fn too_little_audio_is_declined() {
        assert!(track(&clicks(120.0, 5.0), SR).is_none());
        assert!(track(&[], SR).is_none());
    }

    #[test]
    fn a_zero_sample_rate_does_not_divide_by_zero() {
        assert!(track(&clicks(120.0, 30.0), 0).is_none());
    }

    #[test]
    fn the_tempo_prior_prefers_the_middle_of_the_range_when_the_signal_is_ambiguous() {
        // The one number that resolves the octave ambiguity. If this weighting
        // ever flattens, a 138 BPM track can legitimately be reported as 69.
        assert!(tempo_weight(120.0) > tempo_weight(60.0));
        assert!(tempo_weight(120.0) > tempo_weight(240.0));
        assert!((tempo_weight(60.0) - tempo_weight(240.0)).abs() < 1e-9, "the prior is not symmetric in octaves");
        assert!((tempo_weight(120.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn band_edges_advance_and_stay_in_range() {
        let bins = FFT_SIZE / 2 + 1;
        for sr in [8_000u32, 16_000, 44_100, 48_000, 96_000] {
            let edges = band_edges(sr, bins);
            assert_eq!(edges.len(), BANDS + 1);
            for w in edges.windows(2) {
                assert!(w[1] > w[0], "empty band at {sr} Hz: {edges:?}");
            }
            assert!(*edges.last().unwrap() < bins, "edge past the spectrum at {sr} Hz");
        }
    }

    #[test]
    fn the_envelope_peaks_on_the_clicks_and_rests_between_them() {
        // The input everything downstream trusts. If the flux were flat, the
        // autocorrelation would still return *something* and the DP would
        // still emit an evenly spaced grid — of nothing.
        let env = onset_envelope(&clicks(120.0, 10.0), SR);
        assert!(!env.is_empty());
        let peak = env.iter().cloned().fold(0.0_f32, f32::max);
        let mean = env.iter().sum::<f32>() / env.len() as f32;
        assert!(peak > mean * 5.0, "envelope is flat: peak {peak:.3} vs mean {mean:.3}");
    }

    #[test]
    fn the_envelope_of_silence_is_flat() {
        let env = onset_envelope(&vec![0.0; SR as usize * 5], SR);
        assert!(env.iter().all(|&v| v.abs() < 1e-6), "silence produced onsets");
    }

    #[test]
    fn the_median_interval_is_the_middle_gap_not_the_mean() {
        // Chosen over the mean precisely so one dropped beat — a doubled gap —
        // cannot pull the reported tempo.
        assert_eq!(median_interval(&[0.0, 500.0, 1000.0, 2000.0]), Some(500.0));
        assert_eq!(median_interval(&[0.0, 500.0]), Some(500.0));
        assert_eq!(median_interval(&[0.0]), None);
        assert_eq!(median_interval(&[]), None);
    }

    #[test]
    fn the_dp_declines_an_impossible_period_instead_of_panicking() {
        assert!(dp_beats(&[1.0; 100], 1.0).is_empty());
        assert!(dp_beats(&[], 40.0).is_empty());
    }
}
