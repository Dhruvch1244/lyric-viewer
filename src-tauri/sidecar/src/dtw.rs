//! Turning Whisper's cross-attention into word timing.
//!
//! Whisper emits text, not times. The timing comes from a second reading of
//! the same forward pass: while decoding token *t* the model attends to some
//! region of the encoded audio, and the attention weights say which region.
//! Aligning the token sequence to the frame sequence through that attention is
//! a monotonic path-finding problem, which is what dynamic time warping is
//! for.
//!
//! This is the pass that JOB-ENGINE §2.3 flagged as the thing `ort` does not
//! give for free, and it is why the model directory must hold the
//! `_timestamped` ONNX export — the ordinary one emits no cross-attention at
//! all. (That is not a hypothetical: the WebView path this replaces was
//! pointed at the ordinary export and every transcription it attempted failed.
//! See the fix in `src/renderer/whisper.js`.)
//!
//! The steps, following OpenAI's `whisper/timing.py`:
//!
//! 1. Keep only the **alignment heads** — the specific (layer, head) pairs
//!    published in the model's `generation_config.json`. Most attention heads
//!    are not doing alignment at all, and averaging them in is noise.
//! 2. Normalise each head over the time axis, so a head with a large dynamic
//!    range does not dominate one with a small one.
//! 3. Median-filter along time. Attention is spiky; a spike one frame wide is
//!    not evidence of where a word is.
//! 4. Average the heads, negate to make it a cost, and DTW.
//! 5. Read the token→frame path back as milliseconds.
//!
//! Everything here is pure arithmetic over numbers, so all of it is tested.

/// Milliseconds of audio one *encoder* frame covers.
///
/// Twice the mel hop, and derived from it rather than written as 20.0: the
/// encoder's first convolution has stride 2, so its 1500 output frames span
/// the same 30 s as the 3000 mel frames going in. Getting this factor wrong
/// halves or doubles every timestamp in the app, so the relationship lives in
/// the code instead of in a comment.
pub const ENCODER_FRAME_MS: f32 = crate::mel::FRAME_MS * 2.0;

/// Width of the median filter applied along the time axis, from
/// `whisper/timing.py`'s `medfilt_width`.
const MEDIAN_FILTER_WIDTH: usize = 7;

/// Per-head attention for one decode, shaped `[heads][tokens][frames]`.
///
/// Held head-major because every operation below runs along one head's time
/// axis, and because only the alignment heads are ever collected — a full
/// 6-layer × 8-head capture over a long segment is tens of megabytes of
/// tensors that would be averaged away in step 4 anyway.
pub struct Attention {
    heads: usize,
    tokens: usize,
    frames: usize,
    data: Vec<f32>,
}

impl Attention {
    pub fn new(heads: usize, tokens: usize, frames: usize) -> Self {
        Self { heads, tokens, frames, data: vec![0.0; heads * tokens * frames] }
    }

    /// Write one token's row for one head.
    pub fn set_row(&mut self, head: usize, token: usize, row: &[f32]) {
        let base = (head * self.tokens + token) * self.frames;
        let n = row.len().min(self.frames);
        self.data[base..base + n].copy_from_slice(&row[..n]);
    }

    fn row(&self, head: usize, token: usize) -> &[f32] {
        let base = (head * self.tokens + token) * self.frames;
        &self.data[base..base + self.frames]
    }

    fn row_mut(&mut self, head: usize, token: usize) -> &mut [f32] {
        let base = (head * self.tokens + token) * self.frames;
        &mut self.data[base..base + self.frames]
    }
}

