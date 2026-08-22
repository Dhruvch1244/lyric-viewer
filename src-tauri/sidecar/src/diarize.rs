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
//! # Status: the plumbing works; the capability is unproven and probably does
//! # not work on this app's music. Measured, twice. Read this before building
//! # anything on top of it.
//!
//! Everything below the model — VAD gating, the fbank front end, embedding,
//! agglomerative clustering, span construction, the protocol and the host
//! command — is correct and covered. What has **not** been shown is that the
//! output means anything, and two separate measurements say it does not:
//!
//! **1. The embedder does not separate two rappers on a dense mix.** On
//! Seedhe Maut — "Red" (a duo, 304s, 321 windows over 241s voiced) the
//! similarity distributions overlap almost entirely: adjacent windows (same
//! voice) run p25 0.572 / median 0.650 / p75 0.726, while windows ~30s apart
//! (mixed voices) run p25 0.265 / median 0.350 / p75 0.442 — but with a *max
//! of 0.655*, i.e. above the same-voice median. Clustering unconstrained
//! gives one cluster holding 99%. **Forced to exactly two clusters it gives
//! 320 windows against 1** — there is no two-lobed structure to find, just
//! one blob with outliers. This is not a threshold that needs tuning or a
//! clustering algorithm that needs replacing; the distinction is not in the
//! embeddings. The model (`wespeaker-voxceleb-resnet34`) is trained on
//! VoxCeleb — clean speech, one speaker per recording — and the same beat
//! running under both artists plausibly dominates what it encodes.
//!
//! **2. Silero does not fire at all on sung vocals over electronic
//! production**, which silences this module before it starts. On John Summit
//! / The Chainsmokers / Ilsey — "ALL THE TIME" (180s, a track with a clear
//! sung hook) the VAD returns **p50 0.000, p90 0.001, max 0.472 against a
//! 0.5 trigger — zero voiced windows in the whole track**. Not marginal:
//! confident that there is no speech. Rap survives it (79% voiced on the
//! Seedhe Maut track); singing over a loud full-range master does not.
//!
//! That second finding is **not limited to diarization** — `plan_work` in
//! `main.rs` gates transcription through the same VAD and errors with "no
//! speech found in this audio" when it comes back empty, so this class of
//! track cannot be auto-transcribed either. That is a shipped bug this work
//! happened to find, and it is worth more than diarization is.
//!
//! Before spending more here: run the vocal isolation the app already has
//! (Demucs, opt-in) and re-measure both. Removing the instrumental is the
//! obvious candidate for fixing both findings at once, and it is the cheapest
//! test remaining.
//!
//! CLUSTERING is agglomerative (bottom-up, centroid linkage) over every
//! window at once, capped at `MAX_SPEAKERS` — which mirrors
//! `attribute.rs::MAX_ARTISTS`. It replaced a greedy single-pass assignment
//! that could not recover from its own start; see `cluster` for that
//! measurement. O(n²·d) for n windows, which is milliseconds beside the
//! embeddings themselves.
//!
//! VOICED AUDIO ONLY, and that is not an optimisation. The first real run of
//! this module (Seedhe Maut — "Red", a duo, 304s) spent its first six seconds
//! on the instrumental intro and produced **four of its six clusters there**,
//! one per window. The intro is not silent — RMS 0.048–0.087 against a
//! whole-track 0.26 — it simply has no voice in it, and a *speaker* embedding
//! model fed music returns something unstable that neighbouring windows do not
//! agree with, so every window starts a new cluster.
//!
//! That is the same failure `vad.rs` already exists to prevent on the
//! transcription side, where its doc puts it plainly: given 30s of
//! instrumental, Whisper does not return nothing, it invents plausible lyrics,
//! and not asking it is the only fix that works. Diarization has exactly that
//! problem and now takes exactly that fix — `main.rs` runs Silero first and
//! hands `diarize` only the voiced spans.
//!
//! The cost of not gating went further than a few junk clusters. Once those
//! four filled `MAX_SPEAKERS`, the old greedy `assign` fell into its `||
//! centroids.len() >= MAX_SPEAKERS` branch and force-joined **every** later
//! window to its nearest cluster regardless of similarity — the cap stopped
//! bounding the error and started silently changing the algorithm mid-track.
//! Both that and the greedy assignment itself are gone; see `cluster`.

