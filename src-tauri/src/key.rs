//! Musical key detection — chroma, then Krumhansl-Schmuckler.
//!
//! JOB-ENGINE §5.5. Two steps, neither of them large:
//!
//! 1. **Chroma.** Fold the spectrum onto the twelve pitch classes: every bin's
//!    magnitude is added to whichever of C, C♯, D … its frequency belongs to,
//!    regardless of octave. A song in A minor puts weight on A, C and E no
//!    matter which octaves they were played in, which is exactly the
//!    invariance key detection needs and the reason a raw spectrum will not do.
//! 2. **Krumhansl-Schmuckler.** Correlate that twelve-vector against the
//!    twenty-four published key profiles (twelve rotations each of a major and
//!    a minor template, measured from listener ratings) and take the best. The
//!    profiles are the whole method; they are reproduced here to four decimals
//!    exactly as published, because a "roughly similar" template silently
//!    picks the relative minor instead of the major.
//!
//! **The failure this is built to avoid is being confidently wrong.** Key
//! detection on real recordings is genuinely hard — a mix with heavy sub-bass
//! and dense percussion has chroma dominated by noise, and the correlation
//! will still name a key with no hesitation at all. So `detect` returns a
//! confidence taken from the margin between the best and second-best
//! *different* key, and refuses outright below a threshold. Saying nothing is
//! a fine answer; tinting the whole app for a key the song is not in is not.
//!
//! The chroma pass is shared with structure segmentation (§5.4) when that
//! lands — that is why `chromagram` returns per-frame vectors rather than one
//! averaged vector, and why it is `pub(crate)` rather than private.

use rustfft::{num_complex::Complex, FftPlanner};

/// STFT window. Deliberately four times `beats.rs`'s, because the two want
/// opposite things: a beat tracker needs time resolution to place a transient,
/// a key detector needs frequency resolution to tell a low C from a low C♯.
/// At 44.1 kHz this is 8192 samples ≈ 5.4 Hz per bin, which separates
/// semitones down to about 90 Hz (F♯2).
const FFT_SIZE: usize = 8192;
/// Half-window hop. Key does not change frame to frame, so there is nothing to
/// gain from a finer one and a whole song's worth of frames to lose.
const HOP: usize = 4096;

/// Lowest and highest frequency folded into the chroma. Below ~65 Hz (C2) a
/// bass note's harmonics are better evidence than the fundamental, and the
/// bin spacing is too coarse to place it anyway; above ~2 kHz the content is
/// mostly harmonics and percussion.
const MIN_HZ: f64 = 65.0;
const MAX_HZ: f64 = 2_000.0;

/// A4, the tuning reference the pitch-class mapping is anchored to.
const A4_HZ: f64 = 440.0;

/// Below this margin between the best key and the best *different* key, the
/// answer is a coin toss dressed up as a measurement.
const MIN_CONFIDENCE: f64 = 0.05;

/// Minimum audio for a key to mean anything.
const MIN_SECONDS: f64 = 10.0;

/// Pitch-class names, sharp spellings. Flats are equally correct and would
/// need the key's own signature to choose between; sharps everywhere is
/// consistent rather than pretending to a sophistication this does not have.
const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// Krumhansl-Kessler major profile — listener-rated stability of each pitch
/// class in a major context. Published values, not tuned here.
const MAJOR_PROFILE: [f64; 12] =
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
/// The same for a minor context.
const MINOR_PROFILE: [f64; 12] =
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/// A detected key.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Key {
    /// Tonic pitch class, 0 = C.
    pub tonic: u8,
    /// Sharp-spelled tonic name, e.g. `"F#"`.
    pub name: String,
    /// True for major, false for minor.
    pub major: bool,
    /// `"F# minor"` — the whole thing, ready to display.
    pub label: String,
    /// Margin over the best differing key, 0..1. Small means the song is
    /// ambiguous, not that the detector is unsure of its arithmetic.
    pub confidence: f64,
}

/// Detect the key of mono PCM, or `None` when there is not enough audio or
/// nothing decisive enough to name.
pub fn detect(samples: &[f32], sample_rate: u32) -> Option<Key> {
    if sample_rate == 0 || (samples.len() as f64) < MIN_SECONDS * sample_rate as f64 {
        return None;
    }
    let frames = chromagram(samples, sample_rate);
    if frames.is_empty() {
        return None;
    }
    let mut mean = [0.0_f64; 12];
    for frame in &frames {
        for (m, v) in mean.iter_mut().zip(frame) {
            *m += *v as f64;
        }
    }
    for m in mean.iter_mut() {
        *m /= frames.len() as f64;
    }
    from_chroma(&mean)
}