/// Normalise, filter, average and warp — the whole alignment, start to finish.
///
/// Returns one frame index per token: where in the audio that token was
/// spoken. Length equals `attention.tokens`.
///
/// Complexity: O(heads · tokens · frames) for the preparation and
/// O(tokens · frames) time and space for the warp itself. For a 30 s segment
/// that is 1500 frames against a few hundred tokens — under a megabyte.
pub fn align(mut attention: Attention) -> Vec<usize> {
    if attention.tokens == 0 || attention.frames == 0 || attention.heads == 0 {
        return Vec::new();
    }

    /*
      Normalise each head's row over TIME, not over tokens.

      whisper/timing.py takes std/mean over dim=-2, which on its
      [head, token, frame] layout is the token axis. That is a per-head,
      per-frame normalisation: it asks "is this frame attended more than this
      head usually attends a frame", which removes a head's baseline
      preference for, say, the start of the window. Normalising along time
      instead would remove exactly the signal being looked for.
    */
    for head in 0..attention.heads {
        for frame in 0..attention.frames {
            let mut sum = 0f64;
            for token in 0..attention.tokens {
                sum += attention.row(head, token)[frame] as f64;
            }
            let mean = sum / attention.tokens as f64;
            let mut var = 0f64;
            for token in 0..attention.tokens {
                let d = attention.row(head, token)[frame] as f64 - mean;
                var += d * d;
            }
            // Sample standard deviation, matching torch.std_mean's default
            // correction of 1. A single token makes it undefined; leave the
            // column alone rather than dividing by zero.
            let std = if attention.tokens > 1 { (var / (attention.tokens - 1) as f64).sqrt() } else { 0.0 };
            if std > 1e-12 {
                for token in 0..attention.tokens {
                    let v = attention.row(head, token)[frame] as f64;
                    attention.row_mut(head, token)[frame] = ((v - mean) / std) as f32;
                }
            }
        }
    }

    // Median filter along time. Attention is spiky and a one-frame spike is
    // not evidence of anything.
    let mut scratch = vec![0f32; attention.frames];
    for head in 0..attention.heads {
        for token in 0..attention.tokens {
            median_filter(attention.row(head, token), MEDIAN_FILTER_WIDTH, &mut scratch);
            attention.row_mut(head, token).copy_from_slice(&scratch);
        }
    }

    // Average the heads and negate: DTW minimises, and strong attention is a
    // good match.
    let mut cost = vec![0f32; attention.tokens * attention.frames];
    for token in 0..attention.tokens {
        for frame in 0..attention.frames {
            let mut sum = 0f32;
            for head in 0..attention.heads {
                sum += attention.row(head, token)[frame];
            }
            cost[token * attention.frames + frame] = -sum / attention.heads as f32;
        }
    }

    let path = dtw(&cost, attention.tokens, attention.frames);
    frames_per_token(&path, attention.tokens)
}

/// Median filter with reflected edges.
///
/// Reflected rather than zero-padded: a zero pad at the edges pulls the first
/// and last few frames toward zero, which is where the first and last words
/// are.
fn median_filter(input: &[f32], width: usize, out: &mut [f32]) {
    let n = input.len();
    if width <= 1 || n < width {
        out.copy_from_slice(input);
        return;
    }
    let half = width / 2;
    let mut window = vec![0f32; width];
    for (i, slot_out) in out.iter_mut().enumerate().take(n) {
        for (k, slot) in window.iter_mut().enumerate() {
            let offset = i as isize + k as isize - half as isize;
            *slot = input[reflect(offset, n)];
        }
        window.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        *slot_out = window[half];
    }
}

/// Reflect an out-of-range index back into `0..n`, without repeating the edge.
fn reflect(mut i: isize, n: usize) -> usize {
    let n = n as isize;
    if n == 1 {
        return 0;
    }
    // Fold repeatedly, so a filter wider than the signal still terminates.
    loop {
        if i < 0 {
            i = -i;
        } else if i >= n {
            i = 2 * (n - 1) - i;
        } else {
            return i as usize;
        }
    }
}

/// One step of the warp path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Diagonal,
    Token,
    Frame,
}

