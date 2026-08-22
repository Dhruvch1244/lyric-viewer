//! Silero voice-activity detection, and the windowing that turns its output
//! into work for Whisper.
//!
//! Two reasons this runs at all, and only the first is speed:
//!
//! 1. **Cost.** Whisper is the expensive part. Skipping the intro, the outro
//!    and every instrumental bar means the model sees the fraction of a song
//!    that actually has a voice in it.
//! 2. **Hallucination.** This matters more. Given 30 s of instrumental,
//!    Whisper does not return nothing — it invents plausible lyrics, confidently
//!    and with timestamps. There is no confidence score that reliably catches
//!    it. Not asking it in the first place is the fix.
//!
//! The file is deliberately split so the part that can be wrong quietly is the
//! part that is tested:
//!
//! - [`SpeechGate`] turns a stream of per-window probabilities into spans. This
//!   is the hysteresis state machine from Silero's own `get_speech_timestamps`,
//!   it is where off-by-one and boundary bugs live, and it is pure — so it is
//!   unit-tested against hand-built probability streams with known answers.
//! - [`plan_windows`] batches those spans into ≤30 s Whisper inputs. Also pure,
//!   also tested.
//! - [`SileroVad`] is the ONNX wrapper. It is the part that needs a model file,
//!   and it is kept as thin as possible for exactly that reason.
//!
//! # It is a SPEECH detector, and that is a real limit on what this app can do
//!
//! Measured 2026-08-22 with `dump_vad_probabilities`, three tracks, one
//! probability per 512 samples:
//!
//! ```text
//!                              p50     max    @0.50   @0.05
//! rap vocals (Seedhe Maut)    0.967   1.000     79%     81%
//! sung hook over EDM          0.000   0.472      0%      3%
//! instrumental (deadmau5)     0.000   0.314      0%      0%
//! ```
//!
//! Silero is bimodal and extremely sure of itself. Rap reads as speech and
//! works beautifully. **Sung vocals over dense electronic production read as
//! nothing at all** — on a 180s track with an audible hook, the probability
//! is ≥0.001 only in the first 20 seconds and flat zero across every bar the
//! vocal actually occupies.
//!
//! Two consequences worth knowing before touching this:
//!
//! 1. **Lowering the trigger does not work.** It was the obvious fix and the
//!    sweep above rules it out: at 0.05 the sung track yields 3% of itself,
//!    which is useless for transcription, and by then the floor is close
//!    enough to the instrumental track's noise to start inventing spans in
//!    silence. [`SpeechGate::with_threshold`] exists because that sweep
//!    needed it, not because a lower number is a fix.
//! 2. **"No spans" cannot be read as "no vocals."** A sung track (max 0.472)
//!    and a genuinely instrumental one (max 0.314) are not separable here, so
//!    falling back to transcribing the whole clip when the VAD finds nothing
//!    would hand Whisper 413 seconds of deadmau5 and get confident invented
//!    lyrics back — the exact failure reason 2 above exists to prevent.
//!
//! # Separating the vocal first fixes it completely — measured, not assumed
//!
//! Same EDM track, same detector, the only difference being Demucs
//! (`htdemucs_ft_vocals`, the model `demucs.js` already names) run over a
//! 120s excerpt first:
//!
//! ```text
//!                    p50     max    voiced @0.50
//!   mix             0.000   0.472        0%
//!   isolated vocal  0.759   1.000       72%
//! ```
//!
//! Elevated across all twelve 10-second buckets, not just the intro — so this
//! is the whole track becoming transcribable, not a fragment. On the rap track
//! isolation takes an already-good p50 0.967 to 1.000 (3614 of 3750 windows
//! over the trigger), so it does not cost anything where the VAD already
//! worked.
//!
//! That makes **Demucs ahead of the VAD the real fix**, and no longer a guess.
//! The obstacle is placement, not doubt: Demucs lives in the WebView
//! (`demucs.js`) and the sidecar cannot reach it, so this needs the model
//! ported to `ort` here. Cost measured on this machine: 165 MB model, ~0.6x
//! realtime on CPU (69s for 120s of audio), which is affordable for a
//! background job that already runs a Whisper decode.
//!
//! (That run also verified `demucs.js`'s own contract end to end for the first
//! time — its header still says "not yet run against the live model". Silero
//! would not score 0.759 on noise, so the segmentation, overlap-add and stem
//! indexing in that file are right.)
//!
//! Until the port exists, the honest move is to say what happened and name the
//! remedy, which is what `main.rs` does rather than claiming the audio has no
//! speech in it.