/// Score a twelve-vector against all twenty-four profiles and name the winner.
///
/// Split from `detect` because this is the part with a known answer: a chroma
/// vector that IS a key profile must come back as that key, and every rotation
/// of it must come back as the corresponding transposition.
fn from_chroma(chroma: &[f64; 12]) -> Option<Key> {
    if chroma.iter().sum::<f64>() <= 1e-9 {
        return None; // silence, or a spectrum with nothing in the chroma range
    }

    // (score, tonic, major), best first.
    let mut scored: Vec<(f64, u8, bool)> = Vec::with_capacity(24);
    for tonic in 0..12u8 {
        for major in [true, false] {
            let profile = if major { &MAJOR_PROFILE } else { &MINOR_PROFILE };
            // Rotate the profile so its tonic sits at `tonic`.
            let rotated: Vec<f64> = (0..12).map(|i| profile[(i + 12 - tonic as usize) % 12]).collect();
            scored.push((correlation(chroma, &rotated), tonic, major));
        }
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));

    let (best_score, tonic, major) = scored[0];
    // The runner-up is almost always the relative major/minor or the dominant,
    // which share most of their notes — so the margin over it is the honest
    // measure of how decisive the answer is, far more than the raw
    // correlation, which is high for every plausible key at once.
    let second = scored[1].0;
    let confidence = (best_score - second).max(0.0);
    if !best_score.is_finite() || confidence < MIN_CONFIDENCE {
        return None;
    }

    let name = NAMES[tonic as usize].to_string();
    Some(Key {
        tonic,
        label: format!("{name} {}", if major { "major" } else { "minor" }),
        name,
        major,
        confidence,
    })
}

