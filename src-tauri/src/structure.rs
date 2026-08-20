//! Where a song changes section — verse to chorus, break to drop.
//!
//! JOB-ENGINE §5.4. Foote's method, which is the standard one and is entirely
//! geometric:
//!
//! 1. Take the chromagram (`key::chromagram` — the same pass key detection
//!    already runs, which is why it returns per-frame vectors).
//! 2. For every pair of frames, how similar are they? That is the
//!    self-similarity matrix. A song's SSM has visible square blocks along the
//!    diagonal: within a chorus every frame resembles every other, and the
//!    boundary between two sections is where one block stops and the next
//!    begins.
//! 3. Slide a **checkerboard kernel** down that diagonal. It is positive on
//!    the two "within a block" quadrants and negative on the two "across the
//!    boundary" quadrants, so its response is large exactly where the music
//!    stops resembling itself and starts resembling something else. That
//!    response is the novelty curve; its peaks are the boundaries.
//!
//! **Why this and not the energy tiers the heat map already computes.**
//! `heatmap.js`'s `sections()` splits a song where its *loudness* changes,
//! which is a decent proxy and genuinely wrong in two common cases: a verse
//! and a chorus at the same level are one section, and a crescendo inside one
//! section is two. Chroma novelty splits where the *harmony* changes, which is
//! what a section boundary actually is. The two compose — this supplies the
//! boundaries, the heat map still names each resulting section from its
//! energy, so `kind` ("drop", "build", "verse") keeps meaning exactly what it
//! meant before.
//!
//! **What it deliberately does not do:** name sections by repetition (the
//! A-B-A-B-C that would let "chorus" mean the repeated one). That needs
//! segment clustering on top of this, and nothing in the app consumes it yet.
//! The boundaries are the part with a consumer today.

/// Half-width of the checkerboard kernel, in chroma frames. At `key.rs`'s hop
/// this is a little under three seconds each side — long enough to average
/// over a bar at any tempo, short enough to localise a boundary.
const KERNEL_HALF: usize = 32;

/// Sections shorter than this are not sections. Also the minimum distance
/// between accepted peaks, which is what stops one boundary being reported
/// three times as the novelty curve wobbles across it.
const MIN_SECTION_SECS: f64 = 8.0;

/// A peak must stand this many standard deviations above the novelty curve's
/// mean to count. Set from the same reasoning as everything else here: a
/// segmenter that always finds boundaries will chop a five-minute ambient
/// piece into eight sections that do not exist.
const PEAK_SIGMA: f64 = 1.0;

/// …and it must also clear this fraction of a *perfect* boundary's response.
///
/// A perfect boundary — everything before it identical, everything after it
/// identical, nothing shared across — scores about half the kernel's total
/// magnitude, since the positive quadrants see similarity 1 and the negative
/// ones see 0. This floor is a tenth of that. It exists because the sigma
/// threshold alone cannot refuse: a song with no harmonic change has a novelty
/// curve flat at approximately zero, whose standard deviation is also
/// approximately zero, so noise is many sigma above the mean.
const PEAK_FLOOR_FRACTION: f64 = 0.10;

/// Below this there is no structure worth finding.
const MIN_SECONDS: f64 = 30.0;