use std::path::Path;

use inference_protocol::Span;

/// Samples per VAD window. Silero v5 is trained on exactly this at 16 kHz and
/// will happily produce garbage for any other size rather than refusing.
pub const WINDOW_SAMPLES: usize = 512;

/// Speech starts when the probability rises above this.
const THRESHOLD: f32 = 0.5;
/// ...and does not end until it falls below this. The gap is hysteresis: a
/// single threshold makes a voice flicker in and out around 0.5 and shatters
/// one sung line into a dozen spans.
const NEG_THRESHOLD: f32 = 0.35;
/// Spans shorter than this are dropped as noise rather than kept as words.
const MIN_SPEECH_MS: u32 = 250;
/// Silence shorter than this does not end a span — it is a breath, not a gap.
const MIN_SILENCE_MS: u32 = 100;
/// Widen every span by this, because a detector tuned to find the voice
/// necessarily clips the quiet edges of it, and a clipped consonant is a
/// mis-transcribed word.
const SPEECH_PAD_MS: u32 = 30;

/// Whisper's context window. Everything is batched to this because the model's
/// input shape is fixed: a 2-second span and a 30-second span cost the model
/// exactly the same, so sending spans one at a time would be slower than
/// sending no VAD output at all.
const WINDOW_MS: u32 = 30_000;

const SAMPLE_RATE: u32 = 16_000;

fn ms_to_samples(ms: u32) -> usize {
    (ms as usize * SAMPLE_RATE as usize) / 1000
}

fn samples_to_ms(samples: usize) -> u32 {
    ((samples as u64 * 1000) / SAMPLE_RATE as u64) as u32
}

/// The hysteresis state machine from Silero's `get_speech_timestamps`.
///
/// Fed one probability per [`WINDOW_SAMPLES`] of audio, in order, it emits
/// closed speech spans. Kept as an explicit struct rather than a loop over a
/// probability vector so a streaming caller — which is what the ONNX pass below
/// is — never has to hold every probability in memory to find the first span.
#[derive(Debug)]
pub struct SpeechGate {
    total_samples: usize,
    min_speech: usize,
    min_silence: usize,
    threshold: f32,
    neg_threshold: f32,
    triggered: bool,
    current_start: usize,
    /// Where the current run of sub-threshold windows began, or 0 for none.
    /// Silence has to persist for `min_silence` before it closes a span, and
    /// when it does the span ends *here*, not where the silence was confirmed.
    tentative_end: usize,
    spans: Vec<Span>,
}

impl SpeechGate {
    pub fn new(total_samples: usize) -> Self {
        Self::with_threshold(total_samples, THRESHOLD)
    }

    /// A gate at a chosen trigger, with the hysteresis gap kept in proportion
    /// to the default pair. Exists because Silero's 0.5 is a *speech* trigger
    /// and sung vocals over a dense mix never reach it — see
    /// `music_threshold` and `SileroVad::spans`.
    pub fn with_threshold(total_samples: usize, threshold: f32) -> Self {
        Self {
            total_samples,
            min_speech: ms_to_samples(MIN_SPEECH_MS),
            min_silence: ms_to_samples(MIN_SILENCE_MS),
            threshold,
            neg_threshold: threshold * (NEG_THRESHOLD / THRESHOLD),
            triggered: false,
            current_start: 0,
            tentative_end: 0,
            spans: Vec::new(),
        }
    }

