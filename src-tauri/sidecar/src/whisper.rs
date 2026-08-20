//! Whisper: encoder, autoregressive decoder, and the assembly of tokens into
//! timed words.
//!
//! Three ONNX artefacts, all from the model directory:
//!
//! - `encoder_model_quantized.onnx` — 80×3000 log-mel in, 1500×512 audio
//!   embedding out. Runs once per 30 s window.
//! - `decoder_model_merged_quantized.onnx` — one token at a time, with a KV
//!   cache. "Merged" means the with-cache and without-cache graphs share one
//!   file, selected by the `use_cache_branch` input.
//! - `tokenizer.json` — the BPE vocabulary, including the special tokens that
//!   steer the decode.
//!
//! **The export must be the `_timestamped` one.** Word timing comes from the
//! decoder's cross-attention weights, and the ordinary export declares no such
//! outputs. That is not a theoretical concern: the WebView path this replaces
//! was pointed at the ordinary export, and every transcription it attempted
//! failed outright. `load` therefore checks for the outputs up front and says
//! so plainly, rather than failing per-window later.
//!
//! ## Decoding
//!
//! Greedy, not beam search. Beam search buys a small accuracy gain for several
//! times the compute, and everything here is downstream of `align.rs`, which
//! matches the transcription against the *real* lyrics anyway — a better guess
//! at a word that is about to be replaced by the correct one is not worth 4×
//! the runtime.
//!
//! The prompt is `<|startoftranscript|> <|lang|> <|transcribe|>
//! <|notimestamps|>`. Timestamp tokens are suppressed deliberately: they give
//! coarse segment times, and this path gets finer times from DTW instead.
//! Asking for both makes the model spend tokens on timestamps that are then
//! thrown away.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use inference_protocol::{Cue, Word};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;

use crate::dtw;
use crate::mel;

/// Encoder output frames for one 30 s window. Half of `mel::N_FRAMES` — the
/// encoder's first convolution has stride 2.
const ENCODER_FRAMES: usize = 1500;
/// Decoder layers in whisper-base. Read from the graph, not assumed; this is
/// only the expected value used to size the initial cache.
const HEAD_DIM: usize = 64;

/// Hard ceiling on generated tokens, from `max_target_positions`. Whisper's
/// failure mode on music is repetition, and without a ceiling a decode over an
/// instrumental bar runs until the heat death of the job.
const MAX_TOKENS: usize = 440;

/// A silence at least this long between words starts a new line.
const LINE_GAP_MS: u32 = 700;
/// Guards a legato passage with no pauses from becoming one giant line.
const MAX_WORDS_PER_LINE: usize = 14;

/// The special tokens that steer a decode, resolved from the tokenizer rather
/// than hardcoded — the ids differ between multilingual and English-only
/// checkpoints, and a wrong one produces fluent nonsense rather than an error.
struct SpecialTokens {
    start_of_transcript: u32,
    transcribe: u32,
    no_timestamps: u32,
    end_of_text: u32,
    /// The first `<|xx|>` language token. Language ids are contiguous from
    /// here, which is what makes detection a bounded argmax.
    first_language: u32,
    last_language: u32,
}

/// A loaded Whisper.
pub struct Whisper {
    encoder: Session,
    decoder: Session,
    tokenizer: tokenizers::Tokenizer,
    special: SpecialTokens,
    /// `(layer, head)` pairs whose cross-attention actually tracks alignment,
    /// from the model's own `generation_config.json`. Averaging every head
    /// instead would be averaging in noise.
    alignment_heads: Vec<(usize, usize)>,
    layers: usize,
    heads: usize,
}

impl Whisper {
    pub const ENCODER_FILE: &'static str = "encoder_model_quantized.onnx";
    pub const DECODER_FILE: &'static str = "decoder_model_merged_quantized.onnx";
    pub const TOKENIZER_FILE: &'static str = "tokenizer.json";
    pub const GENERATION_CONFIG_FILE: &'static str = "generation_config.json";

