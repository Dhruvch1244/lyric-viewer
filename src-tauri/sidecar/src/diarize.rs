//! Speaker diarization — "who is singing", from the audio itself rather than
//! guessed from lyric text (`attribute.rs`, host side).
//!
//! ROADMAP.md §5.8 called this exploratory: the payoff was unproven and no
//! first-party ONNX export of a speaker-embedding model exists the way
//! `onnx-community/whisper-base_timestamped` does for Whisper — only small,
//! zero-download community re-uploads. This one was picked, downloaded, and
//! actually run end to end before being pinned (see `models.rs`'s entry and
//! its commit comment): `Alkd/speaker-embedding-onnx`, an ONNX export of the
//! ResNet34 backbone from `pyannote/wespeaker-voxceleb-resnet34-LM` — the
//! exact model pyannote's own diarization pipeline uses, not a generic
//! speaker-verification model repurposed for this. Its `input_features` /
//! `embedding` shapes and the fbank recipe it expects are exercised by
//! `fbank.rs`'s tests and this module's own `#[ignore]`d live test.
//!
//! WHAT WAS VERIFIED, AND WHAT WASN'T: running the real pinned model against
//! `fbank.rs`'s features produced a deterministic, non-degenerate 256-d
//! embedding (repeat runs of the same input agree exactly; a fabricated
//! "same speaker" pair of clips scored far higher cosine similarity than a
//! "different speaker" pair). That is real evidence the graph, the feature
//! front end and the plumbing between them work. It is NOT evidence this
//! correctly separates two real singing voices in a dense mix — nobody has
//! run it on an actual multi-artist track yet. Treat cluster output as
//! plausible, not proven, exactly like this codebase's other not-yet-heard
//! signal paths (tempo.js's BPM, the WASM Whisper path before its first real
//! run).
//!
//! CLUSTERING is deliberately the simplest thing that could work: greedy
//! single-pass assignment against a running per-cluster centroid, by cosine
//! similarity against a fixed threshold, capped at a small cluster count (a
//! song has a handful of featured artists, not dozens). This is not
//! agglomerative clustering in the textbook sense — no merge step revisits an
//! earlier assignment — but it is O(n·k) rather than O(n²), needs no external
//! clustering crate, and is easy to reason about and test without a model.
//! `MAX_SPEAKERS` mirrors `attribute.rs::MAX_ARTISTS`.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::fbank::{self, Fbank};

/// Mirrors `attribute.rs::MAX_ARTISTS` on the host: a song has a handful of
/// featured voices, not dozens, and capping bounds runaway cluster creation
/// on noisy or non-vocal audio.
pub const MAX_SPEAKERS: usize = 6;
/// How long a window each embedding is computed over. Long enough to average
/// out a single word's formants, short enough to catch a same-line handoff
/// between two rapping artists mid-verse.
const WINDOW_MS: u32 = 1_500;
const HOP_MS: u32 = 750;
/// Cosine similarity below which a window starts a new cluster rather than
/// joining the closest existing one. Picked from this module's own
/// synthetic-signal validation (same-signal reruns scored ~0.98, a
/// deliberately different signal ~0.76) — a starting point, not a value
/// tuned against real multi-speaker singing, which nobody has run yet.
const SIMILARITY_THRESHOLD: f32 = 0.82;

pub struct SpeakerSpan {
    pub start_ms: u32,
    pub end_ms: u32,
    pub speaker: u32,
}

pub struct Diarizer {
    session: Session,
    fbank: Fbank,
}