    /// Feed the probability for the window starting at `sample`.
    pub fn push(&mut self, sample: usize, probability: f32) {
        if probability >= self.threshold {
            // Speech resumed before the silence lasted long enough to count,
            // so the span never ended.
            self.tentative_end = 0;
            if !self.triggered {
                self.triggered = true;
                self.current_start = sample;
            }
            return;
        }

        if probability >= self.neg_threshold || !self.triggered {
            // Between the two thresholds: neither confirms speech nor ends it.
            return;
        }

        if self.tentative_end == 0 {
            self.tentative_end = sample;
        }
        if sample - self.tentative_end < self.min_silence {
            return;
        }
        self.close(self.tentative_end);
    }

    /// Close the stream and take the spans, padded and de-overlapped.
    pub fn finish(mut self) -> Vec<Span> {
        if self.triggered && self.total_samples.saturating_sub(self.current_start) > self.min_speech {
            let end = self.total_samples;
            self.spans.push(Span { start_ms: samples_to_ms(self.current_start), end_ms: samples_to_ms(end) });
        }
        pad_spans(self.spans, samples_to_ms(self.total_samples))
    }

    fn close(&mut self, end: usize) {
        if end.saturating_sub(self.current_start) > self.min_speech {
            self.spans.push(Span { start_ms: samples_to_ms(self.current_start), end_ms: samples_to_ms(end) });
        }
        self.triggered = false;
        self.current_start = 0;
        self.tentative_end = 0;
    }
}

/// Widen each span by [`SPEECH_PAD_MS`], splitting the difference where two
/// spans would otherwise be pushed into each other.
///
/// Splitting rather than clamping matters: two lines 40 ms apart would both
/// want 30 ms of padding, and letting them overlap would make the same audio
/// appear in two Whisper inputs and be transcribed twice.
fn pad_spans(spans: Vec<Span>, total_ms: u32) -> Vec<Span> {
    let pad = SPEECH_PAD_MS;
    let n = spans.len();
    let mut out: Vec<Span> = Vec::with_capacity(n);
    for (i, span) in spans.iter().enumerate() {
        let mut start = span.start_ms.saturating_sub(pad);
        let mut end = (span.end_ms + pad).min(total_ms);

        if i > 0 {
            let previous_end = out[i - 1].end_ms;
            if start < previous_end {
                let midpoint = (previous_end + span.start_ms) / 2;
                out[i - 1].end_ms = midpoint;
                start = midpoint;
            }
        }
        if i + 1 < n {
            let gap = spans[i + 1].start_ms.saturating_sub(span.end_ms);
            if gap < 2 * pad {
                end = span.end_ms + gap / 2;
            }
        }
        out.push(Span { start_ms: start, end_ms: end.max(start) });
    }
    out
}

/// Batch spans into Whisper-sized windows.
///
/// Whisper's input is a fixed 30 s regardless of how much of it is audio, so a
/// 2 s span and a 30 s window cost the model the same. Transcribing spans
/// individually would therefore be *slower* than not running the VAD at all —
/// this is where the saving actually comes from.
///
/// Returns windows in order, each at most 30 s, together covering every span.
/// A span longer than 30 s is split; the split is at a fixed boundary rather
/// than at a quiet point, which is a real limitation — a word straddling it can
/// be cut in half. Whisper's own long-form path has the same property.
pub fn plan_windows(spans: &[Span]) -> Vec<Span> {
    let mut windows: Vec<Span> = Vec::new();
    for span in spans {
        // Extend the open window if this span still fits inside 30 s of it.
        if let Some(open) = windows.last_mut() {
            if span.end_ms <= open.start_ms + WINDOW_MS {
                open.end_ms = span.end_ms;
                continue;
            }
            // Partially fits: take what fits, then continue below from there.
            if span.start_ms < open.start_ms + WINDOW_MS {
                open.end_ms = open.start_ms + WINDOW_MS;
            }
        }
        let mut start = windows.last().map(|w| w.end_ms.max(span.start_ms)).unwrap_or(span.start_ms);
        if start >= span.end_ms {
            continue;
        }
        while start < span.end_ms {
            let end = (start + WINDOW_MS).min(span.end_ms);
            windows.push(Span { start_ms: start, end_ms: end });
            start = end;
        }
    }
    windows
}