/// Section starts, in milliseconds. Always begins with 0.0, so the list can be
/// walked in pairs against the track's end.
pub fn detect(samples: &[f32], sample_rate: u32) -> Option<Vec<f64>> {
    if sample_rate == 0 || (samples.len() as f64) < MIN_SECONDS * sample_rate as f64 {
        return None;
    }
    let frames = crate::key::chromagram(samples, sample_rate);
    if frames.len() < KERNEL_HALF * 4 {
        return None;
    }
    let total_ms = samples.len() as f64 / sample_rate as f64 * 1000.0;
    // Frames come from a hop the chromagram owns; derive the rate from the
    // frame count rather than duplicating the constant here, so the two cannot
    // drift apart.
    let fps = frames.len() as f64 / (samples.len() as f64 / sample_rate as f64);

    let novelty = novelty_curve(&frames);
    let min_gap = (MIN_SECTION_SECS * fps).round().max(1.0) as usize;
    // The response a perfect boundary would give, so the floor below is
    // expressed against what this kernel can actually produce rather than as a
    // magic number that would silently change meaning if KERNEL_HALF did.
    let perfect: f64 = checkerboard(KERNEL_HALF).iter().map(|v| v.abs()).sum::<f64>() / 2.0;
    let peaks = pick_peaks(&novelty, min_gap, PEAK_SIGMA, perfect * PEAK_FLOOR_FRACTION);

    let mut starts = vec![0.0];
    for p in peaks {
        let ms = p as f64 * 1000.0 / fps;
        // A boundary in the last few seconds would create a section too short
        // to be one; the same rule as the gap, applied at the end where there
        // is no following peak to enforce it.
        if ms > MIN_SECTION_SECS * 1000.0 && total_ms - ms > MIN_SECTION_SECS * 1000.0 {
            starts.push(ms);
        }
    }
    (starts.len() > 1).then_some(starts)
}

/// Foote novelty: the checkerboard kernel's response along the diagonal.
///
/// Only the band of the self-similarity matrix within `2·KERNEL_HALF` of the
/// diagonal is ever read, so only that band is computed — the full matrix for
/// a four-minute song is 27 MB of which this uses 5%.
fn novelty_curve(frames: &[[f32; 12]]) -> Vec<f64> {
    let n = frames.len();
    let l = KERNEL_HALF;
    let width = 4 * l + 1; // offsets -2l ..= 2l
    let mut band = vec![0.0_f32; n * width];
    for r in 0..n {
        for k in 0..width {
            let c = r as isize + k as isize - 2 * l as isize;
            if c >= 0 && (c as usize) < n {
                band[r * width + k] = cosine(&frames[r], &frames[c as usize]);
            }
        }
    }

    let kernel = checkerboard(l);
    let mut novelty = vec![0.0_f64; n];
    for (t, out) in novelty.iter_mut().enumerate() {
        if t < l || t + l >= n {
            continue; // the kernel does not fit; leave it at zero
        }
        let mut sum = 0.0_f64;
        for i in 0..2 * l {
            let row = t + i - l;
            for j in 0..2 * l {
                let offset = (j as isize - i as isize) + 2 * l as isize;
                sum += kernel[i * 2 * l + j] * band[row * width + offset as usize] as f64;
            }
        }
        *out = sum;
    }
    novelty
}

/// The checkerboard kernel, `2l × 2l`, Gaussian-tapered.
///
/// Positive where both offsets are on the same side of the centre (frames
/// within one block should resemble each other) and negative where they are on
/// opposite sides (frames across a boundary should not). The taper is what
/// stops the kernel's far corners — which are two full sections apart and say
/// nothing about a boundary here — dominating the response.
fn checkerboard(l: usize) -> Vec<f64> {
    let size = 2 * l;
    let sigma = l as f64 / 2.0;
    let mut k = vec![0.0; size * size];
    for i in 0..size {
        for j in 0..size {
            let di = i as f64 - l as f64 + 0.5;
            let dj = j as f64 - l as f64 + 0.5;
            let taper = (-(di * di + dj * dj) / (2.0 * sigma * sigma)).exp();
            let sign = if (i < l) == (j < l) { 1.0 } else { -1.0 };
            k[i * size + j] = sign * taper;
        }
    }
    k
}