use std::path::Path;

use inference_protocol::Span;
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
/// Shortest tail of a voiced span still worth embedding. A window shorter
/// than this carries too few fbank frames for the mean-subtracted features to
/// mean much, and a bad embedding does not fail — it clusters, wrongly.
const MIN_EMBED_MS: u32 = 500;
/// Least total time a cluster must hold to count as a person rather than a
/// few unstable windows. Below this it is folded into its nearest neighbour —
/// see `cluster`, and the run where a duo was reported as six speakers, four
/// of whom held under two seconds between them.
const MIN_SPEAKER_MS: u32 = 3_000;
/// Cosine similarity below which a window starts a new cluster rather than
/// joining the closest existing one.
///
/// **Measured on real music, after a guess got it badly wrong.** The first
/// value here was 0.82, read off synthetic tones (same-signal reruns ~0.98, a
/// deliberately different signal ~0.76). That does not transfer: run against
/// a real track, 0.82 sat above nearly the whole *same-voice* distribution,
/// so almost nothing matched anything and the clustering attributed 4.3s of
/// 241s of voiced audio before giving up.
///
/// `dump_similarity_distribution` (below) measures it properly. On Seedhe
/// Maut — "Red" (304s, 321 windows over 241s voiced):
///
/// ```text
/// adjacent windows (same voice, mostly)   p25 0.572  median 0.650  p75 0.726
/// ~30s apart      (mixed voices)          p25 0.265  median 0.350  p75 0.442
/// ```
///
/// Real separation, centred far lower than tones implied. 0.55 sits between
/// the two medians: it keeps ~79% of adjacent pairs together while rejecting
/// the great majority of far-apart ones.
///
/// The distributions do overlap (adjacent p05 0.291 against far p75 0.442),
/// so no single global threshold separates them cleanly — a limit of greedy
/// single-pass clustering, not of this number. If diarization ever needs to
/// be better than "roughly right", that is the thing to replace, and the
/// measurement above is the evidence for why.
const SIMILARITY_THRESHOLD: f32 = 0.55;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    /// Cluster the voiced parts of a clip into speaker spans.
    ///
    /// `samples` is 16 kHz mono; `voiced` is what Silero found (`vad.rs`), in
    /// milliseconds. Windows are laid down **inside** each voiced span rather
    /// than across the whole clip, so an instrumental passage contributes no
    /// embeddings at all — see this module's doc for the run that made that
    /// necessary. Passing a single span covering the whole clip reproduces
    /// the old ungated behaviour, which is what the caller does when the VAD
    /// model is missing.
    ///
    /// Complexity: O(w·k) for w windows and k clusters, k ≤ MAX_SPEAKERS.
    pub fn diarize(
        &mut self,
        samples: &[f32],
        voiced: &[Span],
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeakerSpan>, String> {
        let window_samples = ms_to_samples(WINDOW_MS);
        let hop_samples = ms_to_samples(HOP_MS).max(1);
        let min_samples = ms_to_samples(MIN_EMBED_MS);

        let mut windows: Vec<(u32, u32)> = Vec::new(); // (start_ms, end_ms)
        let mut embeddings: Vec<Vec<f32>> = Vec::new();

        for span in voiced {
            let span_start = ms_to_samples(span.start_ms).min(samples.len());
            let span_end = ms_to_samples(span.end_ms).min(samples.len());

            let mut start = span_start;
            while start < span_end {
                if cancelled() {
                    return Err("cancelled".into());
                }
                let end = (start + window_samples).min(span_end);
                if end - start < min_samples {
                    break; // a tail too short to embed honestly
                }
                embeddings.push(self.embed(&samples[start..end])?);
                windows.push((samples_to_ms(start), samples_to_ms(end)));
                start += hop_samples;
            }
        }

        let speakers = cluster(&embeddings, &windows, None);
        let labels = windows.iter().zip(speakers).map(|(&(s, e), spk)| (s, e, spk)).collect();
        Ok(make_disjoint(merge_adjacent(labels)))
    }
}

/// One cluster under construction: the windows in it and their mean vector.
struct Cluster {
    centroid: Vec<f32>,
    members: Vec<usize>,
}