/// Total voiced milliseconds, for the log line that says how much work the VAD
/// actually saved.
pub fn total_ms(spans: &[Span]) -> u32 {
    spans.iter().map(|s| s.duration_ms()).sum()
}

/// The ONNX half: load Silero and score the audio window by window.
pub struct SileroVad {
    session: ort::session::Session,
    /// Silero is recurrent. This is its hidden state, carried between windows —
    /// dropping it would make every 32 ms window a cold start and the detector
    /// useless.
    state: Vec<f32>,
    /// Whether the model declares `sr` as a scalar or a 1-element tensor. The
    /// published checkpoints differ, and ONNX Runtime rejects the wrong rank
    /// rather than broadcasting, so it is read from the graph instead of
    /// guessed.
    sr_shape: Vec<i64>,
    /// The last [`CONTEXT_SAMPLES`] samples of the previous window, prepended
    /// to the next one. See `probability` for why this exists — it is not
    /// optional smoothing, the model is silently wrong without it.
    context: Vec<f32>,
}

/// Silero v5's recurrent state, flattened. Its shape is `[2, batch, 128]` and
/// batch is always 1 here, so this is `2 * 128`.
const STATE_LEN: usize = 2 * 128;

/// Samples of trailing context Silero v5 expects prepended to every window,
/// making its real input 576 samples, not 512.
///
/// This is undocumented in the graph itself — the ONNX input is shaped
/// `[-1, -1]`, so nothing rejects a bare 512-sample call, it just scores
/// everything near zero. Measured directly: probed against real speech, a
/// context-less 512-sample window produced a maximum probability of 0.12
/// across an entire clip of clear speech (every window silently below the 0.5
/// threshold); prepending 64 samples of context raised the same clip's peaks
/// to 1.0. The number itself comes from the reference Python wrapper
/// (`silero_vad.utils_vad.VADIterator`), which keeps exactly this much of the
/// previous chunk.
const CONTEXT_SAMPLES: usize = 64;

impl SileroVad {
    /// The model file this expects inside the model directory.
    pub const FILE: &'static str = "silero_vad.onnx";

    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let path = model_dir.join(Self::FILE);
        if !path.is_file() {
            return Err(format!("Silero VAD model not found at {}", path.display()));
        }
        let session = ort::session::Session::builder()
            .map_err(|e| format!("cannot create an ONNX session builder: {e}"))?
            // One thread. The model is 2.3 MB and runs in well under a
            // millisecond per window; a thread pool would cost more to
            // coordinate than the work it would spread, and the sidecar is
            // already deprioritised so that it never competes with the UI.
            .with_intra_threads(1)
            .map_err(|e| format!("cannot configure the VAD session: {e}"))?
            .commit_from_file(&path)
            .map_err(|e| format!("cannot load {}: {e}", path.display()))?;

        let sr_shape = declared_shape(&session, "sr").unwrap_or_default();