/// Dynamic time warping over a `tokens × frames` cost matrix.
///
/// Returns the monotonic path as `(token, frame)` pairs, in order. Both
/// sequences are aligned end to end: token 0 matches frame 0 and the last
/// token matches the last frame, which is right here because the token
/// sequence is exactly the transcription of that audio window and nothing
/// else.
fn dtw(cost: &[f32], tokens: usize, frames: usize) -> Vec<(usize, usize)> {
    let w = frames + 1;
    let mut acc = vec![f32::INFINITY; (tokens + 1) * w];
    let mut trace = vec![Step::Frame; (tokens + 1) * w];
    acc[0] = 0.0;

    for i in 1..=tokens {
        for j in 1..=frames {
            let diagonal = acc[(i - 1) * w + (j - 1)];
            let skip_frame = acc[i * w + (j - 1)];
            let skip_token = acc[(i - 1) * w + j];
            // Ties go to the diagonal, then to consuming a token: the same
            // precedence whisper/timing.py uses, and it matters because ties
            // are common in the flat regions between words.
            let (best, step) = if diagonal <= skip_token && diagonal <= skip_frame {
                (diagonal, Step::Diagonal)
            } else if skip_token <= skip_frame {
                (skip_token, Step::Token)
            } else {
                (skip_frame, Step::Frame)
            };
            acc[i * w + j] = cost[(i - 1) * frames + (j - 1)] + best;
            trace[i * w + j] = step;
        }
    }

    // Backtrace. The edges are forced so the walk cannot leave the matrix:
    // along the top only frames can be consumed, down the left only tokens.
    trace[..w].fill(Step::Frame);
    for i in 0..=tokens {
        trace[i * w] = Step::Token;
    }

    let mut path = Vec::with_capacity(tokens + frames);
    let (mut i, mut j) = (tokens, frames);
    while i > 0 || j > 0 {
        path.push((i - 1, j - 1));
        match trace[i * w + j] {
            Step::Diagonal => {
                i -= 1;
                j -= 1;
            }
            Step::Token => i -= 1,
            Step::Frame => j -= 1,
        }
    }
    path.reverse();
    path
}

/// Collapse the warp path to one frame per token: the FIRST frame the path
/// assigns to that token, which is where it starts being spoken.
fn frames_per_token(path: &[(usize, usize)], tokens: usize) -> Vec<usize> {
    let mut out = vec![usize::MAX; tokens];
    for &(token, frame) in path {
        if token < tokens && out[token] == usize::MAX {
            out[token] = frame;
        }
    }
    // A token the path never visited inherits its predecessor's frame rather
    // than becoming a zero — a stray 0 in the middle of a line reads as a word
    // sung at the start of the song.
    let mut last = 0usize;
    for slot in out.iter_mut() {
        if *slot == usize::MAX {
            *slot = last;
        } else {
            last = *slot;
        }
    }
    out
}

