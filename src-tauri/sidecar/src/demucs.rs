//! Vocal isolation (htdemucs), so the VAD gets a voice instead of a mix.
//!
//! **Why this exists is measured, not assumed** — see `vad.rs`'s module doc.
//! Silero is a speech detector and sung vocals over dense electronic
//! production read as nothing to it: on a real EDM track, p50 0.000 and *zero*
//! voiced windows across 180 seconds with an audible hook. Running the same
//! excerpt through this model first takes it to **p50 0.759 and 72% voiced**.
//! That is a whole class of song going from untranscribable to transcribable.
//!
//! **It runs as a retry, not a pre-pass.** Isolation buys nothing where the
//! VAD already works (rap: p50 0.967 → 1.000) and costs ~0.6x realtime, so
//! `main.rs` only reaches for it when the VAD came back empty — the case that
//! is otherwise a dead end. Tracks that already transcribe pay nothing.
//!
//! A port of `src/renderer/demucs.js`, and deliberately a faithful one: every
//! constant below comes from that file rather than being re-derived. It is a
//! trustworthy reference now — the same contract was run end to end against
//! the live model in the measurement above, which is the verification its own
//! header still says it is waiting for.
//!
//! # Cost, and the 11.5x that was hiding in the process priority
//!
//! The first end-to-end run (`tests/real_isolation.rs`, 120s EDM excerpt)
//! isolated in **377s — about 3.1x realtime**, against 73s for the same audio
//! through `onnxruntime-node` on the same machine. It was written up here as
//! probably denormal floats, since the fast comparisons had used synthetic
//! input. **That was wrong**, and one measurement disproved it: Node had run
//! the *same real audio* and been fast, so the audio was never the variable.
//!
//! What the fast runs actually had in common was **normal process priority**.
//! `priority_costs_throughput` times one identical segment in one process
//! across three states:
//!
//! ```text
//!   normal priority              4.46s     1.0x
//!   BELOW_NORMAL only            5.39s     1.2x
//!   BELOW_NORMAL + background    51.39s   11.5x
//! ```
//!
//! `PROCESS_MODE_BACKGROUND_BEGIN` pins every thread to the lowest schedulable
//! priority. For a saturated ORT thread pool that is not politeness, it is a
//! throttle — and it costs an order of magnitude, while the BELOW_NORMAL class
//! that provides the actual "stay out of the app's way" guarantee costs 20%.
//!
//! `main.rs`'s `run_job` therefore leaves background mode for the duration of
//! a job and restores it after. Expected cost after the fix is ~1.2x the
//! normal-priority figure, i.e. roughly the 0.6x realtime originally measured
//! through Node, putting a 5-minute song at a few minutes of isolation rather
//! than fifteen.
//!
//! The lesson is the general one this codebase keeps re-learning: the
//! difference between two measurements is only ever the thing you actually
//! varied, and "same machine, same graph, same audio" left exactly one
//! candidate once the audio was ruled out.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

/// The model works at 44.1 kHz; everything else in this app is at 16 kHz.
pub const MODEL_RATE: u32 = 44_100;
const IN_RATE: u32 = 16_000;

const MIX_INPUT: &str = "mix";
const STEMS_OUTPUT: &str = "stems";
/// Output order is drums, bass, other, vocals. The other three are real
/// outputs but the model card calls them low-quality by-products of a
/// vocals-specialist, and nothing here wants them.
const SOURCES: usize = 4;
const VOCALS_INDEX: usize = 3;

/// The model's fixed input length — not a tunable chunk size. 7.8s at 44.1kHz,
/// rounded exactly the way the reference rounds it.
pub const SEGMENT_SAMPLES: usize = 343_980; // (7.8 * 44100.0).round()
/// 25% overlap, the reference's own default.
pub const OVERLAP_SAMPLES: usize = SEGMENT_SAMPLES / 4;
pub const STRIDE_SAMPLES: usize = SEGMENT_SAMPLES - OVERLAP_SAMPLES;