    pub fn load(model_dir: &Path, threads: usize) -> Result<Self, String> {
        let encoder = session(&model_dir.join(Self::ENCODER_FILE), threads)?;
        let decoder = session(&model_dir.join(Self::DECODER_FILE), threads)?;

        // Fail here, with a sentence that names the fix, rather than per
        // window with a missing-output error from deep inside the run.
        if !decoder.outputs().iter().any(|o| o.name().starts_with("cross_attentions.")) {
            return Err(format!(
                "{} has no cross-attention outputs, so word timing is impossible. \
                 The model directory needs the `_timestamped` export of this checkpoint \
                 (same weights, exported with output_attentions=True).",
                Self::DECODER_FILE
            ));
        }

        let layers = decoder.outputs().iter().filter(|o| o.name().starts_with("cross_attentions.")).count();
        let heads = decoder
            .outputs()
            .iter()
            .find(|o| o.name() == "cross_attentions.0")
            .and_then(|o| match o.dtype() {
                ort::value::ValueType::Tensor { shape, .. } => shape.get(1).map(|h| (*h).max(1) as usize),
                _ => None,
            })
            .ok_or("decoder does not declare a head count")?;

        let tokenizer_path = model_dir.join(Self::TOKENIZER_FILE);
        let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("cannot load {}: {e}", tokenizer_path.display()))?;

        let special = resolve_special_tokens(&tokenizer)?;
        let alignment_heads = read_alignment_heads(&model_dir.join(Self::GENERATION_CONFIG_FILE), layers, heads);