/// Cosine similarity of two chroma vectors, in 0..1 (chroma is non-negative,
/// so it never goes below zero).
fn cosine(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..12 {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let den = (na * nb).sqrt();
    if den < 1e-12 {
        0.0
    } else {
        dot / den
    }
}

/// Local maxima at least `sigma` standard deviations above the mean *and*
/// above `floor`, no two closer together than `min_gap`.
///
/// The absolute `floor` is not redundant with the relative threshold, and
/// leaving it out was a real bug: a song that never changes harmony has a
/// novelty curve that is flat at approximately zero, so its standard deviation
/// is approximately zero, so *any* floating-point wobble is several sigma above
/// the mean. A purely relative threshold always finds boundaries, including in
/// a track that has none.
///
/// Greedy from the strongest peak down rather than left to right, so when two
/// candidates are too close the *better* one survives — scanning forwards
/// would keep whichever came first and suppress a stronger boundary just after
/// it.
fn pick_peaks(curve: &[f64], min_gap: usize, sigma: f64, floor: f64) -> Vec<usize> {
    if curve.len() < 3 {
        return Vec::new();
    }
    let n = curve.len() as f64;
    let mean = curve.iter().sum::<f64>() / n;
    let sd = (curve.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt();
    let threshold = (mean + sigma * sd).max(floor);

    let mut candidates: Vec<(usize, f64)> = (1..curve.len() - 1)
        .filter(|&i| curve[i] > threshold && curve[i] >= curve[i - 1] && curve[i] > curve[i + 1])
        .map(|i| (i, curve[i]))
        .collect();
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));

    let mut kept: Vec<usize> = Vec::new();
    for (i, _) in candidates {
        if kept.iter().all(|&k| i.abs_diff(k) >= min_gap) {
            kept.push(i);
        }
    }
    kept.sort_unstable();
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// A block of sustained pitch classes — one "section".
    fn section(classes: &[usize], seconds: f64) -> Vec<f32> {
        let n = (seconds * SR as f64) as usize;
        let mut out = vec![0.0_f32; n];
        for &c in classes {
            for octave in 2..=4 {
                let midi = 12 * (octave + 1) + c as i32;
                let hz = 440.0 * 2f64.powf((midi - 69) as f64 / 12.0);
                for (i, s) in out.iter_mut().enumerate() {
                    *s += (std::f64::consts::TAU * hz * i as f64 / SR as f64).sin() as f32 * 0.1;
                }
            }
        }
        out
    }

    /* -------------------------------------------------------- the kernel --- */

    #[test]
    fn the_kernel_is_a_checkerboard() {
        let l = 4;
        let k = checkerboard(l);
        let at = |i: usize, j: usize| k[i * 2 * l + j];
        // Same side of the centre in both axes → positive; opposite → negative.
        assert!(at(0, 0) > 0.0, "top-left quadrant should be positive");
        assert!(at(2 * l - 1, 2 * l - 1) > 0.0, "bottom-right quadrant should be positive");
        assert!(at(0, 2 * l - 1) < 0.0, "top-right quadrant should be negative");
        assert!(at(2 * l - 1, 0) < 0.0, "bottom-left quadrant should be negative");
    }

    #[test]
    fn the_kernel_sums_to_about_zero() {
        // The property that makes the response a NOVELTY measure rather than a
        // similarity one: a uniformly similar patch, whatever its level, must
        // produce nothing. Without it every loud section reads as a boundary.
        let k = checkerboard(KERNEL_HALF);
        let sum: f64 = k.iter().sum();
        let magnitude: f64 = k.iter().map(|v| v.abs()).sum();
        assert!(sum.abs() / magnitude < 1e-9, "kernel is unbalanced: {sum} against {magnitude}");
    }

    #[test]
    fn the_kernel_tapers_away_from_the_centre() {
        // Untapered, the far corners — two whole sections apart, and silent
        // about any boundary here — would dominate the response.
        let l = 8;
        let k = checkerboard(l);
        let centre = k[(l - 1) * 2 * l + (l - 1)].abs();
        let corner = k[0].abs();
        assert!(centre > corner * 10.0, "no taper: centre {centre}, corner {corner}");
    }

    /* --------------------------------------------------------- similarity --- */

    #[test]
    fn a_chroma_vector_is_maximally_similar_to_itself() {
        let a = [0.1, 0.0, 0.4, 0.0, 0.2, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0, 0.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn chords_with_no_shared_notes_are_not_similar() {
        let mut a = [0.0; 12];
        let mut b = [0.0; 12];
        for c in [0, 4, 7] {
            a[c] = 1.0 / 3.0;
        }
        for c in [1, 5, 8] {
            b[c] = 1.0 / 3.0;
        }
        assert!(cosine(&a, &b) < 0.01, "disjoint chords scored {}", cosine(&a, &b));
    }

    #[test]
    fn an_empty_vector_is_similar_to_nothing_rather_than_dividing_by_zero() {
        let a = [0.0; 12];
        let b = [1.0; 12];
        assert_eq!(cosine(&a, &b), 0.0);
        assert_eq!(cosine(&a, &a), 0.0);
    }

    /* ------------------------------------------------------ peak picking --- */

    #[test]
    fn only_peaks_above_the_threshold_survive() {
        let curve = vec![0.1, 0.2, 0.1, 5.0, 0.1, 0.2, 0.1];
        assert_eq!(pick_peaks(&curve, 1, 1.0, 0.0), vec![3]);
    }

    #[test]
    fn two_peaks_closer_than_the_gap_keep_the_stronger_one() {
        // Scanning left to right would keep index 3 and suppress the taller
        // peak two frames later, reporting a boundary at the wrong place.
        let curve = vec![0.0, 0.0, 0.0, 4.0, 0.0, 9.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(pick_peaks(&curve, 4, 0.5, 0.0), vec![5]);
    }

    #[test]
    fn peaks_come_back_in_order() {
        let mut curve = vec![0.0; 60];
        for i in [10usize, 30, 50] {
            curve[i] = 9.0;
        }
        assert_eq!(pick_peaks(&curve, 5, 1.0, 0.0), vec![10, 30, 50]);
    }

    #[test]
    fn a_flat_curve_has_no_peaks() {
        // The failure worth avoiding: a segmenter that always answers will
        // chop an ambient piece into sections that do not exist.
        assert!(pick_peaks(&[1.0; 200], 5, 1.0, 0.0).is_empty());
        assert!(pick_peaks(&[], 5, 1.0, 0.0).is_empty());
        assert!(pick_peaks(&[0.0, 1.0], 5, 1.0, 0.0).is_empty());
    }

    /* ---------------------------------------------------------- end to end --- */

    #[test]
    fn a_harmonic_change_is_found_where_it_happens() {
        // Two 30-second blocks with no notes in common. The boundary is at
        // 30 s and there is exactly one.
        let mut audio = section(&[0, 4, 7], 30.0); // C major
        audio.extend(section(&[1, 5, 8], 30.0)); // C# major — nothing shared
        let starts = detect(&audio, SR).expect("no structure found across an obvious boundary");
        assert_eq!(starts.len(), 2, "expected one boundary, got {starts:?}");
        assert_eq!(starts[0], 0.0);
        assert!((starts[1] - 30_000.0).abs() < 3_000.0, "boundary at {:.0}ms, expected ~30000", starts[1]);
    }

    #[test]
    fn a_song_that_never_changes_harmony_has_no_boundaries() {
        assert!(detect(&section(&[0, 4, 7], 60.0), SR).is_none());
    }

    #[test]
    fn silence_has_no_structure() {
        assert!(detect(&vec![0.0; SR as usize * 60], SR).is_none());
    }

    #[test]
    fn too_little_audio_is_declined() {
        assert!(detect(&section(&[0, 4, 7], 10.0), SR).is_none());
        assert!(detect(&[], SR).is_none());
    }

    #[test]
    fn a_zero_sample_rate_does_not_divide_by_zero() {
        assert!(detect(&section(&[0, 4, 7], 60.0), 0).is_none());
    }
}