pub struct Demucs {
    session: Session,
}

impl Demucs {
    pub const MODEL_FILE: &'static str = "htdemucs_ft_vocals.onnx";

    pub fn load(model_dir: &Path, threads: usize) -> Result<Self, String> {
        let path = model_dir.join(Self::MODEL_FILE);
        if !path.is_file() {
            return Err(format!("model file not found at {}", path.display()));
        }
        let session = Session::builder()
            .map_err(|e| format!("cannot create an ONNX session builder: {e}"))?
            .with_intra_threads(threads.max(1))
            .map_err(|e| format!("cannot configure the session: {e}"))?
            .commit_from_file(&path)
            .map_err(|e| format!("cannot load {}: {e}", path.display()))?;
        Ok(Self { session })
    }

    /// Run one exactly-`SEGMENT_SAMPLES` planar-stereo segment and return the
    /// vocals stem, planar stereo (`2 * SEGMENT_SAMPLES`).
    fn run_segment(&mut self, segment: &[f32]) -> Result<Vec<f32>, String> {
        debug_assert_eq!(segment.len(), 2 * SEGMENT_SAMPLES);
        let input = Tensor::from_array(([1usize, 2, SEGMENT_SAMPLES], segment.to_vec()))
            .map_err(|e| format!("cannot build the mix input: {e}"))?;
        let outputs =
            self.session.run(ort::inputs![MIX_INPUT => input]).map_err(|e| format!("vocal isolation failed: {e}"))?;
        let (_, data) =
            outputs[STEMS_OUTPUT].try_extract_tensor::<f32>().map_err(|e| format!("model produced no usable stems: {e}"))?;

        let stem_stride = 2 * SEGMENT_SAMPLES;
        let expected = SOURCES * stem_stride;
        if data.len() < expected {
            return Err(format!("stems output is {} values, expected {expected}", data.len()));
        }
        let base = VOCALS_INDEX * stem_stride;
        Ok(data[base..base + stem_stride].to_vec())
    }