/// Frame index to milliseconds from the start of the window.
pub fn frame_to_ms(frame: usize) -> u32 {
    (frame as f32 * ENCODER_FRAME_MS) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Attention that walks steadily along the audio: token *t* attends to
    /// frames around `t * stride`. The alignment must recover that.
    fn diagonal_attention(heads: usize, tokens: usize, frames: usize, stride: f32) -> Attention {
        let mut a = Attention::new(heads, tokens, frames);
        for head in 0..heads {
            for token in 0..tokens {
                let centre = token as f32 * stride;
                let row: Vec<f32> = (0..frames)
                    .map(|f| {
                        let d = (f as f32 - centre) / 2.0;
                        (-d * d).exp()
                    })
                    .collect();
                a.set_row(head, token, &row);
            }
        }
        a
    }

    /*
      What `align` returns is the frame at which the path STARTS spending on a
      token — the boundary between it and the one before — not the frame where
      that token's attention peaks. That is deliberate and matches
      whisper/timing.py, which reads word start times off exactly these jump
      points. With evenly spaced attention peaks the boundaries therefore land
      roughly halfway between peaks, and a word's [start, end] pair brackets
      its own peak rather than centring on it.

      Worth stating in a test of its own, because "token 3's time" reads like
      "where token 3 is loudest" and it is not.
    */
    #[test]
    fn a_token_is_timed_at_its_boundary_not_at_its_attention_peak() {
        let (frames, tokens, stride) = (100, 10, 10.0);
        let got = align(diagonal_attention(4, tokens, frames, stride));
        assert_eq!(got.len(), tokens);
        assert_eq!(got[0], 0, "the first token must start at the start of the window");
        for (token, &frame) in got.iter().enumerate().skip(1) {
            let peak = token as f32 * stride;
            assert!(
                (frame as f32) < peak,
                "token {token} was timed at frame {frame}, which is at or past its peak {peak}"
            );
            assert!(
                (frame as f32) > peak - stride,
                "token {token} was timed at frame {frame}, before the previous token's peak"
            );
        }
    }

    #[test]
    fn evenly_spaced_speech_produces_evenly_spaced_timings() {
        let (frames, tokens, stride) = (100, 10, 10.0);
        let got = align(diagonal_attention(4, tokens, frames, stride));
        // Skip the first gap: token 0 is pinned to frame 0 by the path's own
        // start condition, so its spacing carries the boundary offset.
        for pair in got.windows(2).skip(1) {
            let gap = (pair[1] - pair[0]) as f32;
            assert!((gap - stride).abs() <= 2.0, "gap of {gap} frames, expected about {stride}");
        }
    }

    #[test]
    fn the_alignment_is_monotonic() {
        // Words cannot go backwards in time. Nothing downstream re-sorts, so
        // a non-monotonic path would put a lyric line before the one above it.
        let got = align(diagonal_attention(4, 24, 300, 12.0));
        for pair in got.windows(2) {
            assert!(pair[1] >= pair[0], "alignment went backwards: {pair:?}");
        }
    }

    #[test]
    fn a_pause_in_the_middle_is_reflected_in_the_gap() {
        // Five tokens early, five late, nothing between: the recovered frames
        // must show one big jump rather than spreading evenly.
        let frames = 200;
        let mut a = Attention::new(2, 10, frames);
        for head in 0..2 {
            for token in 0..10 {
                let centre = if token < 5 { token as f32 * 4.0 } else { 150.0 + (token - 5) as f32 * 4.0 };
                let row: Vec<f32> = (0..frames)
                    .map(|f| {
                        let d = (f as f32 - centre) / 2.0;
                        (-d * d).exp()
                    })
                    .collect();
                a.set_row(head, token, &row);
            }
        }
        let got = align(a);
        let biggest_jump = got.windows(2).map(|p| p[1] - p[0]).max().unwrap();
        assert!(biggest_jump > 100, "the pause did not survive alignment: {got:?}");
    }

    #[test]
    fn an_empty_attention_produces_an_empty_alignment_rather_than_panicking() {
        assert!(align(Attention::new(0, 0, 0)).is_empty());
        assert!(align(Attention::new(4, 0, 100)).is_empty());
        assert!(align(Attention::new(4, 10, 0)).is_empty());
    }

    #[test]
    fn a_single_token_does_not_divide_by_a_zero_standard_deviation() {
        // One token means the per-frame standard deviation is undefined.
        let got = align(diagonal_attention(4, 1, 50, 0.0));
        assert_eq!(got.len(), 1);
        assert!(got[0] < 50);
    }

    #[test]
    fn flat_attention_still_produces_an_ordered_alignment() {
        // No information at all. The result is meaningless but it must still
        // be monotonic and in range, because callers index audio with it.
        let mut a = Attention::new(3, 8, 60);
        for head in 0..3 {
            for token in 0..8 {
                a.set_row(head, token, &vec![0.5; 60]);
            }
        }
        let got = align(a);
        assert_eq!(got.len(), 8);
        for pair in got.windows(2) {
            assert!(pair[1] >= pair[0]);
        }
        assert!(got.iter().all(|&f| f < 60));
    }

    #[test]
    fn the_median_filter_removes_a_one_frame_spike_but_keeps_a_step() {
        let mut out = vec![0f32; 11];
        let mut input = vec![0f32; 11];
        input[5] = 10.0; // impulse
        median_filter(&input, 7, &mut out);
        assert_eq!(out[5], 0.0, "a one-frame spike survived the filter");

        let step: Vec<f32> = (0..11).map(|i| if i < 5 { 0.0 } else { 1.0 }).collect();
        median_filter(&step, 7, &mut out);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[10], 1.0, "the filter flattened a real transition");
    }

    #[test]
    fn the_median_filter_reflects_rather_than_zero_padding_its_edges() {
        // A zero pad would drag the first frames toward zero, which is exactly
        // where the first word is.
        let input = vec![5.0f32; 9];
        let mut out = vec![0f32; 9];
        median_filter(&input, 7, &mut out);
        assert!(out.iter().all(|&v| (v - 5.0).abs() < 1e-6), "edges were pulled off a constant signal: {out:?}");
    }

    #[test]
    fn the_median_filter_passes_a_signal_shorter_than_its_window_through() {
        let input = vec![1.0f32, 2.0, 3.0];
        let mut out = vec![0f32; 3];
        median_filter(&input, 7, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn reflection_folds_repeatedly_rather_than_running_off_the_end() {
        assert_eq!(reflect(-1, 5), 1);
        assert_eq!(reflect(5, 5), 3);
        assert_eq!(reflect(0, 5), 0);
        assert_eq!(reflect(-9, 5), 1, "an index more than one length out must still land in range");
        assert_eq!(reflect(2, 1), 0, "a one-frame signal has nowhere else to go");
    }

    #[test]
    fn the_warp_path_touches_both_ends_of_both_sequences() {
        // The token sequence IS the transcription of this audio, so nothing is
        // allowed to be left unaligned at either end.
        let (tokens, frames) = (6, 40);
        let cost: Vec<f32> = (0..tokens * frames).map(|_| 1.0).collect();
        let path = dtw(&cost, tokens, frames);
        assert_eq!(path.first(), Some(&(0, 0)));
        assert_eq!(path.last(), Some(&(tokens - 1, frames - 1)));
    }

    #[test]
    fn the_warp_path_never_moves_backwards_in_either_sequence() {
        let (tokens, frames) = (7, 33);
        let cost: Vec<f32> = (0..tokens * frames).map(|i| ((i * 7919) % 13) as f32).collect();
        let path = dtw(&cost, tokens, frames);
        for pair in path.windows(2) {
            assert!(pair[1].0 >= pair[0].0 && pair[1].1 >= pair[0].1, "path stepped backwards: {pair:?}");
            assert!(
                pair[1].0 - pair[0].0 <= 1 && pair[1].1 - pair[0].1 <= 1,
                "path skipped an element: {pair:?}"
            );
        }
    }

    #[test]
    fn a_token_the_path_skipped_inherits_the_previous_time_rather_than_zero() {
        // A stray 0 in the middle of a line reads as a word sung at the very
        // start of the song.
        let path = vec![(0usize, 0usize), (0, 1), (2, 5)];
        let got = frames_per_token(&path, 4);
        assert_eq!(got, vec![0, 0, 5, 5]);
    }

    #[test]
    fn an_encoder_frame_is_twenty_milliseconds() {
        // The encoder's first convolution has stride 2, so 1500 frames cover
        // the same 30 s as 3000 mel frames. Getting this wrong halves or
        // doubles every timestamp in the app.
        assert_eq!(frame_to_ms(0), 0);
        assert_eq!(frame_to_ms(50), 1000);
        assert_eq!(frame_to_ms(1500), 30_000);
    }
}