        Ok(Self { session, state: vec![0.0; STATE_LEN], sr_shape, context: vec![0.0; CONTEXT_SAMPLES] })
    }

    /// Score one 512-sample window, returning the probability that it contains
    /// speech.
    ///
    /// Windows must be fed in order — the model's own recurrent state carries
    /// across calls, and so does the trailing-context buffer this method
    /// maintains internally. Calling it out of order, or skipping a window,
    /// silently produces wrong probabilities rather than an error, because
    /// nothing about the ONNX signature can catch that.
    pub fn probability(&mut self, window: &[f32]) -> Result<f32, String> {
        // Zero-pad a short final window: the missing audio is genuinely
        // absent, not silent-by-accident. Padding happens before the context
        // is prepended, so the model always sees CONTEXT_SAMPLES + 512.
        let mut padded_window;
        let window_full = if window.len() == WINDOW_SAMPLES {
            window
        } else {
            padded_window = vec![0.0f32; WINDOW_SAMPLES];
            padded_window[..window.len()].copy_from_slice(window);
            &padded_window
        };

        let mut input = Vec::with_capacity(CONTEXT_SAMPLES + WINDOW_SAMPLES);
        input.extend_from_slice(&self.context);
        input.extend_from_slice(window_full);

        // Next call's context is this window's OWN last samples, taken before
        // padding — real trailing audio, not zeros invented to fill a short
        // final window.
        let real_len = window.len().min(WINDOW_SAMPLES);
        let take = real_len.min(CONTEXT_SAMPLES);
        self.context[CONTEXT_SAMPLES - take..].copy_from_slice(&window[real_len - take..real_len]);
        if take < CONTEXT_SAMPLES {
            self.context[..CONTEXT_SAMPLES - take].fill(0.0);
        }

        let audio = ort::value::Tensor::from_array(([1usize, input.len()], input))
            .map_err(|e| format!("cannot build the VAD input tensor: {e}"))?;
        let state = ort::value::Tensor::from_array(([2usize, 1, 128], self.state.clone()))
            .map_err(|e| format!("cannot build the VAD state tensor: {e}"))?;
        let sr_dims: Vec<usize> = self.sr_shape.iter().map(|d| (*d).max(1) as usize).collect();
        let sr = ort::value::Tensor::from_array((sr_dims, vec![SAMPLE_RATE as i64]))
            .map_err(|e| format!("cannot build the VAD sample-rate tensor: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs!["input" => audio, "state" => state, "sr" => sr])
            .map_err(|e| format!("VAD inference failed: {e}"))?;

        // Carry the new state forward before reading the probability, so an
        // error reading the output cannot leave the state half-updated.
        let (_, next) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("VAD returned no usable state: {e}"))?;
        if next.len() == STATE_LEN {
            self.state.copy_from_slice(next);
        }

        let (_, out) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("VAD returned no usable output: {e}"))?;
        out.first().copied().ok_or_else(|| "VAD returned an empty probability".to_string())
    }

    /// Run the detector over a whole clip and return its speech spans.
    ///
    /// `on_progress` is called with a 0..100 percentage; `cancelled` is checked
    /// per window, which is a fine enough grain that a cancel during the VAD
    /// pass is effectively immediate.
    pub fn spans(
        &mut self,
        samples: &[f32],
        mut on_progress: impl FnMut(u8),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<Span>, String> {
        let mut gate = SpeechGate::new(samples.len());
        let windows = samples.len().div_ceil(WINDOW_SAMPLES);
        let mut last_pct = u8::MAX;

        for (i, chunk) in samples.chunks(WINDOW_SAMPLES).enumerate() {
            if cancelled() {
                return Err("cancelled".into());
            }
            let p = self.probability(chunk)?;
            gate.push(i * WINDOW_SAMPLES, p);

            let pct = ((i + 1) * 100 / windows.max(1)) as u8;
            if pct != last_pct {
                last_pct = pct;
                on_progress(pct);
            }
        }
        Ok(gate.finish())
    }
}