        Ok(Self { encoder, decoder, tokenizer, special, alignment_heads, layers, heads })
    }

    /// Transcribe one window of audio, already trimmed to at most 30 s.
    ///
    /// `offset_ms` is where this window starts in the original clip; every
    /// timestamp returned is shifted by it, so the caller gets song time rather
    /// than window time.
    pub fn transcribe_window(
        &mut self,
        front_end: &mut mel::MelSpectrogram,
        samples: &[f32],
        offset_ms: u32,
        language: Option<&str>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<Cue>, String> {
        let features = front_end.compute(samples);
        let audio = self.encode(&features)?;

        let language_token = match language {
            Some(code) => self.language_token(code)?,
            None => self.detect_language(&audio)?,
        };

        let decoded = self.decode(&audio, language_token, cancelled)?;
        if decoded.tokens.is_empty() {
            return Ok(Vec::new());
        }

        let frames = dtw::align(decoded.attention);
        let words = self.tokens_to_words(&decoded.tokens, &frames, offset_ms);
        Ok(group_into_lines(words))
    }

    /// Run the encoder over one window's log-mel features.
    fn encode(&mut self, features: &[f32]) -> Result<Vec<f32>, String> {
        let n_mels = features.len() / mel::N_FRAMES;
        let input = Tensor::from_array(([1usize, n_mels, mel::N_FRAMES], features.to_vec()))
            .map_err(|e| format!("cannot build the encoder input: {e}"))?;
        let outputs = self
            .encoder
            .run(ort::inputs!["input_features" => input])
            .map_err(|e| format!("encoder failed: {e}"))?;
        let (_, hidden) = outputs["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("encoder produced no usable output: {e}"))?;
        Ok(hidden.to_vec())
    }

    /// Which language is being sung.
    ///
    /// One decoder step from `<|startoftranscript|>` alone, taking the argmax
    /// over the language tokens only. Whisper's own method, and the restriction
    /// matters: an unrestricted argmax at that position picks a text token and
    /// the decode proceeds in no language at all.
    fn detect_language(&mut self, audio: &[f32]) -> Result<u32, String> {
        let mut cache = KvCache::empty(self.layers);
        let logits = self.decoder_step(audio, &[self.special.start_of_transcript], &mut cache, false, None)?;
        let last = &logits[logits.len() - self.vocab_size(&logits)..];

        let mut best = self.special.first_language;
        let mut best_score = f32::NEG_INFINITY;
        for id in self.special.first_language..=self.special.last_language {
            let score = last.get(id as usize).copied().unwrap_or(f32::NEG_INFINITY);
            if score > best_score {
                best_score = score;
                best = id;
            }
        }
        Ok(best)
    }

    fn vocab_size(&self, logits: &[f32]) -> usize {
        // The decoder returns [1, L, vocab]; every step here uses L = 1 except
        // the priming pass, so the vocabulary is the trailing dimension.
        let vocab = self.tokenizer.get_vocab_size(true).max(1);
        if logits.len() >= vocab { vocab } else { logits.len() }
    }

    fn language_token(&self, code: &str) -> Result<u32, String> {
        let token = format!("<|{}|>", code.to_ascii_lowercase());
        self.tokenizer
            .token_to_id(&token)
            .ok_or_else(|| format!("this checkpoint has no language token {token}"))
    }

    /// The greedy decode loop.
    fn decode(&mut self, audio: &[f32], language: u32, cancelled: &dyn Fn() -> bool) -> Result<Decoded, String> {
        let prompt = vec![
            self.special.start_of_transcript,
            language,
            self.special.transcribe,
            self.special.no_timestamps,
        ];

        let mut cache = KvCache::empty(self.layers);
        let mut tokens: Vec<u32> = Vec::new();
        let mut attention_rows: Vec<Vec<f32>> = vec![Vec::new(); self.alignment_heads.len()];
        let mut collector = AttentionCollector::new(&self.alignment_heads, self.heads);

        // Priming pass: the whole prompt at once, no cache to reuse yet. Its
        // attention is deliberately NOT merged into attention_rows — the
        // prompt's 4 tokens are not words, and `build_attention` reads
        // `rows[head]` as one ENCODER_FRAMES-sized block per entry of
        // `tokens`. Merging the priming rows in first would shift every real
        // token's attention forward by 4 slots, timing token *i* against
        // token *i - 4*'s actual attention. (Measured: this is exactly what
        // was happening before this comment existed — every word after the
        // second collapsed to the same frame, because the alignment was
        // reading someone else's row.) Leaving `collector`'s pending buffer
        // alone here is enough: the next `collect()` call clears it before
        // writing, so it is overwritten rather than needing an explicit reset.
        let mut logits = self.decoder_step(audio, &prompt, &mut cache, false, Some(&mut collector))?;

        for _ in 0..MAX_TOKENS {
            if cancelled() {
                return Err("cancelled".into());
            }
            // Only the LAST position's logits matter: the priming pass returns
            // one row per prompt token, and every step after it returns one.
            let vocab = self.vocab_size(&logits);
            let from = logits.len() - vocab;
            let last = &mut logits[from..];
            self.suppress_specials(last, tokens.is_empty());

            let next = argmax(last);
            if next == self.special.end_of_text {
                break;
            }
            tokens.push(next);

            if is_repeating(&tokens) {
                // Whisper's failure mode on music is a loop. Truncating back
                // to before the repetition keeps the good part of the line
                // rather than emitting "yeah yeah yeah yeah" forty times.
                tokens.truncate(tokens.len().saturating_sub(REPEAT_WINDOW));
                for rows in attention_rows.iter_mut() {
                    rows.truncate(tokens.len() * ENCODER_FRAMES);
                }
                break;
            }

            logits = self.decoder_step(audio, &[next], &mut cache, true, Some(&mut collector))?;
            collector.take_into(&mut attention_rows);
        }

        let attention = build_attention(&attention_rows, tokens.len());
        Ok(Decoded { tokens, attention })
    }

    /// Zero out the logits of tokens that must not be generated.
    ///
    /// Every special token is suppressed, not a curated list: the prompt has
    /// already fixed the language, the task and the no-timestamps mode, so
    /// there is nothing above the text vocabulary that a correct decode can
    /// still want. Leaving timestamp tokens available in no-timestamps mode is
    /// how a decode ends up spending its budget on times that are then thrown
    /// away.
    fn suppress_specials(&self, logits: &mut [f32], first_token: bool) {
        // Everything above end-of-text is special: language tags, the task
        // tags, and the whole timestamp range. End-of-text itself stays
        // available — it is how a window finishes.
        let eot = self.special.end_of_text as usize;
        for slot in logits.iter_mut().skip(eot + 1) {
            *slot = f32::NEG_INFINITY;
        }
        if first_token {
            // A transcription that begins by ending, or by emitting a bare
            // space, is not a transcription.
            if let Some(space) = self.tokenizer.token_to_id("Ġ") {
                if let Some(slot) = logits.get_mut(space as usize) {
                    *slot = f32::NEG_INFINITY;
                }
            }
            if let Some(slot) = logits.get_mut(eot) {
                *slot = f32::NEG_INFINITY;
            }
        }
    }

    /// One decoder forward pass.
    fn decoder_step(
        &mut self,
        audio: &[f32],
        input_ids: &[u32],
        cache: &mut KvCache,
        use_cache: bool,
        mut collector: Option<&mut AttentionCollector>,
    ) -> Result<Vec<f32>, String> {
        let ids: Vec<i64> = input_ids.iter().map(|t| *t as i64).collect();
        let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = Vec::with_capacity(4 + self.layers * 4);

        inputs.push((
            "input_ids".into(),
            Tensor::from_array(([1usize, ids.len()], ids))
                .map_err(|e| format!("cannot build input_ids: {e}"))?
                .into(),
        ));
        inputs.push((
            "encoder_hidden_states".into(),
            Tensor::from_array(([1usize, ENCODER_FRAMES, audio.len() / ENCODER_FRAMES], audio.to_vec()))
                .map_err(|e| format!("cannot build encoder_hidden_states: {e}"))?
                .into(),
        ));
        inputs.push((
            "use_cache_branch".into(),
            Tensor::from_array(([1usize], vec![use_cache]))
                .map_err(|e| format!("cannot build use_cache_branch: {e}"))?
                .into(),
        ));

        for layer in 0..self.layers {
            for (kind, side) in [("decoder", 0usize), ("encoder", 1usize)] {
                for (what, which) in [("key", 0usize), ("value", 1usize)] {
                    let (len, data) = cache.get(layer, side, which);
                    inputs.push((
                        format!("past_key_values.{layer}.{kind}.{what}").into(),
                        Tensor::from_array(([1usize, self.heads, len, HEAD_DIM], data))
                            .map_err(|e| format!("cannot build past_key_values.{layer}.{kind}.{what}: {e}"))?
                            .into(),
                    ));
                }
            }
        }

        let outputs = self.decoder.run(inputs).map_err(|e| format!("decoder failed: {e}"))?;

        if let Some(collector) = &mut collector {
            collector.collect(&outputs)?;
        }

        /*
          The cross-attention ("encoder") half of the cache is NOT refreshed
          every step, on purpose — this is not an optimisation, it is a
          correctness requirement this graph enforces silently.

          Measured directly: on the priming call (use_cache=false),
          present.N.encoder.key/value are real, shape [1, 8, 1500, 64] — the
          cross-attention computed once from the encoder's output. On every
          call AFTER that (use_cache=true), the SAME-NAMED outputs come back
          with a degenerate shape (dim 2 = 1) whose actual data buffer is
          EMPTY — not a smaller real tensor, an unusable one. Feeding that
          back as next step's input is what produced
          "shape [1, 8, 1, 64] (512 elements) is different from the length of
          the data provided (0 elements)" two steps into a real decode.

          The fix matches how Whisper's own KV-cache convention treats a
          merged decoder: cross-attention depends only on the encoder output,
          which never changes across steps, so it is computed once and then
          held fixed — never read back from `present.*.encoder.*` again.
        */
        let mut next = KvCache::empty(self.layers);
        for layer in 0..self.layers {
            for (what, which) in [("key", 0usize), ("value", 1usize)] {
                let name = format!("present.{layer}.decoder.{what}");
                let (shape, data) = outputs[name.as_str()]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("decoder produced no usable {name}: {e}"))?;
                let len = shape.get(2).copied().unwrap_or(0).max(0) as usize;
                next.set(layer, 0, which, len, data.to_vec());
            }

            if use_cache {
                // Carry the priming call's cross-attention forward untouched.
                let (len, data) = cache.get(layer, 1, 0);
                next.set(layer, 1, 0, len, data);
                let (len, data) = cache.get(layer, 1, 1);
                next.set(layer, 1, 1, len, data);
            } else {
                for (what, which) in [("key", 0usize), ("value", 1usize)] {
                    let name = format!("present.{layer}.encoder.{what}");
                    let (shape, data) = outputs[name.as_str()]
                        .try_extract_tensor::<f32>()
                        .map_err(|e| format!("decoder produced no usable {name}: {e}"))?;
                    let len = shape.get(2).copied().unwrap_or(0).max(0) as usize;
                    next.set(layer, 1, which, len, data.to_vec());
                }
            }
        }
        *cache = next;

        let (_, logits) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("decoder produced no usable logits: {e}"))?;
        Ok(logits.to_vec())
    }

    /// Split the token stream into words and time each one.
    ///
    /// A word boundary is a token whose text begins with a space, which is how
    /// Whisper's BPE encodes them — so "singing" arriving as `sing` + `ing` is
    /// one word, and ` the` starts a new one.
    fn tokens_to_words(&self, tokens: &[u32], frames: &[usize], offset_ms: u32) -> Vec<Word> {
        let mut words: Vec<Word> = Vec::new();
        let mut current = String::new();
        let mut current_start = 0usize;

        let flush = |words: &mut Vec<Word>, text: &str, start: usize, end: usize| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            let start_ms = offset_ms + dtw::frame_to_ms(start);
            let end_ms = offset_ms + dtw::frame_to_ms(end);
            words.push(Word { word: trimmed.to_string(), start_ms, end_ms: end_ms.max(start_ms) });
        };

        for (i, token) in tokens.iter().enumerate() {
            let piece = self.tokenizer.decode(&[*token], false).unwrap_or_default();
            let starts_word = piece.starts_with(' ') && !current.is_empty();
            if starts_word {
                let end = frames.get(i).copied().unwrap_or(ENCODER_FRAMES);
                flush(&mut words, &current, current_start, end);
                current.clear();
            }
            if current.is_empty() {
                current_start = frames.get(i).copied().unwrap_or(0);
            }
            current.push_str(&piece);
        }
        if !current.is_empty() {
            let end = frames.last().copied().unwrap_or(ENCODER_FRAMES);
            flush(&mut words, &current, current_start, end.max(current_start));
        }
        words
    }
}

