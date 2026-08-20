//! Integrated loudness, and the per-track gain that follows from it.
//!
//! JOB-ENGINE §5.6. The visuals react to how loud the audio is, so today they
//! also react to how hard the track was mastered: a modern EDM release pinned
//! at −6 LUFS drives everything to the ceiling and a dynamic jazz recording at
//! −20 barely moves it, even though a listener would call them equally loud.
//! That is a property of the master, not of the music, and it is exactly what
//! EBU R128 exists to measure.
//!
//! **Why the peak normalisation already in `analysis.rs` does not cover this.**
//! That pass scales each track's envelopes by its own *peak*, which two
//! recordings can share while sounding nothing alike — a heavily compressed
//! master has far more energy under the same peak than a dynamic one. R128
//! measures gated mean loudness with a K-weighting filter, which is a model of
//! perceived loudness rather than of the waveform's extremes.
//!
//! The `ebur128` crate is the reference implementation of the standard rather
//! than a re-derivation of it, which matters here: the K-weighting filter
//! coefficients and the two-stage gating are fiddly, published, and produce a
//! plausible-looking number when subtly wrong.
//!
//! **What this gain does not correct for, deliberately: system volume.** The
//! live path hears whatever the user's volume knob is set to. That is their
//! choice about the room they are in; the master's level is not. Correcting
//! for it would also be a feedback loop — the visuals would fight every volume
//! change.

use ebur128::{EbuR128, Mode};

/// The reference level to normalise toward, in LUFS. −14 is the streaming
/// convention (Spotify, YouTube, Tidal all sit within a decibel of it), so a
/// modern release usually needs almost no correction and the gain only really
/// moves for outliers — which is the intent.
const TARGET_LUFS: f64 = -14.0;

/// Bounds on the gain. A measurement can be legitimately extreme (a field
/// recording, a track that is mostly silence) and the visuals must stay usable
/// either way — this is a bias, not an automatic level control.
const MIN_GAIN: f64 = 0.5;
const MAX_GAIN: f64 = 2.0;

/// Below this there is not enough audio for the gating to settle.
const MIN_SECONDS: f64 = 10.0;

/// A track's measured loudness and the gain that brings it to the reference.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Loudness {
    /// Integrated loudness in LUFS. Negative; louder is closer to zero.
    pub lufs: f64,
    /// Linear multiplier toward `TARGET_LUFS`, clamped to a usable range.
    pub gain: f64,
}

/// Measure mono PCM.
///
/// `None` when there is too little audio, no sample rate, or the track is
/// effectively silent — R128 reports `-inf` for silence, which is correct and
/// cannot be turned into a gain.
pub fn measure(samples: &[f32], sample_rate: u32) -> Option<Loudness> {
    if sample_rate == 0 || (samples.len() as f64) < MIN_SECONDS * sample_rate as f64 {
        return None;
    }
    let mut meter = EbuR128::new(1, sample_rate, Mode::I).ok()?;
    // Fed in chunks rather than as one slice: the crate copies into its own
    // filter state per call, and one call with a whole song is a single large
    // allocation for no benefit.
    for chunk in samples.chunks(sample_rate as usize) {
        meter.add_frames_f32(chunk).ok()?;
    }
    let lufs = meter.loudness_global().ok()?;
    if !lufs.is_finite() {
        return None; // silence, or everything below the absolute gate
    }
    Some(Loudness { lufs, gain: gain_for(lufs) })
}