impl Cluster {
    /// Total voiced time this cluster holds, used to tell a real voice from
    /// the handful of unstable windows at the edge of a voiced span.
    fn duration_ms(&self, windows: &[(u32, u32)]) -> u32 {
        self.members.iter().map(|&i| windows[i].1 - windows[i].0).sum()
    }
}

/// Agglomerative clustering over every window at once.
///
/// **This replaced a greedy single-pass assignment, because greedy could not
/// recover from its own start.** Measured on Seedhe Maut — "Red": the first
/// voiced span produced four clusters in five seconds (the windows at the
/// edge of a voiced span are unstable), those four permanently occupied
/// `MAX_SPEAKERS`, and when the second rapper arrived at 2:17 there was no
/// slot left for them — every window from there to the end of the track was
/// declined. 114.7s of 241s voiced attributed, 96% of it to one cluster.
///
/// Nothing about that is fixable by tuning a threshold: an online algorithm
/// commits to cluster identities before it has seen the evidence that would
/// name them. Since every embedding is computed up front anyway, there is no
/// reason to decide online. Bottom-up merging looks at all of them, so a few
/// odd windows early get absorbed instead of homesteading a cluster.
///
/// Centroid linkage, merging the closest pair until nothing is within
/// `SIMILARITY_THRESHOLD` — then further, if that still leaves more than
/// `MAX_SPEAKERS`. Clusters too short to be a performance are folded into
/// their nearest neighbour at the end.
///
/// Complexity: O(n²·d) time for n windows of d dimensions — n is a few
/// hundred for a song, so this is milliseconds against the seconds the
/// embeddings themselves cost.
fn cluster(embeddings: &[Vec<f32>], windows: &[(u32, u32)], target: Option<usize>) -> Vec<u32> {
    if embeddings.is_empty() {
        return Vec::new();
    }

    let mut clusters: Vec<Cluster> =
        embeddings.iter().enumerate().map(|(i, e)| Cluster { centroid: e.clone(), members: vec![i] }).collect();

    // `target` is how many voices the caller already knows are on the record —
    // a credit of "A feat. B" is two, and `attribute::split_artists` works
    // that out for free. When it is known, merge to exactly that many and let
    // the threshold say nothing: it cannot separate two rappers on one mix
    // (see SIMILARITY_THRESHOLD), but "there are two of them" is not
    // something it has to infer.
    let floor = target.map(|k| k.clamp(1, MAX_SPEAKERS)).unwrap_or(1);

    while clusters.len() > floor {
        let mut best: Option<(usize, usize, f32)> = None;
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                let sim = cosine(&clusters[i].centroid, &clusters[j].centroid);
                if best.map(|(_, _, s)| sim > s).unwrap_or(true) {
                    best = Some((i, j, sim));
                }
            }
        }
        let Some((i, j, sim)) = best else { break };
        // With a target, merge all the way down to it. Without one, stop once
        // the closest pair is genuinely unalike — unless there are still more
        // clusters than a song can plausibly have, in which case keep going.
        // The cap is the backstop, not the criterion.
        if target.is_none() && sim < SIMILARITY_THRESHOLD && clusters.len() <= MAX_SPEAKERS {
            break;
        }
        merge(&mut clusters, i, j);
    }

    // Fold away anything too brief to be someone's part. A run of a second or
    // two is the edge of a voiced span or a stray ad-lib, and leaving it as
    // its own "speaker" is how a duet ends up reported as six people.
    loop {
        // Never fold below a count the caller asserted; that is knowledge
        // about the record, and it outranks a duration heuristic.
        if clusters.len() <= floor.max(1) {
            break;
        }
        let Some(smallest) = (0..clusters.len()).min_by_key(|&i| clusters[i].duration_ms(windows)) else { break };
        if clusters[smallest].duration_ms(windows) >= MIN_SPEAKER_MS {
            break;
        }
        let nearest = (0..clusters.len())
            .filter(|&i| i != smallest)
            .max_by(|&a, &b| {
                let (sa, sb) =
                    (cosine(&clusters[smallest].centroid, &clusters[a].centroid), cosine(&clusters[smallest].centroid, &clusters[b].centroid));
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .expect("more than one cluster");
        merge(&mut clusters, smallest.min(nearest), smallest.max(nearest));
    }

    // Label by first appearance, so speaker 0 is whoever is heard first —
    // stable to read in a timeline, and the order `attribute.rs` would
    // naturally line up against a lineup.
    clusters.sort_by_key(|c| c.members.iter().copied().min().unwrap_or(usize::MAX));

    let mut labels = vec![0u32; embeddings.len()];
    for (id, c) in clusters.iter().enumerate() {
        for &m in &c.members {
            labels[m] = id as u32;
        }
    }
    labels
}

/// Merge cluster `j` into `i` (requires `i < j`), recomputing the centroid as
/// the membership-weighted mean so a big cluster is not dragged by a small one.
fn merge(clusters: &mut Vec<Cluster>, i: usize, j: usize) {
    debug_assert!(i < j, "merge expects i < j so the removal below cannot shift i");
    let gone = clusters.remove(j);
    let (ni, nj) = (clusters[i].members.len() as f32, gone.members.len() as f32);
    let target = &mut clusters[i];
    for (m, o) in target.centroid.iter_mut().zip(gone.centroid) {
        *m = (*m * ni + o * nj) / (ni + nj);
    }
    target.members.extend(gone.members);
}

/// Collapse consecutive same-speaker windows into one span, the same
/// "flicker guard" idea as `attribute.rs::smooth_runs` — a rapid alternation
/// between two labels a few windows long reads as a bad cluster boundary
/// more often than a real handoff.
///
/// Merges only windows that actually touch. Windows are gated to voiced audio
/// now, so two runs of the same speaker can sit either side of an
/// instrumental break; merging those would claim the speaker sang straight
/// through a passage the VAD found no voice in.
fn merge_adjacent(labels: Vec<(u32, u32, u32)>) -> Vec<SpeakerSpan> {
    let mut out: Vec<SpeakerSpan> = Vec::new();
    for (start_ms, end_ms, speaker) in labels {
        if let Some(last) = out.last_mut() {
            if last.speaker == speaker && start_ms <= last.end_ms {
                last.end_ms = last.end_ms.max(end_ms);
                continue;
            }
        }
        out.push(SpeakerSpan { start_ms, end_ms, speaker });
    }
    out
}

/// Cut overlaps so the timeline can be read as a partition of the track.
///
/// Windows overlap by `WINDOW_MS - HOP_MS`, so at every speaker change the
/// outgoing span's end sat *after* the incoming span's start and the two
/// double-counted that overlap. Measured on the first real run: 21 spans over
/// a 304.1s track reported 318.8s of coverage — 20 transitions × 750ms = 15.0s
/// of double-count, which is the entire discrepancy.
///
/// The true boundary is somewhere inside the overlap and the windows cannot
/// say where, so it is placed at the midpoint. Spans that already sit apart
/// (either side of a silence) are left alone.
fn make_disjoint(mut spans: Vec<SpeakerSpan>) -> Vec<SpeakerSpan> {
    for i in 1..spans.len() {
        let (prev_end, next_start) = (spans[i - 1].end_ms, spans[i].start_ms);
        if prev_end > next_start {
            let boundary = next_start + (prev_end - next_start) / 2;
            spans[i - 1].end_ms = boundary;
            spans[i].start_ms = boundary;
        }
    }
    // A span can be squeezed to nothing by the cut above when a single window
    // sits alone between two longer runs; drop it rather than emit start==end.
    spans.retain(|s| s.end_ms > s.start_ms);
    spans
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

    /// Windows long enough that no cluster is folded away by MIN_SPEAKER_MS.
    fn long_windows(n: usize) -> Vec<(u32, u32)> {
        (0..n as u32).map(|i| (i * 10_000, i * 10_000 + 10_000)).collect()
    }

    #[test]
    fn identical_embeddings_form_one_cluster() {
        let e = vec![vec![1.0, 0.0], vec![1.0, 0.0], vec![1.0, 0.0]];
        assert_eq!(cluster(&e, &long_windows(3), None), vec![0, 0, 0]);
    }

    #[test]
    fn two_distinct_voices_come_back_as_two_clusters() {
        let e = vec![vec![1.0, 0.0], vec![0.99, 0.01], vec![0.0, 1.0], vec![0.01, 0.99]];
        let labels = cluster(&e, &long_windows(4), None);
        assert_eq!(labels[0], labels[1], "the two similar windows belong together");
        assert_eq!(labels[2], labels[3], "so do the other two");
        assert_ne!(labels[0], labels[2], "and the two pairs are different people");
    }

    #[test]
    fn labels_are_ordered_by_first_appearance() {
        // Whoever is heard first is speaker 0, which is what makes a timeline
        // readable and what attribute.rs would line up against a lineup.
        let e = vec![vec![0.0, 1.0], vec![0.0, 1.0], vec![1.0, 0.0], vec![1.0, 0.0]];
        let labels = cluster(&e, &long_windows(4), None);
        assert_eq!(labels[0], 0);
        assert_ne!(labels[2], 0);
    }

    #[test]
    fn cluster_count_never_exceeds_max_speakers() {
        // Mutually orthogonal, so with no cap every one would stay separate.
        let n = MAX_SPEAKERS + 4;
        let e: Vec<Vec<f32>> = (0..n)
            .map(|i| {
                let mut v = vec![0.0f32; n];
                v[i] = 1.0;
                v
            })
            .collect();
        let labels = cluster(&e, &long_windows(n), None);
        let mut ids = labels.clone();
        ids.sort_unstable();
        ids.dedup();
        assert!(ids.len() <= MAX_SPEAKERS, "got {} clusters, cap is {MAX_SPEAKERS}", ids.len());
    }

    #[test]
    fn a_cluster_too_brief_to_be_a_person_is_folded_away() {
        // The regression this guards is the measured one: a duo came back as
        // six speakers, four of them holding under two seconds between them
        // from the unstable edge of a voiced span.
        let e = vec![vec![1.0, 0.0], vec![1.0, 0.0], vec![0.0, 1.0]];
        let windows = vec![(0, 20_000), (20_000, 40_000), (40_000, 40_400)]; // 400ms oddity
        let labels = cluster(&e, &windows, None);
        let mut ids = labels.clone();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 1, "a 400ms outlier is not a speaker: {labels:?}");
    }

    #[test]
    fn every_window_gets_a_label() {
        // Nothing is declined any more — an unassigned window used to vanish
        // from the timeline entirely, which is how 241s of voiced audio once
        // produced 4.3s of spans.
        let n = 12;
        let e: Vec<Vec<f32>> = (0..n)
            .map(|i| {
                let mut v = vec![0.0f32; 4];
                v[i % 4] = 1.0;
                v
            })
            .collect();
        assert_eq!(cluster(&e, &long_windows(n), None).len(), n);
    }

    #[test]
    fn clustering_nothing_produces_nothing() {
        assert!(cluster(&[], &[], None).is_empty());
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
    fn merge_adjacent_does_not_bridge_a_silence() {
        // Same speaker either side of an instrumental break. Merging these
        // would claim they sang through a passage the VAD found no voice in.
        let labels = vec![(0, 1500, 0), (60_000, 61_500, 0)];
        let spans = merge_adjacent(labels);
        assert_eq!(spans.len(), 2, "a gap must break the run, not be swallowed by it");
        assert_eq!(spans[0].end_ms, 1500);
        assert_eq!(spans[1].start_ms, 60_000);
    }

    #[test]
    fn merge_adjacent_of_an_empty_input_is_empty() {
        assert!(merge_adjacent(Vec::new()).is_empty());
    }

    #[test]
    fn make_disjoint_cuts_an_overlap_at_its_midpoint() {
        // The measured bug: a 1.5s window on a 750ms hop leaves the outgoing
        // span ending 750ms after the incoming one starts.
        let spans = vec![
            SpeakerSpan { start_ms: 0, end_ms: 1500, speaker: 0 },
            SpeakerSpan { start_ms: 750, end_ms: 2250, speaker: 1 },
        ];
        let out = make_disjoint(spans);
        assert_eq!(out[0].end_ms, out[1].start_ms, "spans must not overlap");
        assert_eq!(out[0].end_ms, 1125, "the boundary belongs at the middle of the overlap");
    }

    #[test]
    fn make_disjoint_leaves_a_real_gap_alone() {
        let spans = vec![
            SpeakerSpan { start_ms: 0, end_ms: 1500, speaker: 0 },
            SpeakerSpan { start_ms: 60_000, end_ms: 61_500, speaker: 1 },
        ];
        let out = make_disjoint(spans.clone());
        assert_eq!(out[0].end_ms, 1500);
        assert_eq!(out[1].start_ms, 60_000);
    }

    #[test]
    fn coverage_never_exceeds_the_span_it_was_measured_over() {
        // The whole point of make_disjoint, stated as the property that
        // failed on real audio: 318.8s of "coverage" on a 304.1s track.
        let windows: Vec<SpeakerSpan> = (0..20)
            .map(|i| SpeakerSpan { start_ms: i * 750, end_ms: i * 750 + 1500, speaker: i % 2 })
            .collect();
        let last_end = windows.last().unwrap().end_ms;
        let out = make_disjoint(windows);
        let covered: u32 = out.iter().map(|s| s.end_ms - s.start_ms).sum();
        assert!(covered <= last_end, "covered {covered}ms of a {last_end}ms range");
        for pair in out.windows(2) {
            assert!(pair[1].start_ms >= pair[0].end_ms, "still overlapping: {pair:?}");
        }
    }

    #[test]
    fn ms_and_sample_conversions_round_trip_at_whole_seconds() {
        assert_eq!(ms_to_samples(1000), fbank::SAMPLE_RATE as usize);
        assert_eq!(samples_to_ms(fbank::SAMPLE_RATE as usize), 1000);
    }

    /// Diagnostic, not a test — it prints and asserts almost nothing.
    ///
    /// `SIMILARITY_THRESHOLD` was originally picked from synthetic tones
    /// (same-signal ~0.98, different-signal ~0.76). That did not transfer: on
    /// a real track the first run with a strict cap clustered 4.3s out of
    /// 241s of voiced audio, because consecutive windows of the *same* singer
    /// were scoring below it. This dumps the actual distribution so the
    /// threshold can be read off real data instead of guessed twice.
    ///
    /// ```text
    /// LYRIC_TEST_PCM=... LYRIC_TEST_MODELS=... \
    ///   cargo test --release -p lyric-inference -- --ignored dump_similarity --nocapture
    /// ```
    #[test]
    #[ignore = "diagnostic; needs the real model and a PCM fixture"]
    fn dump_similarity_distribution() {
        let pcm_path = std::env::var("LYRIC_TEST_PCM").expect("set LYRIC_TEST_PCM");
        let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS");

        let bytes = std::fs::read(&pcm_path).expect("cannot read PCM");
        let samples: Vec<f32> =
            bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        println!("{} samples ({:.1}s)", samples.len(), samples.len() as f64 / 16_000.0);

        let mut vad = crate::vad::SileroVad::load(Path::new(&model_dir)).expect("cannot load VAD");

        // Raw probabilities, before any thresholding. A track that comes back
        // with zero voiced spans could be one Silero is confident has no
        // speech, or one sitting just under the trigger — those want very
        // different fixes, and the span list cannot tell them apart.
        let mut probs: Vec<f32> = Vec::new();
        let mut w = 0;
        while w + crate::vad::WINDOW_SAMPLES <= samples.len() {
            probs.push(vad.probability(&samples[w..w + crate::vad::WINDOW_SAMPLES]).expect("vad failed"));
            w += crate::vad::WINDOW_SAMPLES;
        }
        probs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| probs[((probs.len() - 1) as f64 * q) as usize];
        println!(
            "VAD probability over {} windows: min {:.3}  p50 {:.3}  p90 {:.3}  p99 {:.3}  max {:.3}  (trigger is 0.5)",
            probs.len(),
            probs[0],
            p(0.5),
            p(0.9),
            p(0.99),
            probs[probs.len() - 1]
        );
        println!("  windows over 0.5: {}", probs.iter().filter(|x| **x >= 0.5).count());

        let mut vad = crate::vad::SileroVad::load(Path::new(&model_dir)).expect("cannot load VAD");
        let voiced = vad.spans(&samples, |_| {}, &|| false).expect("VAD failed");
        println!("{} voiced span(s), {} ms voiced", voiced.len(), crate::vad::total_ms(&voiced));
        if voiced.is_empty() {
            println!("no voiced audio — nothing further to measure");
            return;
        }

        let mut d = Diarizer::load(Path::new(&model_dir), 0).expect("cannot load model");

        // Embed every window, remembering which voiced span it came from.
        let window = ms_to_samples(WINDOW_MS);
        let hop = ms_to_samples(HOP_MS);
        let min = ms_to_samples(MIN_EMBED_MS);
        let mut embeddings: Vec<(u32, Vec<f32>)> = Vec::new();
        for span in &voiced {
            let (s0, s1) = (ms_to_samples(span.start_ms).min(samples.len()), ms_to_samples(span.end_ms).min(samples.len()));
            let mut s = s0;
            while s < s1 {
                let e = (s + window).min(s1);
                if e - s < min {
                    break;
                }
                embeddings.push((samples_to_ms(s), d.embed(&samples[s..e]).expect("embed failed")));
                s += hop;
            }
        }
        println!("{} embeddings", embeddings.len());

        let pct = |sorted: &[f32], p: f64| sorted[((sorted.len() - 1) as f64 * p) as usize];

        // Neighbours: overlapping windows, almost always the same voice.
        let mut neighbour: Vec<f32> = embeddings.windows(2).map(|w| cosine(&w[0].1, &w[1].1)).collect();
        neighbour.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "\nadjacent-window similarity (same voice, mostly):\n  min {:.3}  p05 {:.3}  p25 {:.3}  median {:.3}  p75 {:.3}  max {:.3}",
            neighbour[0], pct(&neighbour, 0.05), pct(&neighbour, 0.25), pct(&neighbour, 0.5), pct(&neighbour, 0.75), neighbour[neighbour.len() - 1]
        );

        // Far apart: minutes between them, so more likely a different voice.
        let mut far: Vec<f32> = Vec::new();
        let stride = 40; // ~30s at a 750ms hop
        for i in 0..embeddings.len() {
            if i + stride < embeddings.len() {
                far.push(cosine(&embeddings[i].1, &embeddings[i + stride].1));
            }
        }
        far.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if !far.is_empty() {
            println!(
                "far-apart similarity (~30s apart, mixed):\n  min {:.3}  p05 {:.3}  p25 {:.3}  median {:.3}  p75 {:.3}  max {:.3}",
                far[0], pct(&far, 0.05), pct(&far, 0.25), pct(&far, 0.5), pct(&far, 0.75), far[far.len() - 1]
            );
        }

        // A separable threshold has to sit above most far-apart pairs and
        // below most adjacent ones. If those overlap completely, no single
        // global threshold works and the clustering needs a different shape.
        println!("\nhistogram of all adjacent similarities:");
        for bucket in 0..20 {
            let (lo, hi) = (bucket as f32 * 0.05, (bucket + 1) as f32 * 0.05);
            let n = neighbour.iter().filter(|s| **s >= lo && **s < hi).count();
            if n > 0 {
                println!("  {lo:.2}..{hi:.2}  {:<5} {}", n, "#".repeat(n * 60 / neighbour.len().max(1)));
            }
        }
        // Does constraining the count produce something that looks like two
        // people taking turns, or just noise? A real handoff gives long
        // contiguous runs; an arbitrary split flickers window to window.
        let vecs: Vec<Vec<f32>> = embeddings.iter().map(|(_, e)| e.clone()).collect();
        let wins: Vec<(u32, u32)> = embeddings.iter().map(|&(s, _)| (s, s + WINDOW_MS)).collect();
        for k in [None, Some(2usize), Some(3)] {
            let labels = cluster(&vecs, &wins, k);
            let mut ids = labels.clone();
            ids.sort_unstable();
            ids.dedup();
            let switches = labels.windows(2).filter(|p| p[0] != p[1]).count();
            let runs: Vec<usize> = labels.chunk_by(|a, b| a == b).map(|c| c.len()).collect();
            let longest = runs.iter().copied().max().unwrap_or(0);
            let median_run = {
                let mut r = runs.clone();
                r.sort_unstable();
                r.get(r.len() / 2).copied().unwrap_or(0)
            };
            println!(
                "\ntarget {:?}: {} cluster(s), {} switch(es), {} run(s), median run {} window(s) ({:.1}s), longest {} ({:.1}s)",
                k,
                ids.len(),
                switches,
                runs.len(),
                median_run,
                median_run as f64 * HOP_MS as f64 / 1000.0,
                longest,
                longest as f64 * HOP_MS as f64 / 1000.0
            );
            for id in &ids {
                let n = labels.iter().filter(|l| *l == id).count();
                println!("  speaker {id}: {n} window(s) ({:.0}%)", n as f64 / labels.len() as f64 * 100.0);
            }
        }
        assert!(!embeddings.is_empty());
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