/// The result of one decode.
struct Decoded {
    tokens: Vec<u32>,
    attention: dtw::Attention,
}

/// Tokens compared when looking for a repetition loop.
const REPEAT_WINDOW: usize = 12;

/// Whether the tail of `tokens` is a short phrase repeating.
///
/// Whisper loops on music — a held note or a repeated hook makes it emit the
/// same few tokens forever. Checked for periods up to 4 because that covers
/// the shapes that actually occur ("la la la", "yeah yeah"); longer genuine
/// repetition in a chorus is real lyric content and must survive.
fn is_repeating(tokens: &[u32]) -> bool {
    if tokens.len() < REPEAT_WINDOW {
        return false;
    }
    let tail = &tokens[tokens.len() - REPEAT_WINDOW..];
    (1..=4).any(|period| {
        // Every element must equal the one a period earlier.
        tail.iter().skip(period).zip(tail.iter()).all(|(a, b)| a == b)
    })
}

fn argmax(logits: &[f32]) -> u32 {
    let mut best = 0usize;
    let mut best_score = f32::NEG_INFINITY;
    for (i, &v) in logits.iter().enumerate() {
        if v > best_score {
            best_score = v;
            best = i;
        }
    }
    best as u32
}

/// Group timed words into line-shaped cues.
///
/// Lines are re-derived from pauses rather than taken from the model, which
/// has no notion of a line — the same rule, and the same constants, as the
/// WebView path's `groupWordsIntoLines`, so the two produce comparable output
/// while both exist.
fn group_into_lines(words: Vec<Word>) -> Vec<Cue> {
    let mut lines: Vec<Vec<Word>> = Vec::new();
    let mut current: Vec<Word> = Vec::new();

    for word in words {
        let gap = current.last().map(|p| word.start_ms.saturating_sub(p.end_ms)).unwrap_or(0);
        if !current.is_empty() && (gap > LINE_GAP_MS || current.len() >= MAX_WORDS_PER_LINE) {
            lines.push(std::mem::take(&mut current));
        }
        current.push(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }

    lines
        .into_iter()
        .map(|ws| Cue {
            time_ms: ws[0].start_ms,
            end_ms: ws[ws.len() - 1].end_ms,
            text: ws.iter().map(|w| w.word.as_str()).collect::<Vec<_>>().join(" "),
            words: ws,
        })
        .collect()
}

/// Per-layer, per-side KV tensors: `[layer][side][key|value]`.
///
/// Side 0 is the decoder's self-attention cache, which grows by one position
/// per step. Side 1 is the cross-attention cache over the encoder output,
/// which is computed once and then constant — feeding it back is what stops
/// the model recomputing 1500 frames of projection on every token.
struct KvCache {
    lens: Vec<[usize; 2]>,
    data: Vec<[[Vec<f32>; 2]; 2]>,
}

impl KvCache {
    fn empty(layers: usize) -> Self {
        Self {
            lens: vec![[0, 0]; layers],
            data: (0..layers).map(|_| [[Vec::new(), Vec::new()], [Vec::new(), Vec::new()]]).collect(),
        }
    }

    fn get(&self, layer: usize, side: usize, which: usize) -> (usize, Vec<f32>) {
        (self.lens[layer][side], self.data[layer][side][which].clone())
    }

    fn set(&mut self, layer: usize, side: usize, which: usize, len: usize, data: Vec<f32>) {
        self.lens[layer][side] = len;
        self.data[layer][side][which] = data;
    }
}

/// Pulls the alignment heads' attention rows out of a decoder step.
struct AttentionCollector {
    /// `(layer, head)` pairs, kept as owned data so the collector does not
    /// borrow the model while the model is being called.
    heads: Vec<(usize, usize)>,
    total_heads: usize,
    pending: Vec<Vec<f32>>,
}

impl AttentionCollector {
    fn new(heads: &[(usize, usize)], total_heads: usize) -> Self {
        Self { heads: heads.to_vec(), total_heads, pending: vec![Vec::new(); heads.len()] }
    }

    /// Extract this step's rows. `cross_attentions.N` is
    /// `[1, heads, tokens_this_step, encoder_frames]`.
    fn collect(&mut self, outputs: &ort::session::SessionOutputs<'_>) -> Result<(), String> {
        for slot in self.pending.iter_mut() {
            slot.clear();
        }
        for (i, &(layer, head)) in self.heads.iter().enumerate() {
            let name = format!("cross_attentions.{layer}");
            let Some(value) = outputs.get(name.as_str()) else {
                return Err(format!("decoder produced no {name}; this is not a _timestamped export"));
            };
            let (shape, data) = value
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("decoder produced no usable {name}: {e}"))?;
            let steps = shape.get(2).copied().unwrap_or(0).max(0) as usize;
            let frames = shape.get(3).copied().unwrap_or(0).max(0) as usize;
            if head >= self.total_heads || frames == 0 {
                continue;
            }
            // Head-major within the batch: skip whole heads, then take every
            // step's row so a multi-token priming pass is not truncated.
            let head_base = head * steps * frames;
            self.pending[i].extend_from_slice(&data[head_base..head_base + steps * frames]);
        }
        Ok(())
    }

    /// Append what `collect` gathered onto the running per-head rows.
    fn take_into(&mut self, rows: &mut [Vec<f32>]) {
        for (i, slot) in self.pending.iter_mut().enumerate() {
            rows[i].extend_from_slice(slot);
            slot.clear();
        }
    }
}