/// The linear gain that would bring `lufs` to the reference, clamped.
///
/// Split out because it is the part with a known answer: a track already at
/// the target needs exactly 1.0, and the direction must not be inverted —
/// which is easy to do and looks like the visuals simply reacting oddly rather
/// than like a sign error.
fn gain_for(lufs: f64) -> f64 {
    let db = TARGET_LUFS - lufs;
    (10f64.powf(db / 20.0)).clamp(MIN_GAIN, MAX_GAIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// A sine at a given amplitude — a steady tone is the one signal whose
    /// loudness is stable enough for the gating to give a repeatable answer.
    fn tone(amplitude: f32, seconds: f64) -> Vec<f32> {
        let n = (seconds * SR as f64) as usize;
        (0..n)
            .map(|i| (std::f64::consts::TAU * 1_000.0 * i as f64 / SR as f64).sin() as f32 * amplitude)
            .collect()
    }

    /* ---------------------------------------------------------- the gain --- */

    #[test]
    fn a_track_already_at_the_reference_needs_no_gain() {
        assert!((gain_for(TARGET_LUFS) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn a_quiet_track_is_turned_up_and_a_loud_one_down() {
        // The sign. Inverting it does not fail anything — it makes the
        // visuals react backwards, which reads as them simply being wrong.
        assert!(gain_for(TARGET_LUFS - 6.0) > 1.0, "a quieter master was not turned up");
        assert!(gain_for(TARGET_LUFS + 6.0) < 1.0, "a louder master was not turned down");
    }

    #[test]
    fn six_decibels_is_about_a_factor_of_two() {
        // Pins the dB↔linear conversion itself: 20·log10, not 10·log10.
        // Using the power form would halve every correction silently.
        assert!((gain_for(TARGET_LUFS - 6.0) - 1.995).abs() < 0.01, "{}", gain_for(TARGET_LUFS - 6.0));
    }

    #[test]
    fn the_gain_stays_inside_its_bounds_however_extreme_the_measurement() {
        // A field recording or a track that is mostly silence can measure
        // absurdly low. This is a bias toward the reference, not an automatic
        // level control, and it must stay usable at both extremes.
        for lufs in [-70.0, -40.0, -20.0, -14.0, -6.0, -1.0, 0.0] {
            let g = gain_for(lufs);
            assert!((MIN_GAIN..=MAX_GAIN).contains(&g), "{lufs} LUFS gave gain {g}");
        }
    }

    #[test]
    fn louder_never_means_more_gain() {
        // Monotonic, all the way across the range including the clamped ends.
        let mut prev = f64::INFINITY;
        for step in 0..70 {
            let g = gain_for(-70.0 + step as f64);
            assert!(g <= prev + 1e-12, "gain rose at {} LUFS", -70.0 + step as f64);
            prev = g;
        }
    }

    /* ------------------------------------------------------- the measure --- */

    #[test]
    fn a_full_scale_tone_measures_near_the_top_of_the_scale() {
        // A −1 dBFS sine is around −4 LUFS by R128's K-weighting at 1 kHz.
        // Asserted as a range, not a value: the point is that the meter is
        // wired up and reading a real level, not that this crate's arithmetic
        // is re-derived here.
        let l = measure(&tone(0.9, 15.0), SR).expect("no measurement for a loud tone");
        assert!(l.lufs > -12.0 && l.lufs < 0.0, "a near-full-scale tone measured {} LUFS", l.lufs);
    }

    #[test]
    fn a_quieter_tone_measures_quieter_by_about_the_right_amount() {
        // Halving the amplitude is −6 dB, and R128 is a level measure, so the
        // difference must come back as about 6 LUFS. This is the check that
        // the meter is measuring level at all rather than returning a constant.
        let loud = measure(&tone(0.8, 15.0), SR).unwrap().lufs;
        let quiet = measure(&tone(0.4, 15.0), SR).unwrap().lufs;
        assert!((loud - quiet - 6.0).abs() < 0.5, "{loud} vs {quiet} LUFS");
    }

    #[test]
    fn a_loud_master_gets_a_gain_below_one() {
        // End to end: the whole point of the feature, in one assertion.
        let l = measure(&tone(0.9, 15.0), SR).unwrap();
        assert!(l.gain < 1.0, "a loud master got gain {}", l.gain);
    }

    #[test]
    fn silence_has_no_measurement_rather_than_negative_infinity() {
        // R128 correctly reports -inf for silence. Turning that into a gain
        // produces either an infinity or, after clamping, a confident-looking
        // MAX_GAIN for a track with nothing in it.
        assert!(measure(&vec![0.0; SR as usize * 15], SR).is_none());
    }

    #[test]
    fn too_little_audio_is_declined() {
        assert!(measure(&tone(0.5, 3.0), SR).is_none());
        assert!(measure(&[], SR).is_none());
    }

    #[test]
    fn a_zero_sample_rate_is_declined_rather_than_passed_to_the_meter() {
        assert!(measure(&tone(0.5, 15.0), 0).is_none());
    }
}