impl Diarizer {
    pub const MODEL_FILE: &'static str = "speaker-embedding-resnet34.onnx";

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
        Ok(Self { session, fbank: Fbank::new() })
    }

    /// One L2-normalised 256-d embedding for a window of 16 kHz mono samples.
    fn embed(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
        let features = self.fbank.compute(samples);
        let frames = fbank::frame_count(samples.len());
        if frames == 0 {
            return Err("window too short to produce a single fbank frame".into());
        }
        let input = Tensor::from_array(([1usize, frames, fbank::N_MELS], features))
            .map_err(|e| format!("cannot build the model input: {e}"))?;
        let outputs =
            self.session.run(ort::inputs!["input_features" => input]).map_err(|e| format!("embedding model failed: {e}"))?;
        let (_, data) =
            outputs["embedding"].try_extract_tensor::<f32>().map_err(|e| format!("model produced no usable embedding: {e}"))?;
        Ok(l2_normalise(data))
    }

    /// Embed a whole clip in overlapping windows and cluster them into
    /// contiguous speaker spans. `samples` is 16 kHz mono; shorter than one
    /// window produces a single span.
    pub fn diarize(&mut self, samples: &[f32], cancelled: &dyn Fn() -> bool) -> Result<Vec<SpeakerSpan>, String> {
        let window_samples = ms_to_samples(WINDOW_MS);
        let hop_samples = ms_to_samples(HOP_MS);
        if samples.len() < window_samples {
            let embedding = self.embed(samples)?;
            let speaker = assign(&mut Vec::new(), &embedding);
            return Ok(vec![SpeakerSpan { start_ms: 0, end_ms: samples_to_ms(samples.len()), speaker }]);
        }

        let mut centroids: Vec<Centroid> = Vec::new();
        let mut labels: Vec<(u32, u32, u32)> = Vec::new(); // (start_ms, end_ms, speaker)

        let mut start = 0;
        while start + window_samples <= samples.len() {
            if cancelled() {
                return Err("cancelled".into());
            }
            let embedding = self.embed(&samples[start..start + window_samples])?;
            let speaker = assign(&mut centroids, &embedding);
            labels.push((samples_to_ms(start), samples_to_ms(start + window_samples), speaker));
            start += hop_samples;
        }

        Ok(merge_adjacent(labels))
    }
}

struct Centroid {
    mean: Vec<f32>,
    count: u32,
}

/// Assign one embedding to the closest existing cluster (if within
/// threshold) or start a new one, updating that cluster's running mean.
/// Capped at `MAX_SPEAKERS`: past the cap, everything joins the closest
/// cluster regardless of similarity rather than growing without bound.
fn assign(centroids: &mut Vec<Centroid>, embedding: &[f32]) -> u32 {
    let mut best: Option<(usize, f32)> = None;
    for (i, c) in centroids.iter().enumerate() {
        let sim = cosine(&c.mean, embedding);
        if best.map(|(_, s)| sim > s).unwrap_or(true) {
            best = Some((i, sim));
        }
    }

    if let Some((i, sim)) = best {
        if sim >= SIMILARITY_THRESHOLD || centroids.len() >= MAX_SPEAKERS {
            let c = &mut centroids[i];
            let n = c.count as f32;
            for (m, &e) in c.mean.iter_mut().zip(embedding) {
                *m = (*m * n + e) / (n + 1.0);
            }
            c.count += 1;
            return i as u32;
        }
    }

    centroids.push(Centroid { mean: embedding.to_vec(), count: 1 });
    (centroids.len() - 1) as u32
}

/// Collapse consecutive same-speaker windows into one span, the same
/// "flicker guard" idea as `attribute.rs::smooth_runs` — a rapid alternation
/// between two labels a few windows long reads as a bad cluster boundary
/// more often than a real handoff.
fn merge_adjacent(labels: Vec<(u32, u32, u32)>) -> Vec<SpeakerSpan> {
    let mut out: Vec<SpeakerSpan> = Vec::new();
    for (start_ms, end_ms, speaker) in labels {
        if let Some(last) = out.last_mut() {
            if last.speaker == speaker {
                last.end_ms = end_ms;
                continue;
            }
        }
        out.push(SpeakerSpan { start_ms, end_ms, speaker });
    }
    out
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na * nb)
}