/// Reshape the accumulated rows into the layout `dtw::align` wants.
fn build_attention(rows: &[Vec<f32>], tokens: usize) -> dtw::Attention {
    let heads = rows.len();
    let mut attention = dtw::Attention::new(heads, tokens, ENCODER_FRAMES);
    for (head, row) in rows.iter().enumerate() {
        for token in 0..tokens {
            let start = token * ENCODER_FRAMES;
            if start + ENCODER_FRAMES <= row.len() {
                attention.set_row(head, token, &row[start..start + ENCODER_FRAMES]);
            }
        }
    }
    attention
}

fn session(path: &Path, threads: usize) -> Result<Session, String> {
    if !path.is_file() {
        return Err(format!("model file not found at {}", path.display()));
    }
    Session::builder()
        .map_err(|e| format!("cannot create an ONNX session builder: {e}"))?
        .with_intra_threads(threads.max(1))
        .map_err(|e| format!("cannot configure the session: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("cannot load {}: {e}", path.display()))
}

/// Resolve the steering tokens by NAME.
///
/// By name and not by number because the ids differ between the multilingual
/// and English-only checkpoints, and a wrong id is not an error — it is a
/// token the model happily conditions on, producing fluent output in the wrong
/// language or with timestamps interleaved into the text.
fn resolve_special_tokens(tokenizer: &tokenizers::Tokenizer) -> Result<SpecialTokens, String> {
    let id = |name: &str| {
        tokenizer.token_to_id(name).ok_or_else(|| format!("this tokenizer has no {name} token"))
    };

    // Language tokens are contiguous, and English is the first of them in
    // every Whisper checkpoint.
    let first_language = id("<|en|>")?;
    let vocab = tokenizer.get_vocab(true);
    let last_language = language_span_end(&vocab, first_language);

    Ok(SpecialTokens {
        start_of_transcript: id("<|startoftranscript|>")?,
        transcribe: id("<|transcribe|>")?,
        no_timestamps: id("<|notimestamps|>")?,
        end_of_text: id("<|endoftext|>")?,
        first_language,
        last_language,
    })
}

/// The last contiguous `<|xx|>` language token starting from `first`.
fn language_span_end(vocab: &HashMap<String, u32>, first: u32) -> u32 {
    let by_id: HashMap<u32, &str> = vocab.iter().map(|(k, v)| (*v, k.as_str())).collect();
    let mut last = first;
    let mut id = first;
    loop {
        id += 1;
        match by_id.get(&id) {
            Some(name) if is_language_token(name) => last = id,
            _ => return last,
        }
    }
}

/// `<|xx|>` or `<|xxx|>` — a language code, not `<|transcribe|>` or a
/// timestamp. Length is what separates them: every language tag is two or
/// three letters.
fn is_language_token(name: &str) -> bool {
    let Some(inner) = name.strip_prefix("<|").and_then(|s| s.strip_suffix("|>")) else {
        return false;
    };
    (2..=3).contains(&inner.len()) && inner.chars().all(|c| c.is_ascii_lowercase())
}

/// Read `alignment_heads` from the model's generation config.
///
/// Falls back to every head of the last third of the layers, which is where
/// the published sets always sit — a worse alignment, but a working one, and
/// better than refusing to transcribe because a config field moved.
fn read_alignment_heads(path: &Path, layers: usize, heads: usize) -> Vec<(usize, usize)> {
    let parsed = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("alignment_heads").cloned())
        .and_then(|value| serde_json::from_value::<Vec<Vec<usize>>>(value).ok());

    if let Some(pairs) = parsed {
        let valid: Vec<(usize, usize)> =
            pairs.into_iter().filter(|p| p.len() == 2 && p[0] < layers && p[1] < heads).map(|p| (p[0], p[1])).collect();
        if !valid.is_empty() {
            return valid;
        }
    }

    eprintln!("[sidecar] no usable alignment_heads in {}; falling back to the top layers", path.display());
    let from = layers.saturating_sub(layers / 3).saturating_sub(1);
    (from..layers).flat_map(|l| (0..heads).map(move |h| (l, h))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_ms: u32, end_ms: u32) -> Word {
        Word { word: text.into(), start_ms, end_ms }
    }

    #[test]
    fn words_close_together_become_one_line() {
        let cues = group_into_lines(vec![word("hello", 1000, 1400), word("world", 1500, 2000)]);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "hello world");
        assert_eq!(cues[0].time_ms, 1000);
        assert_eq!(cues[0].end_ms, 2000);
        assert_eq!(cues[0].words.len(), 2);
    }

    #[test]
    fn a_long_pause_starts_a_new_line() {
        let cues = group_into_lines(vec![word("first", 0, 400), word("second", 400 + LINE_GAP_MS + 1, 2000)]);
        assert_eq!(cues.len(), 2, "got {cues:?}");
    }

    #[test]
    fn a_legato_run_is_split_before_it_becomes_one_giant_line() {
        let words: Vec<Word> = (0..40).map(|i| word("la", i * 100, i * 100 + 90)).collect();
        let cues = group_into_lines(words);
        assert!(cues.len() >= 3, "got {} lines", cues.len());
        assert!(cues.iter().all(|c| c.words.len() <= MAX_WORDS_PER_LINE));
    }

    #[test]
    fn grouping_nothing_produces_nothing() {
        assert!(group_into_lines(Vec::new()).is_empty());
    }

    #[test]
    fn every_cue_carries_its_own_words_for_align_rs() {
        // align.rs only trusts per-word timing when a real lyric line's word
        // count matches; a cue with no words silently loses that path.
        let cues = group_into_lines(vec![word("a", 0, 100), word("b", 150, 300)]);
        assert_eq!(cues[0].words.len(), 2);
        assert_eq!(cues[0].words[1].start_ms, 150);
    }

    #[test]
    fn a_short_phrase_repeating_is_detected() {
        // The actual failure mode on music.
        let mut tokens = vec![1u32, 2, 3];
        for _ in 0..6 {
            tokens.extend_from_slice(&[7, 8]);
        }
        assert!(is_repeating(&tokens), "a two-token loop was not caught");
    }

    #[test]
    fn a_single_token_repeating_is_detected() {
        let tokens = vec![5u32; 20];
        assert!(is_repeating(&tokens));
    }

    #[test]
    fn ordinary_text_is_not_mistaken_for_a_loop() {
        let tokens: Vec<u32> = (100..140).collect();
        assert!(!is_repeating(&tokens));
    }

    #[test]
    fn a_repeated_word_inside_real_text_is_not_a_loop() {
        // "I said I said it" — repetition that is genuine lyric content must
        // survive, or choruses get truncated.
        let tokens = vec![10u32, 11, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
        assert!(!is_repeating(&tokens));
    }

    #[test]
    fn too_few_tokens_cannot_be_a_loop() {
        assert!(!is_repeating(&[1, 1, 1]));
        assert!(!is_repeating(&[]));
    }

    #[test]
    fn argmax_picks_the_largest_and_survives_negative_infinities() {
        // Suppression writes -inf across most of the vocabulary every step.
        let mut logits = vec![f32::NEG_INFINITY; 100];
        logits[42] = -3.0;
        logits[7] = -9.0;
        assert_eq!(argmax(&logits), 42);
    }

    #[test]
    fn language_tokens_are_told_apart_from_the_other_special_tokens() {
        assert!(is_language_token("<|en|>"));
        assert!(is_language_token("<|hi|>"));
        assert!(is_language_token("<|yue|>"));
        assert!(!is_language_token("<|transcribe|>"));
        assert!(!is_language_token("<|notimestamps|>"));
        assert!(!is_language_token("<|0.00|>"), "a timestamp token is not a language");
        assert!(!is_language_token("hello"));
    }

    #[test]
    fn the_language_span_stops_at_the_first_non_language_token() {
        let vocab: HashMap<String, u32> = [
            ("<|en|>".to_string(), 100u32),
            ("<|zh|>".to_string(), 101),
            ("<|de|>".to_string(), 102),
            ("<|translate|>".to_string(), 103),
            ("<|transcribe|>".to_string(), 104),
        ]
        .into_iter()
        .collect();
        assert_eq!(language_span_end(&vocab, 100), 102);
    }

    #[test]
    fn a_language_span_of_one_does_not_loop_forever() {
        let vocab: HashMap<String, u32> = [("<|en|>".to_string(), 100u32)].into_iter().collect();
        assert_eq!(language_span_end(&vocab, 100), 100);
    }

    #[test]
    fn alignment_heads_out_of_range_for_the_loaded_model_are_dropped() {
        // A config from a bigger checkpoint left in the model directory would
        // otherwise index past the end of the attention tensors.
        let dir = std::env::temp_dir().join(format!("lyric-align-heads-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("generation_config.json");
        std::fs::write(&path, r#"{"alignment_heads": [[3,1],[99,0],[4,2]]}"#).unwrap();

        let heads = read_alignment_heads(&path, 6, 8);
        assert_eq!(heads, vec![(3, 1), (4, 2)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_generation_config_falls_back_rather_than_giving_up() {
        let heads = read_alignment_heads(Path::new("does-not-exist.json"), 6, 8);
        assert!(!heads.is_empty(), "no alignment heads means no word timing at all");
        assert!(heads.iter().all(|&(l, h)| l < 6 && h < 8));
    }

    #[test]
    fn the_kv_cache_starts_empty_and_records_what_it_is_given() {
        let mut cache = KvCache::empty(2);
        assert_eq!(cache.get(0, 0, 0), (0, Vec::new()));
        cache.set(1, 1, 0, 1500, vec![0.5; 4]);
        assert_eq!(cache.get(1, 1, 0), (1500, vec![0.5; 4]));
        // Setting one side must not disturb the other.
        assert_eq!(cache.get(1, 0, 0).0, 0);
    }

    #[test]
    fn attention_rows_shorter_than_the_token_count_leave_zeros_rather_than_panicking() {
        // A window cancelled mid-decode can leave fewer rows than tokens.
        let rows = vec![vec![1.0f32; ENCODER_FRAMES]; 2];
        let attention = build_attention(&rows, 3);
        // Only asserting it did not panic and produced the requested shape;
        // align() is where the values are checked.
        assert_eq!(dtw::align(attention).len(), 3);
    }
}