/// Pearson correlation between two twelve-vectors.
fn correlation(a: &[f64; 12], b: &[f64]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let mut num = 0.0;
    let mut da = 0.0;
    let mut db = 0.0;
    for i in 0..12 {
        let x = a[i] - ma;
        let y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    let den = (da * db).sqrt();
    if den < 1e-12 {
        0.0
    } else {
        num / den
    }
}

/// Per-frame chroma vectors, each normalised to unit sum.
///
/// Normalising per frame rather than once at the end is what stops a single
/// loud chord deciding the key of a five-minute song — every frame gets one
/// vote regardless of how loud it was.
pub(crate) fn chromagram(samples: &[f32], sample_rate: u32) -> Vec<[f32; 12]> {
    if samples.len() < FFT_SIZE || sample_rate == 0 {
        return Vec::new();
    }
    let bins = FFT_SIZE / 2 + 1;
    let hz_per_bin = sample_rate as f64 / FFT_SIZE as f64;
    // Pitch class of every usable bin, computed once — this is the only real
    // arithmetic in the loop and it does not depend on the frame.
    let classes: Vec<Option<usize>> = (0..bins)
        .map(|b| {
            let hz = b as f64 * hz_per_bin;
            (MIN_HZ..=MAX_HZ.min(sample_rate as f64 / 2.0)).contains(&hz).then(|| pitch_class(hz))
        })
        .collect();

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = std::f32::consts::TAU * i as f32 / FFT_SIZE as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect();

    let frame_count = (samples.len() - FFT_SIZE) / HOP + 1;
    let mut out = Vec::with_capacity(frame_count);
    let mut buf = vec![Complex::new(0.0_f32, 0.0); FFT_SIZE];

    for f in 0..frame_count {
        let start = f * HOP;
        for (slot, (&s, &w)) in buf.iter_mut().zip(samples[start..start + FFT_SIZE].iter().zip(&window)) {
            *slot = Complex::new(s * w, 0.0);
        }
        fft.process(&mut buf);

        let mut chroma = [0.0_f32; 12];
        for (b, class) in classes.iter().enumerate().take(bins) {
            if let Some(c) = class {
                chroma[*c] += buf[b].norm();
            }
        }
        let total: f32 = chroma.iter().sum();
        if total > 1e-9 {
            for v in chroma.iter_mut() {
                *v /= total;
            }
            out.push(chroma);
        }
    }
    out
}

/// Pitch class (0 = C) of a frequency, via its distance from A4 in semitones.
fn pitch_class(hz: f64) -> usize {
    // MIDI note number, then modulo 12. A4 is MIDI 69 and pitch class 9 (A),
    // so +9 lines the result up with C = 0.
    let semitones_from_a4 = 12.0 * (hz / A4_HZ).log2();
    let class = semitones_from_a4.round() as i64 + 9;
    class.rem_euclid(12) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// Frequency of a pitch class in a given octave, equal temperament.
    fn hz_of(class: usize, octave: i32) -> f64 {
        // MIDI: C4 = 60, and MIDI n is 440 * 2^((n-69)/12).
        let midi = 12 * (octave + 1) + class as i32;
        A4_HZ * 2f64.powf((midi - 69) as f64 / 12.0)
    }

    /// A sustained chord: one sine per note, several octaves each, so the
    /// chroma has real weight rather than one bin's worth.
    fn chord(classes: &[usize], seconds: f64) -> Vec<f32> {
        let n = (seconds * SR as f64) as usize;
        let mut out = vec![0.0_f32; n];
        for &c in classes {
            for octave in 2..=4 {
                let hz = hz_of(c, octave);
                for (i, s) in out.iter_mut().enumerate() {
                    *s += (std::f64::consts::TAU * hz * i as f64 / SR as f64).sin() as f32 * 0.1;
                }
            }
        }
        out
    }

    /* ------------------------------------------------- the arithmetic --- */

    #[test]
    fn a_chroma_that_is_the_c_major_profile_reads_as_c_major() {
        // The definition of the method: correlating a profile with itself is
        // the maximum possible score, so this cannot come back as anything
        // else unless a rotation is backwards.
        let key = from_chroma(&MAJOR_PROFILE).unwrap();
        assert_eq!(key.label, "C major");
        assert_eq!(key.tonic, 0);
        assert!(key.major);
    }

    #[test]
    fn a_chroma_that_is_the_a_minor_profile_reads_as_a_minor() {
        // A minor is C major's relative — same seven notes — so this is the
        // pair the method most easily confuses, and the one that catches a
        // rotation applied in the wrong direction.
        let mut rotated = [0.0; 12];
        for i in 0..12 {
            rotated[i] = MINOR_PROFILE[(i + 12 - 9) % 12];
        }
        let key = from_chroma(&rotated).unwrap();
        assert_eq!(key.label, "A minor");
        assert!(!key.major);
    }

    #[test]
    fn every_transposition_of_the_major_profile_names_its_own_tonic() {
        for tonic in 0..12usize {
            let mut rotated = [0.0; 12];
            for i in 0..12 {
                rotated[i] = MAJOR_PROFILE[(i + 12 - tonic) % 12];
            }
            let key = from_chroma(&rotated).unwrap();
            assert_eq!(key.tonic as usize, tonic, "expected {} major, got {}", NAMES[tonic], key.label);
            assert!(key.major, "{} came back minor", NAMES[tonic]);
        }
    }

    #[test]
    fn every_transposition_of_the_minor_profile_names_its_own_tonic() {
        for tonic in 0..12usize {
            let mut rotated = [0.0; 12];
            for i in 0..12 {
                rotated[i] = MINOR_PROFILE[(i + 12 - tonic) % 12];
            }
            let key = from_chroma(&rotated).unwrap();
            assert_eq!(key.tonic as usize, tonic, "expected {} minor, got {}", NAMES[tonic], key.label);
            assert!(!key.major, "{} came back major", NAMES[tonic]);
        }
    }

    #[test]
    fn a_flat_chroma_names_no_key_rather_than_guessing_one() {
        // Every key correlates identically with a flat vector, so the margin
        // is zero. This is the case that would otherwise tint the whole app
        // for a key chosen by floating-point tie-breaking.
        assert!(from_chroma(&[1.0; 12]).is_none());
    }

    #[test]
    fn an_empty_chroma_names_no_key() {
        assert!(from_chroma(&[0.0; 12]).is_none());
    }

    #[test]
    fn confidence_is_the_margin_over_the_runner_up() {
        // A pure profile is maximally decisive. A song sitting halfway between
        // two unrelated keys is not, and must say so.
        //
        // Note what does NOT reduce it: scaling the whole vector, or blending
        // it toward flat. Pearson correlation is invariant to both, so a quiet
        // or low-contrast chroma is not by itself less certain about its key —
        // only genuine ambiguity between keys is.
        let sharp = from_chroma(&MAJOR_PROFILE).unwrap().confidence;

        let mut f_sharp_major = [0.0; 12];
        for i in 0..12 {
            f_sharp_major[i] = MAJOR_PROFILE[(i + 12 - 6) % 12];
        }
        let mut torn = [0.0; 12];
        for i in 0..12 {
            torn[i] = (MAJOR_PROFILE[i] + f_sharp_major[i]) / 2.0;
        }
        // C and F# major share almost nothing, so a 50/50 blend has no
        // defensible answer — either it comes back below the threshold
        // (None) or with a margin well under a decisive one.
        match from_chroma(&torn) {
            None => {}
            Some(k) => assert!(k.confidence < sharp, "an ambiguous chroma was as confident as a pure one: {} vs {sharp}", k.confidence),
        }
    }

    #[test]
    fn a_scaled_chroma_names_the_same_key() {
        // Correlation is scale-invariant, so a quiet passage and a loud one in
        // the same key must agree. Asserted because the alternative — a
        // detector whose answer depends on level — would look like a key that
        // changes when the chorus arrives.
        let mut loud = MAJOR_PROFILE;
        for v in loud.iter_mut() {
            *v *= 17.0;
        }
        assert_eq!(from_chroma(&loud).unwrap().label, from_chroma(&MAJOR_PROFILE).unwrap().label);
    }

    /* ------------------------------------------------------- the chroma --- */

    #[test]
    fn a_pure_tone_lands_in_its_own_pitch_class() {
        for (hz, class) in [(261.63, 0), (440.0, 9), (329.63, 4), (98.0, 7)] {
            assert_eq!(pitch_class(hz), class, "{hz} Hz");
        }
    }

    #[test]
    fn octaves_of_the_same_note_share_a_pitch_class() {
        // The entire point of chroma. If this fails the detector is reading a
        // spectrum, not a pitch-class profile.
        for (class, name) in NAMES.iter().enumerate() {
            for octave in 1..=6 {
                assert_eq!(pitch_class(hz_of(class, octave)), class, "{name} octave {octave}");
            }
        }
    }

    #[test]
    fn a_chord_puts_its_weight_on_its_own_notes() {
        // A minor triad: A, C, E.
        let frames = chromagram(&chord(&[9, 0, 4], 6.0), SR);
        assert!(!frames.is_empty());
        let mut mean = [0.0_f64; 12];
        for f in &frames {
            for (m, v) in mean.iter_mut().zip(f) {
                *m += *v as f64 / frames.len() as f64;
            }
        }
        let played: f64 = [9usize, 0, 4].iter().map(|&c| mean[c]).sum();
        assert!(played > 0.75, "only {played:.2} of the chroma landed on the played notes: {mean:?}");
    }

    #[test]
    fn every_chroma_frame_carries_the_same_weight() {
        // Per-frame normalisation, so a loud chord cannot outvote a quiet one.
        for f in chromagram(&chord(&[0, 4, 7], 4.0), SR) {
            let total: f32 = f.iter().sum();
            assert!((total - 1.0).abs() < 1e-4, "frame sums to {total}");
        }
    }

    /* ---------------------------------------------------- end to end --- */

    #[test]
    fn a_sustained_a_minor_triad_is_detected_as_a_minor_or_its_relative() {
        // An honest assertion. Three notes are not enough to separate A minor
        // from C major — they share all of them, and a real listener needs the
        // bass or the cadence to decide. So this pins what the maths CAN know:
        // the right set of notes, not a coin toss between the two readings of
        // them.
        let key = detect(&chord(&[9, 0, 4], 15.0), SR).expect("no key found for a sustained triad");
        assert!(
            key.label == "A minor" || key.label == "C major",
            "expected A minor or its relative C major, got {}",
            key.label
        );
    }

    #[test]
    fn silence_has_no_key() {
        assert!(detect(&vec![0.0; SR as usize * 15], SR).is_none());
    }

    #[test]
    fn too_little_audio_is_declined() {
        assert!(detect(&chord(&[0, 4, 7], 3.0), SR).is_none());
        assert!(detect(&[], SR).is_none());
    }

    #[test]
    fn a_zero_sample_rate_does_not_divide_by_zero() {
        assert!(detect(&chord(&[0, 4, 7], 15.0), 0).is_none());
        assert!(chromagram(&chord(&[0, 4, 7], 15.0), 0).is_empty());
    }

    #[test]
    fn the_published_profiles_are_intact() {
        // These twelve pairs of numbers ARE the method. A typo in one does not
        // fail anything — it shifts which key wins for a whole class of songs.
        assert_eq!(MAJOR_PROFILE[0], 6.35, "major tonic");
        assert_eq!(MAJOR_PROFILE[4], 4.38, "major third");
        assert_eq!(MAJOR_PROFILE[7], 5.19, "major fifth");
        assert_eq!(MINOR_PROFILE[0], 6.33, "minor tonic");
        assert_eq!(MINOR_PROFILE[3], 5.38, "minor third");
        assert_eq!(MINOR_PROFILE[7], 4.75, "minor fifth");
        // The tonic is the most stable degree in both — the strongest single
        // structural claim either profile makes.
        let strongest = |p: &[f64; 12]| p.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(strongest(&MAJOR_PROFILE), 0, "the major profile's peak is not its tonic");
        assert_eq!(strongest(&MINOR_PROFILE), 0, "the minor profile's peak is not its tonic");
        // And the third is what separates the two modes: natural-three in
        // major, flat-three in minor. Swap these and every song comes back as
        // its own relative.
        let third = |p: &[f64; 12]| if p[3] > p[4] { 3 } else { 4 };
        assert_eq!(third(&MAJOR_PROFILE), 4, "major profile does not favour its own third");
        assert_eq!(third(&MINOR_PROFILE), 3, "minor profile does not favour its own third");
    }
}