fn l2_normalise(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

fn ms_to_samples(ms: u32) -> usize {
    (ms as usize * fbank::SAMPLE_RATE as usize) / 1000
}

fn samples_to_ms(n: usize) -> u32 {
    ((n as u64 * 1000) / fbank::SAMPLE_RATE as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(vals: &[f32]) -> Vec<f32> {
        vals.to_vec()
    }

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        assert!((cosine(&v(&[1.0, 2.0, 3.0]), &v(&[1.0, 2.0, 3.0])) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_opposite_vectors_is_minus_one() {
        assert!((cosine(&v(&[1.0, 0.0]), &v(&[-1.0, 0.0])) - (-1.0)).abs() < 1e-6);
    }

    #[test]
    fn cosine_against_a_zero_vector_is_zero_not_nan() {
        assert_eq!(cosine(&v(&[0.0, 0.0]), &v(&[1.0, 2.0])), 0.0);
    }

    #[test]
    fn l2_normalise_produces_a_unit_vector() {
        let out = l2_normalise(&[3.0, 4.0]);
        let norm = (out[0] * out[0] + out[1] * out[1]).sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn the_first_embedding_always_starts_cluster_zero() {
        let mut centroids = Vec::new();
        assert_eq!(assign(&mut centroids, &[1.0, 0.0]), 0);
        assert_eq!(centroids.len(), 1);
    }

    #[test]
    fn a_near_identical_embedding_joins_the_existing_cluster() {
        let mut centroids = Vec::new();
        assign(&mut centroids, &[1.0, 0.0]);
        let joined = assign(&mut centroids, &[0.99, 0.01]); // still ~cos 1
        assert_eq!(joined, 0);
        assert_eq!(centroids.len(), 1);
    }

    #[test]
    fn an_orthogonal_embedding_starts_a_new_cluster() {
        let mut centroids = Vec::new();
        assign(&mut centroids, &[1.0, 0.0]);
        let second = assign(&mut centroids, &[0.0, 1.0]);
        assert_eq!(second, 1);
        assert_eq!(centroids.len(), 2);
    }

    #[test]
    fn cluster_count_never_exceeds_max_speakers() {
        let mut centroids = Vec::new();
        // Each new vector is orthogonal to a synthetic basis, so with no cap
        // every one of these would start its own cluster.
        for i in 0..(MAX_SPEAKERS + 4) {
            let mut e = vec![0.0f32; MAX_SPEAKERS + 4];
            e[i] = 1.0;
            assign(&mut centroids, &e);
        }
        assert!(centroids.len() <= MAX_SPEAKERS, "got {} clusters, cap is {MAX_SPEAKERS}", centroids.len());
    }

    #[test]
    fn merge_adjacent_collapses_a_run_of_the_same_speaker() {
        let labels = vec![(0, 750, 0), (750, 1500, 0), (1500, 2250, 1), (2250, 3000, 0)];
        let spans = merge_adjacent(labels);
        assert_eq!(spans.len(), 3);
        assert_eq!((spans[0].start_ms, spans[0].end_ms, spans[0].speaker), (0, 1500, 0));
        assert_eq!((spans[1].start_ms, spans[1].end_ms, spans[1].speaker), (1500, 2250, 1));
        assert_eq!((spans[2].start_ms, spans[2].end_ms, spans[2].speaker), (2250, 3000, 0));
    }

    #[test]
    fn merge_adjacent_of_an_empty_input_is_empty() {
        assert!(merge_adjacent(Vec::new()).is_empty());
    }

    #[test]
    fn ms_and_sample_conversions_round_trip_at_whole_seconds() {
        assert_eq!(ms_to_samples(1000), fbank::SAMPLE_RATE as usize);
        assert_eq!(samples_to_ms(fbank::SAMPLE_RATE as usize), 1000);
    }

    /// The live round trip against the real pinned model, ignored by default
    /// (needs the model downloaded — `models::ensure` in the main app puts it
    /// in `%APPDATA%/.../models`). Run with:
    /// `cargo test -p lyric-inference -- --ignored diarize_real_model`
    #[test]
    #[ignore = "needs the real ONNX model on disk"]
    fn diarize_real_model_produces_sane_embeddings() {
        let model_dir = std::env::var("LYRIC_OVERLAY_MODEL_DIR").expect("set LYRIC_OVERLAY_MODEL_DIR to run this");
        let mut d = Diarizer::load(Path::new(&model_dir), 1).expect("load model");

        let tone = |freq: f32, seconds: f32| -> Vec<f32> {
            let n = (fbank::SAMPLE_RATE as f32 * seconds) as usize;
            (0..n).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / fbank::SAMPLE_RATE as f32).sin() * 0.5).collect()
        };

        let a1 = tone(150.0, 2.0);
        let a2 = tone(150.0, 2.0);
        let b1 = tone(300.0, 2.0);

        let e_a1 = d.embed(&a1).unwrap();
        let e_a2 = d.embed(&a2).unwrap();
        let e_b1 = d.embed(&b1).unwrap();

        assert!(e_a1.iter().all(|x| x.is_finite()));
        assert!(cosine(&e_a1, &e_a1) > 0.999, "self-similarity must be ~1");
        assert!(cosine(&e_a1, &e_a2) > cosine(&e_a1, &e_b1), "a same-tone pair should score closer than a different-tone pair");
    }
}