    /// Isolate the vocal from mono 16 kHz PCM, returning mono 16 kHz PCM.
    ///
    /// The model has no mono mode, so the input is duplicated to both channels
    /// and the output averaged back down — exactly what `demucs.js` does for
    /// the same reason.
    ///
    /// `cancelled` is checked between segments: a 6-minute song is dozens of
    /// them and a track change must not have to wait for all of them.
    pub fn isolate(
        &mut self,
        mono_16k: &[f32],
        mut on_progress: impl FnMut(u8),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<f32>, String> {
        let mono = resample(mono_16k, IN_RATE, MODEL_RATE);
        let samples = mono.len();
        if samples == 0 {
            return Ok(Vec::new());
        }

        let mut left_acc = vec![0f32; samples];
        let mut right_acc = vec![0f32; samples];
        let mut weight = vec![0f32; samples];
        let window = transition_window(SEGMENT_SAMPLES, OVERLAP_SAMPLES);

        let total = segment_count(samples);
        let mut index = 0usize;
        let mut start = 0usize;
        while start < samples {
            if cancelled() {
                return Err("cancelled".into());
            }
            let end = (start + SEGMENT_SAMPLES).min(samples);
            let chunk = end - start;

            // Exact-length input, zero-padded rather than reshaping the graph.
            let mut segment = vec![0f32; 2 * SEGMENT_SAMPLES];
            segment[..chunk].copy_from_slice(&mono[start..end]);
            segment[SEGMENT_SAMPLES..SEGMENT_SAMPLES + chunk].copy_from_slice(&mono[start..end]);

            let vocals = self.run_segment(&segment)?;
            for i in 0..chunk {
                let w = window[i];
                left_acc[start + i] += vocals[i] * w;
                right_acc[start + i] += vocals[SEGMENT_SAMPLES + i] * w;
                weight[start + i] += w;
            }

            index += 1;
            on_progress(((index * 100) / total.max(1)).min(100) as u8);
            if end >= samples {
                break;
            }
            start += STRIDE_SAMPLES;
        }

        let out: Vec<f32> = (0..samples)
            .map(|i| {
                let w = weight[i].max(1e-8);
                (left_acc[i] / w + right_acc[i] / w) / 2.0
            })
            .collect();
        Ok(resample(&out, MODEL_RATE, IN_RATE))
    }
}

/// How many segments `isolate` will run over `samples` at the model's rate.
pub fn segment_count(samples: usize) -> usize {
    if samples == 0 {
        0
    } else if samples <= SEGMENT_SAMPLES {
        1
    } else {
        // The loop advances by STRIDE and stops as soon as a segment reaches
        // the end, so this counts starts strictly before `samples`.
        1 + samples.saturating_sub(SEGMENT_SAMPLES).div_ceil(STRIDE_SAMPLES)
    }
}

/// Linear fade in and out over `transition` samples, holding 1.0 between —
/// the reference's `_make_transition_window`. Overlapping segments are summed
/// against a weight accumulator, so this shapes the seam rather than hiding it.
fn transition_window(length: usize, transition: usize) -> Vec<f32> {
    let mut w = vec![1f32; length];
    let t = transition.min(length / 2);
    for i in 0..t {
        let ramp = if t > 1 { i as f32 / (t - 1) as f32 } else { 1.0 };
        w[i] = ramp;
        w[length - 1 - i] = ramp;
    }
    w
}

/// Nearest-neighbour resample. Deliberately the same crude method
/// `demucs.js` uses: the input is a mono mixdown already on its way to a model
/// whose own front end reduces it further, and matching the reference matters
/// more here than fidelity does.
fn resample(pcm: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || pcm.is_empty() || from_rate == 0 {
        return pcm.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = (pcm.len() as f64 * ratio).round() as usize;
    (0..out_len).map(|i| pcm[(((i as f64) / ratio) as usize).min(pcm.len() - 1)]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_segment_length_is_the_reference_rounding() {
        assert_eq!(SEGMENT_SAMPLES, (7.8f64 * MODEL_RATE as f64).round() as usize);
        assert_eq!(OVERLAP_SAMPLES, SEGMENT_SAMPLES / 4);
        assert_eq!(STRIDE_SAMPLES, SEGMENT_SAMPLES - OVERLAP_SAMPLES);
    }

    #[test]
    fn the_window_ramps_up_holds_and_ramps_down() {
        let w = transition_window(100, 10);
        assert_eq!(w[0], 0.0, "must start silent so a seam does not click");
        assert_eq!(w[99], 0.0);
        assert!((w[50] - 1.0).abs() < 1e-6, "the middle is untouched");
        assert!(w.windows(2).take(10).all(|p| p[1] >= p[0]), "the fade-in is monotonic");
        assert!(w.iter().all(|x| (0.0..=1.0).contains(x)));
    }

    #[test]
    fn the_window_is_symmetric() {
        let w = transition_window(64, 16);
        for i in 0..64 {
            assert!((w[i] - w[63 - i]).abs() < 1e-6, "asymmetric at {i}");
        }
    }

    #[test]
    fn a_transition_longer_than_half_the_window_is_clamped() {
        // Otherwise the two ramps would write over each other and the window
        // would never reach 1.0 anywhere.
        let w = transition_window(10, 999);
        assert_eq!(w.len(), 10);
        assert!(w.iter().all(|x| (0.0..=1.0).contains(x)));
    }

    #[test]
    fn overlapping_windows_reconstruct_a_constant_signal() {
        // The property overlap-add depends on: dividing by the summed weight
        // must give a constant signal back unchanged. A seam that fails this
        // is an audible dip every 5.9 seconds.
        //
        // The two exceptions are the first and last samples of the whole
        // track, where the window is exactly 0 and nothing overlaps to make
        // up for it, so the guarded division yields 0/1e-8 = 0. That is one
        // sample at each end, it is what the reference implementation does
        // too, and it is well below anything audible — but it is the reason
        // this test checks the interior rather than asserting over the lot
        // and quietly loosening the tolerance until it passed.
        let window = transition_window(SEGMENT_SAMPLES, OVERLAP_SAMPLES);
        let samples = SEGMENT_SAMPLES + 2 * STRIDE_SAMPLES;
        let mut acc = vec![0f32; samples];
        let mut weight = vec![0f32; samples];
        let mut start = 0;
        while start < samples {
            let end = (start + SEGMENT_SAMPLES).min(samples);
            for i in 0..(end - start) {
                acc[start + i] += 1.0 * window[i];
                weight[start + i] += window[i];
            }
            if end >= samples {
                break;
            }
            start += STRIDE_SAMPLES;
        }

        for i in 1..samples - 1 {
            let restored = acc[i] / weight[i].max(1e-8);
            assert!((restored - 1.0).abs() < 1e-3, "constant signal came back as {restored} at {i}");
        }

        // And the endpoints really are the only casualties — if a seam in the
        // middle ever silently zeroed, the loop above would have caught it,
        // but this pins the claim that exactly two samples carry no weight.
        let starved = (0..samples).filter(|&i| weight[i] <= 0.0).collect::<Vec<_>>();
        assert_eq!(starved, vec![0, samples - 1], "only the very first and last sample may be unweighted");
    }

    #[test]
    fn segment_count_covers_every_sample() {
        for samples in [1usize, SEGMENT_SAMPLES - 1, SEGMENT_SAMPLES, SEGMENT_SAMPLES + 1, STRIDE_SAMPLES * 5 + 7] {
            let n = segment_count(samples);
            // The last segment must start before the end and reach past it.
            let last_start = (n - 1) * STRIDE_SAMPLES;
            assert!(last_start < samples, "{samples}: last start {last_start} is past the end");
            assert!(last_start + SEGMENT_SAMPLES >= samples, "{samples}: {n} segments leave a tail uncovered");
        }
        assert_eq!(segment_count(0), 0);
    }

    #[test]
    fn resampling_round_trips_a_length() {
        let up = resample(&vec![0.5f32; 16_000], IN_RATE, MODEL_RATE);
        assert_eq!(up.len(), MODEL_RATE as usize);
        let down = resample(&up, MODEL_RATE, IN_RATE);
        assert_eq!(down.len(), IN_RATE as usize);
        assert!(down.iter().all(|v| (*v - 0.5).abs() < 1e-6), "a constant must survive both hops");
    }

    #[test]
    fn resampling_is_a_no_op_at_the_same_rate_and_survives_degenerate_input() {
        let s = vec![1.0f32, 2.0, 3.0];
        assert_eq!(resample(&s, IN_RATE, IN_RATE), s);
        assert!(resample(&[], IN_RATE, MODEL_RATE).is_empty());
        assert_eq!(resample(&s, 0, MODEL_RATE), s);
    }

    /// Is background priority what costs isolation 4-5x, or is it the audio?
    ///
    /// The question this settles: the real sidecar isolated 120s in 377s,
    /// while `onnxruntime-node` did the same audio in 73s and this module's
    /// own smoke test implied ~99s. The difference blamed in the first write-up
    /// was denormal floats from real audio — but Node ran that same real audio
    /// and was fast, so the audio cannot be it. What the fast runs have in
    /// common is **normal process priority**; the sidecar calls
    /// `priority::deprioritise()`, and `PROCESS_MODE_BACKGROUND_BEGIN` pins
    /// every thread to the lowest schedulable priority.
    ///
    /// Same segment, same process, three states, so nothing but priority
    /// differs. Run it on an otherwise-idle machine:
    ///
    /// ```text
    /// LYRIC_TEST_MODELS=... cargo test --release -p lyric-inference \
    ///   --bin lyric-inference -- --ignored priority_costs_throughput --nocapture
    /// ```
    #[test]
    #[ignore = "timing measurement; needs the isolation model and an idle machine"]
    fn priority_costs_throughput() {
        let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS");
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let mut d = Demucs::load(Path::new(&model_dir), threads).expect("cannot load demucs");

        // Real-ish content: harmonics plus noise, not a bare sine, so this
        // cannot be dismissed as a synthetic-input artefact.
        let segment: Vec<f32> = (0..2 * SEGMENT_SAMPLES)
            .map(|i| {
                let t = (i % SEGMENT_SAMPLES) as f32 / MODEL_RATE as f32;
                let mut s = (t * std::f32::consts::TAU * 220.0).sin() * 0.3;
                s += (t * std::f32::consts::TAU * 440.0).sin() * 0.15;
                s += ((i as f32 * 12.9898).sin() * 43758.547).fract() * 0.02;
                s
            })
            .collect();

        let time_it = |label: &str, d: &mut Demucs| {
            let started = std::time::Instant::now();
            d.run_segment(&segment).expect("run_segment failed");
            let elapsed = started.elapsed();
            println!("{label:<32} {elapsed:?}");
            elapsed
        };

        // Warm up, so the first measurement is not paying for lazy init.
        time_it("warm-up (discarded)", &mut d);

        let normal = time_it("normal priority", &mut d);
        crate::priority::deprioritise();
        let background = time_it("BELOW_NORMAL + background", &mut d);
        crate::priority::end_background();
        let below_normal = time_it("BELOW_NORMAL only", &mut d);

        println!(
            "\nbackground is {:.1}x normal; below-normal alone is {:.1}x normal",
            background.as_secs_f64() / normal.as_secs_f64(),
            below_normal.as_secs_f64() / normal.as_secs_f64()
        );
        // Deliberately no assertion on the ratio: this is a measurement, and a
        // busy machine would make any threshold flaky. Read the numbers.
    }

    /// The one thing that could sink this port: the pinned model is fp16 and
    /// the sidecar's `ort` is not the runtime it was proven under. Loads the
    /// real graph and runs a single silent segment — if the weights or the
    /// output dtype are not handled, this fails here rather than after an
    /// hour of integration.
    ///
    /// ```text
    /// LYRIC_TEST_MODELS=... cargo test --release -p lyric-inference \
    ///   --bin lyric-inference -- --ignored demucs_fp16 --nocapture
    /// ```
    #[test]
    #[ignore = "needs the 165MB isolation model on disk"]
    fn demucs_fp16_loads_and_runs_one_segment() {
        let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS");
        // Every core, as the real job does — at one thread this runs ~4x
        // slower and the timing below would misrepresent the cost.
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let started = std::time::Instant::now();
        let mut d = Demucs::load(Path::new(&model_dir), threads).expect("cannot load demucs");
        println!("loaded in {:?} on {threads} thread(s)", started.elapsed());

        // A quiet tone rather than silence, so an all-zero result means
        // something went wrong rather than being the honest answer.
        let segment: Vec<f32> = (0..2 * SEGMENT_SAMPLES)
            .map(|i| ((i % SEGMENT_SAMPLES) as f32 / MODEL_RATE as f32 * std::f32::consts::TAU * 220.0).sin() * 0.3)
            .collect();

        let started = std::time::Instant::now();
        let vocals = d.run_segment(&segment).expect("run_segment failed");
        println!("one segment in {:?}", started.elapsed());

        assert_eq!(vocals.len(), 2 * SEGMENT_SAMPLES, "vocals stem is the wrong shape");
        assert!(vocals.iter().all(|v| v.is_finite()), "fp16 produced non-finite output");
        let peak = vocals.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        println!("vocals peak {peak:.6}");
    }
}