/// The declared shape of a named input, or `None` if the model has no such
/// input.
fn declared_shape(session: &ort::session::Session, name: &str) -> Option<Vec<i64>> {
    session.inputs().iter().find(|i| i.name() == name).and_then(|i| match i.dtype() {
        ort::value::ValueType::Tensor { shape, .. } => Some(shape.to_vec()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
      Windows per second of audio, so tests can talk in seconds.

      The detector's resolution is one 512-sample window — 32 ms — and 16 000
      does not divide by 512, so "one second" here is 31 windows = 992 ms.
      Boundaries in these tests are therefore approximate by up to ~1% plus the
      30 ms padding, and the assertions are written with that slack rather than
      against exact second marks.
    */
    const PER_SECOND: usize = SAMPLE_RATE as usize / WINDOW_SAMPLES; // 31.25 -> 31

    /// Drive the gate with a probability per window, `secs` seconds long.
    fn run(pattern: &[(f32, f32)]) -> Vec<Span> {
        // (probability, seconds) pairs.
        let total_windows: usize = pattern.iter().map(|(_, s)| (s * PER_SECOND as f32) as usize).sum();
        let mut gate = SpeechGate::new(total_windows * WINDOW_SAMPLES);
        let mut i = 0usize;
        for &(p, secs) in pattern {
            for _ in 0..(secs * PER_SECOND as f32) as usize {
                gate.push(i * WINDOW_SAMPLES, p);
                i += 1;
            }
        }
        gate.finish()
    }

    #[test]
    fn a_clip_with_no_speech_produces_no_spans() {
        // The case that matters most: 30 s of instrumental must produce
        // nothing to transcribe, because Whisper would invent words for it.
        assert!(run(&[(0.02, 30.0)]).is_empty());
    }

    #[test]
    fn one_run_of_speech_becomes_one_span() {
        let spans = run(&[(0.05, 2.0), (0.95, 4.0), (0.05, 2.0)]);
        assert_eq!(spans.len(), 1, "got {spans:?}");
        // Speech runs from window 62 to window 186, i.e. 1984 ms to 5952 ms,
        // then padding widens it by 30 ms either side.
        assert_eq!(spans[0].start_ms, 1954, "got {spans:?}");
        assert_eq!(spans[0].end_ms, 5982, "got {spans:?}");
    }

    #[test]
    fn a_breath_does_not_split_a_line_but_a_real_gap_does() {
        // 60 ms below threshold is a breath (under MIN_SILENCE_MS)...
        let one = run(&[(0.9, 2.0), (0.1, 0.06), (0.9, 2.0)]);
        assert_eq!(one.len(), 1, "a breath split the line: {one:?}");

        // ...2 seconds is a gap between lines.
        let two = run(&[(0.9, 2.0), (0.1, 2.0), (0.9, 2.0)]);
        assert_eq!(two.len(), 2, "a real gap did not split the line: {two:?}");
    }

    #[test]
    fn hysteresis_keeps_a_wavering_probability_as_one_span() {
        // Between the two thresholds the gate must hold its state. Without the
        // dead band this alternation produces a span per window.
        let mut gate = SpeechGate::new(PER_SECOND * 4 * WINDOW_SAMPLES);
        for i in 0..PER_SECOND * 4 {
            gate.push(i * WINDOW_SAMPLES, if i % 2 == 0 { 0.55 } else { 0.40 });
        }
        assert_eq!(gate.finish().len(), 1);
    }

    #[test]
    fn a_custom_trigger_keeps_its_hysteresis_gap() {
        // with_threshold scales the release threshold with the trigger rather
        // than leaving it at the default 0.35 — at a trigger of 0.2 a fixed
        // 0.35 release would sit ABOVE the trigger and close every span the
        // instant it opened.
        let mut gate = SpeechGate::with_threshold(PER_SECOND * 4 * WINDOW_SAMPLES, 0.20);
        for i in 0..PER_SECOND * 4 {
            // Wavering either side of the trigger but never near zero.
            gate.push(i * WINDOW_SAMPLES, if i % 2 == 0 { 0.25 } else { 0.16 });
        }
        assert_eq!(gate.finish().len(), 1, "a lowered trigger must still hold one span together");
    }

    #[test]
    fn the_default_gate_matches_an_explicit_default_trigger() {
        let build = |gate: &mut SpeechGate| {
            for i in 0..PER_SECOND * 3 {
                gate.push(i * WINDOW_SAMPLES, 0.9);
            }
        };
        let mut a = SpeechGate::new(PER_SECOND * 3 * WINDOW_SAMPLES);
        let mut b = SpeechGate::with_threshold(PER_SECOND * 3 * WINDOW_SAMPLES, THRESHOLD);
        build(&mut a);
        build(&mut b);
        assert_eq!(a.finish(), b.finish(), "new() must stay a pure alias for the default trigger");
    }

    #[test]
    fn a_stab_of_noise_shorter_than_the_minimum_is_dropped() {
        // 100 ms of something voice-like in the middle of an instrumental is
        // not a lyric; it is a synth line that happens to be formant-shaped.
        assert!(run(&[(0.05, 5.0), (0.99, 0.1), (0.05, 5.0)]).is_empty());
    }

    #[test]
    fn speech_still_running_at_the_end_of_the_clip_is_closed_rather_than_lost() {
        let spans = run(&[(0.05, 1.0), (0.95, 5.0)]);
        assert_eq!(spans.len(), 1, "got {spans:?}");
        assert!(spans[0].end_ms >= 5900, "the final span was truncated: {spans:?}");
    }

    #[test]
    fn a_span_ends_where_the_silence_began_not_where_it_was_confirmed() {
        // The span must close at the last voiced window, not MIN_SILENCE_MS
        // later — otherwise every line carries a tail of silence into Whisper.
        let spans = run(&[(0.9, 3.0), (0.05, 3.0)]);
        assert_eq!(spans.len(), 1);
        assert!(
            spans[0].end_ms < 3200,
            "span ran {} ms past the end of the speech",
            spans[0].end_ms.saturating_sub(3000)
        );
    }

    #[test]
    fn padded_spans_never_overlap() {
        // Two lines close together both want padding; overlapping them would
        // feed the same audio to Whisper twice and transcribe it twice.
        let spans = run(&[(0.9, 1.0), (0.05, 0.15), (0.9, 1.0), (0.05, 0.15), (0.9, 1.0)]);
        for pair in spans.windows(2) {
            assert!(pair[0].end_ms <= pair[1].start_ms, "spans overlap: {pair:?}");
        }
    }

    #[test]
    fn spans_are_ordered_and_non_empty() {
        let spans = run(&[(0.9, 1.0), (0.05, 1.0), (0.9, 1.0), (0.05, 1.0), (0.9, 1.0)]);
        assert!(!spans.is_empty());
        for s in &spans {
            assert!(s.end_ms > s.start_ms, "empty span {s:?}");
        }
        for pair in spans.windows(2) {
            assert!(pair[1].start_ms >= pair[0].start_ms, "spans out of order: {pair:?}");
        }
    }

    #[test]
    fn nearby_spans_are_batched_into_one_whisper_window() {
        // Four short lines inside 30 s must become ONE model run, not four:
        // Whisper's input is a fixed 30 s whether it is full or not.
        let spans = vec![
            Span { start_ms: 1_000, end_ms: 3_000 },
            Span { start_ms: 8_000, end_ms: 10_000 },
            Span { start_ms: 17_000, end_ms: 19_000 },
            Span { start_ms: 25_000, end_ms: 28_000 },
        ];
        let windows = plan_windows(&spans);
        assert_eq!(windows.len(), 1, "got {windows:?}");
        assert_eq!(windows[0].start_ms, 1_000);
        assert_eq!(windows[0].end_ms, 28_000);
    }

    #[test]
    fn a_span_beyond_thirty_seconds_starts_a_new_window() {
        let spans = vec![
            Span { start_ms: 0, end_ms: 5_000 },
            Span { start_ms: 40_000, end_ms: 45_000 },
        ];
        let windows = plan_windows(&spans);
        assert_eq!(windows.len(), 2, "got {windows:?}");
        assert!(windows[1].start_ms >= 40_000);
    }

    #[test]
    fn every_window_fits_the_models_input() {
        // A long unbroken verse still has to be split, or the mel front end
        // silently truncates it.
        let spans = vec![Span { start_ms: 0, end_ms: 95_000 }];
        let windows = plan_windows(&spans);
        assert!(windows.len() >= 4, "got {windows:?}");
        for w in &windows {
            assert!(w.duration_ms() <= WINDOW_MS, "window longer than the model's input: {w:?}");
        }
    }

    #[test]
    fn windowing_covers_every_span_and_invents_nothing_before_the_first() {
        let spans = vec![
            Span { start_ms: 12_000, end_ms: 14_000 },
            Span { start_ms: 60_000, end_ms: 95_000 },
        ];
        let windows = plan_windows(&spans);
        assert_eq!(windows[0].start_ms, 12_000, "windows must not start before the first span");
        for span in &spans {
            let covered = windows.iter().any(|w| w.start_ms <= span.start_ms && w.end_ms >= span.start_ms);
            assert!(covered, "{span:?} is not covered by {windows:?}");
        }
        for pair in windows.windows(2) {
            assert!(pair[1].start_ms >= pair[0].end_ms, "windows overlap: {pair:?}");
        }
    }

    #[test]
    fn windowing_nothing_produces_nothing() {
        assert!(plan_windows(&[]).is_empty());
    }

    #[test]
    fn voiced_time_is_summed_not_spanned() {
        // The log line reports how much work the VAD saved; measuring
        // first-to-last instead of the sum would report a saving of zero on
        // any song whose first and last lines are far apart.
        let spans = vec![
            Span { start_ms: 0, end_ms: 2_000 },
            Span { start_ms: 200_000, end_ms: 203_000 },
        ];
        assert_eq!(total_ms(&spans), 5_000);
    }

    /// Diagnostic, not a test. Dumps the raw probability distribution, a
    /// coarse time series, and what a range of triggers would yield.
    ///
    /// The question it exists to answer: when Silero reports no speech in a
    /// track that audibly has vocals, is the signal *there but under the
    /// trigger*, or absent? Those want completely different fixes and the
    /// span list cannot tell them apart.
    ///
    /// ```text
    /// LYRIC_TEST_PCM=... LYRIC_TEST_MODELS=... \
    ///   cargo test --release -p lyric-inference --bin lyric-inference \
    ///   -- --ignored dump_vad --nocapture
    /// ```
    #[test]
    #[ignore = "diagnostic; needs the VAD model and a PCM fixture"]
    fn dump_vad_probabilities() {
        let pcm_path = std::env::var("LYRIC_TEST_PCM").expect("set LYRIC_TEST_PCM");
        let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS");

        let bytes = std::fs::read(&pcm_path).expect("cannot read PCM");
        let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let total_ms_all = samples_to_ms(samples.len());
        let name = pcm_path.rsplit(['\\', '/']).next().unwrap_or(pcm_path.as_str()).to_string();
        println!("\n=== {name} ({:.1}s) ===", total_ms_all as f64 / 1000.0);

        let mut vad = SileroVad::load(Path::new(&model_dir)).expect("cannot load VAD");
        let mut probs: Vec<(usize, f32)> = Vec::new();
        let mut at = 0usize;
        while at + WINDOW_SAMPLES <= samples.len() {
            probs.push((at, vad.probability(&samples[at..at + WINDOW_SAMPLES]).expect("vad failed")));
            at += WINDOW_SAMPLES;
        }

        let mut sorted: Vec<f32> = probs.iter().map(|(_, p)| *p).collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |f: f64| sorted[((sorted.len() - 1) as f64 * f) as usize];
        println!(
            "probability: p50 {:.3}  p75 {:.3}  p90 {:.3}  p95 {:.3}  p99 {:.3}  max {:.3}",
            q(0.5), q(0.75), q(0.90), q(0.95), q(0.99), sorted[sorted.len() - 1]
        );

        // Ten-second buckets, so a hook that the detector half-sees shows up
        // as structure rather than being flattened into a percentile.
        println!("peak probability per 10s bucket:");
        let bucket = ms_to_samples(10_000);
        let buckets = (samples.len() / bucket) + 1;
        for b in 0..buckets {
            let (lo, hi) = (b * bucket, (b + 1) * bucket);
            let peak = probs.iter().filter(|(s, _)| *s >= lo && *s < hi).map(|(_, p)| *p).fold(0.0f32, f32::max);
            if peak > 0.0 {
                println!("  {:>4}s  {:.3} {}", b * 10, peak, "#".repeat((peak * 40.0) as usize));
            }
        }

        println!("what each trigger would yield:");
        for t in [0.50f32, 0.35, 0.25, 0.15, 0.10, 0.05] {
            let mut gate = SpeechGate::with_threshold(samples.len(), t);
            for (s, p) in &probs {
                gate.push(*s, *p);
            }
            let spans = gate.finish();
            let voiced = total_ms(&spans);
            println!(
                "  trigger {t:.2}: {:>3} span(s), {:>6}ms voiced ({:>3}% of track)",
                spans.len(),
                voiced,
                voiced * 100 / total_ms_all.max(1)
            );
        }
    }
}
