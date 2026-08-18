//! Force-align known lyric text to a transcription's timings.
//!
//! A Rust port of `align.js`. LRCLIB has *plain* lyrics for far more songs than
//! synced ones, and Whisper knows WHEN a line was sung better than WHAT its
//! words were. Combined: take the words from the real lyrics and the clock from
//! the transcription. Needleman-Wunsch global alignment over the two line
//! sequences (token-overlap similarity); unmatched lines interpolate between the
//! anchors around them, so one mondegreen doesn't desync everything after it.

use crate::lyrics::{self, token_similarity, Cue};

const MATCH_FLOOR: f64 = 0.34;
const GAP_PENALTY: f64 = -0.45;
const DEFAULT_LINE_MS: i64 = 2600;

/// Split a plain-lyrics document into display lines: drop blanks and bracketed
/// section headers ("[Chorus]", "(Verse 2)").
pub fn split_plain_lyrics(plain: &str) -> Vec<String> {
    plain
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| {
            if l.is_empty() {
                return false;
            }
            let bytes = l.as_bytes();
            let bracketed = (bytes[0] == b'[' || bytes[0] == b'(')
                && (bytes[bytes.len() - 1] == b']' || bytes[bytes.len() - 1] == b')');
            !bracketed
        })
        .collect()
}

/// Needleman-Wunsch alignment of correct lines against transcribed cues.
/// Returns, for each line, the index of the cue it matched (or None).
fn align_sequences(lines: &[String], cues: &[Cue]) -> Vec<Option<usize>> {
    let n = lines.len();
    let m = cues.len();
    let mut score = vec![vec![0.0_f64; m + 1]; n + 1];
    // 0 = diagonal (match), 1 = up (line skipped), 2 = left (cue skipped)
    let mut back = vec![vec![0u8; m + 1]; n + 1];

    for i in 1..=n {
        score[i][0] = score[i - 1][0] + GAP_PENALTY;
        back[i][0] = 1;
    }
    for j in 1..=m {
        score[0][j] = score[0][j - 1] + GAP_PENALTY;
        back[0][j] = 2;
    }
    for i in 1..=n {
        for j in 1..=m {
            let sim = token_similarity(&lines[i - 1], &cues[j - 1].text);
            let diag = score[i - 1][j - 1] + (sim - MATCH_FLOOR);
            let up = score[i - 1][j] + GAP_PENALTY;
            let left = score[i][j - 1] + GAP_PENALTY;
            let mut best = diag;
            let mut dir = 0u8;
            if up > best {
                best = up;
                dir = 1;
            }
            if left > best {
                best = left;
                dir = 2;
            }
            score[i][j] = best;
            back[i][j] = dir;
        }
    }

    let mut matches = vec![None; n];
    let mut i = n;
    let mut j = m;
    while i > 0 && j > 0 {
        match back[i][j] {
            0 => {
                if token_similarity(&lines[i - 1], &cues[j - 1].text) >= MATCH_FLOOR {
                    matches[i - 1] = Some(j - 1);
                }
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    matches
}

/// Produce synced cues from correct lyric lines + transcribed timings.
/// Returns (cues, coverage) — coverage is the fraction of lines that anchored
/// directly; low coverage means the caller should prefer the raw transcription.
pub fn align_lyrics(lines: &[String], cues: &[Cue], duration_ms: i64) -> (Vec<Cue>, f64) {
    let clean: Vec<String> = lines.iter().filter(|l| !l.trim().is_empty()).cloned().collect();
    if clean.is_empty() || cues.is_empty() {
        return (Vec::new(), 0.0);
    }

    let matches = align_sequences(&clean, cues);
    let anchors = matches.iter().filter(|x| x.is_some()).count();

    let mut times: Vec<Option<i64>> = vec![None; clean.len()];
    for (i, m) in matches.iter().enumerate() {
        if let Some(idx) = m {
            times[i] = Some(cues[*idx].time_ms);
        }
    }

    let first_anchor = times.iter().position(|t| t.is_some());
    let Some(first_anchor) = first_anchor else {
        // Nothing matched: spread evenly across the track.
        let span = if duration_ms > 0 { duration_ms } else { clean.len() as i64 * DEFAULT_LINE_MS };
        let step = span as f64 / (clean.len() as f64 + 1.0);
        let out = clean
            .iter()
            .enumerate()
            .map(|(i, text)| Cue { time_ms: (step * (i as f64 + 1.0)).round() as i64, text: text.clone(), end_ms: None, words: None })
            .collect();
        return (out, 0.0);
    };

    // Lead-in: back off from the first anchor.
    for i in (0..first_anchor).rev() {
        times[i] = Some((times[i + 1].unwrap() - DEFAULT_LINE_MS).max(0));
    }
    // Middle + tail: interpolate between anchors.
    let mut i = first_anchor + 1;
    while i < clean.len() {
        if times[i].is_some() {
            i += 1;
            continue;
        }
        let prev = times[i - 1].unwrap();
        let mut next = None;
        for k in (i + 1)..clean.len() {
            if times[k].is_some() {
                next = Some(k);
                break;
            }
        }
        match next {
            None => {
                let end = if duration_ms > prev { duration_ms } else { prev + (clean.len() - i) as i64 * DEFAULT_LINE_MS };
                let step = (end - prev) as f64 / (clean.len() - i + 1) as f64;
                for (off, k) in (i..clean.len()).enumerate() {
                    times[k] = Some(prev + (step * (off as f64 + 1.0)).round() as i64);
                }
                break;
            }
            Some(nx) => {
                let step = (times[nx].unwrap() - prev) as f64 / (nx - i + 1) as f64;
                for (off, k) in (i..nx).enumerate() {
                    times[k] = Some(prev + (step * (off as f64 + 1.0)).round() as i64);
                }
                i = nx;
            }
        }
    }

    // Enforce strictly increasing times.
    let mut out = Vec::with_capacity(clean.len());
    let mut last = -1i64;
    for (i, text) in clean.iter().enumerate() {
        let mut t = times[i].unwrap_or(0).max(0);
        if t <= last {
            t = last + 1;
        }
        last = t;

        // A directly-anchored line has a real raw Whisper cue behind it,
        // which may carry measured per-word timing (see whisper.js). Only a
        // DIRECT anchor has one at all — interpolated lines have no raw cue
        // to draw from and keep words: None, same as before.
        let (end_ms, words) = match matches[i].map(|idx| &cues[idx]) {
            Some(raw) => {
                let end_ms = raw.end_ms.filter(|&e| e > t);
                let words = raw.words.as_ref().and_then(|raw_words| {
                    // Only trust the mapping when the real line and the raw
                    // transcription split into the same number of words —
                    // a mishearing that merges/splits words (e.g. "good bye"
                    // vs "goodbye") makes positional mapping meaningless, and
                    // renderer.js already has a good syllable-weighted
                    // fallback for exactly that case. Better to have real
                    // timing on the lines Whisper got cleanly than guessed
                    // timing on all of them.
                    let tokens: Vec<&str> = text.split_whitespace().collect();
                    if tokens.is_empty() || tokens.len() != raw_words.len() {
                        return None;
                    }
                    Some(
                        tokens
                            .iter()
                            .zip(raw_words.iter())
                            .map(|(word, rw)| lyrics::WordTiming {
                                word: (*word).to_string(),
                                start_ms: rw.start_ms,
                                end_ms: rw.end_ms,
                            })
                            .collect(),
                    )
                });
                (end_ms, words)
            }
            None => (None, None),
        };

        out.push(Cue { time_ms: t, text: text.clone(), end_ms, words });
    }
    (out, anchors as f64 / clean.len() as f64)
}

/// Attach real per-word timing to already-correct, already-synced cues
/// (LRCLIB/NetEase/Kugou) without touching their trusted line text or
/// timing — unlike `align_lyrics`, which derives both from `raw_cues` and is
/// meant for the "no real sync exists at all" case. Returns `existing`
/// unchanged (word-for-word) wherever a line wasn't cleanly anchored; only
/// `.words` is ever added, never text or `time_ms`.
///
/// Returns `existing.len()` cues if `align_lyrics`'s internal blank-line
/// filtering ever desyncs its output from `existing` (it shouldn't, since
/// real synced cue text is never blank) — a length mismatch degrades to a
/// no-op rather than mis-zipping timings onto the wrong lines.
pub fn attach_word_timings(existing: Vec<Cue>, raw_cues: &[Cue], duration_ms: i64) -> Vec<Cue> {
    let lines: Vec<String> = existing.iter().map(|c| c.text.clone()).collect();
    let (upgraded, _coverage) = align_lyrics(&lines, raw_cues, duration_ms);
    if upgraded.len() != existing.len() {
        return existing;
    }
    existing
        .into_iter()
        .zip(upgraded)
        .map(|(mut orig, up)| {
            orig.words = up.words.or(orig.words);
            orig
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t: i64, s: &str) -> Cue {
        Cue { time_ms: t, text: s.into(), end_ms: None, words: None }
    }

    fn word(w: &str, start_ms: i64, end_ms: i64) -> lyrics::WordTiming {
        lyrics::WordTiming { word: w.into(), start_ms, end_ms }
    }

    #[test]
    fn split_drops_blanks_and_section_headers() {
        let plain = "[Verse 1]\nfirst line\n\n(Chorus)\nsecond line";
        assert_eq!(split_plain_lyrics(plain), vec!["first line", "second line"]);
    }

    #[test]
    fn align_anchors_real_words_onto_transcribed_timing() {
        let lines = vec!["hello world".to_string(), "goodbye now".to_string()];
        // Transcription mishears "goodbye" but the timing is right.
        let cues = vec![cue(1000, "hello world"), cue(5000, "good bye now")];
        let (out, coverage) = align_lyrics(&lines, &cues, 10_000);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "hello world"); // real word, transcribed time
        assert_eq!(out[0].time_ms, 1000);
        assert_eq!(out[1].text, "goodbye now"); // the CORRECT spelling wins
        assert!(coverage > 0.0);
        // Strictly increasing.
        assert!(out[1].time_ms > out[0].time_ms);
    }

    #[test]
    fn align_with_no_matches_spreads_evenly() {
        let lines = vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()];
        let cues = vec![cue(0, "zzz"), cue(9000, "yyy")];
        let (out, coverage) = align_lyrics(&lines, &cues, 12_000);
        assert_eq!(out.len(), 3);
        assert_eq!(coverage, 0.0);
        assert!(out[0].time_ms < out[1].time_ms && out[1].time_ms < out[2].time_ms);
    }

    #[test]
    fn align_carries_word_timing_when_word_counts_match() {
        let lines = vec!["hello world".to_string()];
        let mut raw = cue(1000, "hello world");
        raw.end_ms = Some(2000);
        raw.words = Some(vec![word("hello", 1000, 1400), word("world", 1500, 2000)]);
        let (out, _) = align_lyrics(&lines, &[raw], 5000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].end_ms, Some(2000));
        let words = out[0].words.as_ref().expect("word timing should carry through");
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "hello");
        assert_eq!(words[0].start_ms, 1000);
        assert_eq!(words[1].word, "world");
        assert_eq!(words[1].end_ms, 2000);
    }

    #[test]
    fn align_drops_word_timing_on_a_word_count_mismatch() {
        // Real line is one word ("goodbye"); Whisper misheard it as two
        // ("good", "bye"). Positional word-timing mapping would be nonsense
        // here, so it must be left for renderer.js's own fallback instead.
        let lines = vec!["goodbye".to_string()];
        let mut raw = cue(1000, "good bye");
        raw.words = Some(vec![word("good", 1000, 1300), word("bye", 1300, 1700)]);
        let (out, _) = align_lyrics(&lines, &[raw], 5000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "goodbye");
        assert!(out[0].words.is_none());
    }

    #[test]
    fn align_leaves_word_timing_none_on_interpolated_lines() {
        // Only the first line anchors directly; the second has no raw cue of
        // its own to draw word timing from.
        let lines = vec!["hello world".to_string(), "unmatched line here".to_string()];
        let mut raw = cue(1000, "hello world");
        raw.words = Some(vec![word("hello", 1000, 1400), word("world", 1500, 2000)]);
        let (out, _) = align_lyrics(&lines, &[raw], 10_000);
        assert_eq!(out.len(), 2);
        assert!(out[0].words.is_some());
        assert!(out[1].words.is_none());
    }

    #[test]
    fn attach_word_timings_keeps_trusted_text_and_time() {
        // LRCLIB says this line starts at 1000ms. Whisper's own clock is off
        // (5000ms) but its transcript matches word-for-word — only the words
        // should be borrowed, never the line's trusted start time.
        let existing = vec![cue(1000, "hello world")];
        let mut raw = cue(5000, "hello world");
        raw.words = Some(vec![word("hello", 5000, 5400), word("world", 5500, 6000)]);
        let out = attach_word_timings(existing, &[raw], 10_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].time_ms, 1000, "trusted LRCLIB timing must not move");
        assert_eq!(out[0].text, "hello world");
        let words = out[0].words.as_ref().expect("word timing should attach");
        assert_eq!(words[0].start_ms, 5000);
    }

    #[test]
    fn attach_word_timings_leaves_unanchored_lines_untouched() {
        let existing = vec![cue(1000, "hello world"), cue(4000, "totally different line")];
        let mut raw = cue(1000, "hello world");
        raw.words = Some(vec![word("hello", 1000, 1400), word("world", 1500, 2000)]);
        let out = attach_word_timings(existing, &[raw], 10_000);
        assert_eq!(out.len(), 2);
        assert!(out[0].words.is_some());
        assert_eq!(out[1].time_ms, 4000);
        assert_eq!(out[1].text, "totally different line");
        assert!(out[1].words.is_none(), "no raw cue anchored to this line — must stay untouched, not guessed");
    }

    #[test]
    fn attach_word_timings_preserves_existing_words_when_new_pass_finds_nothing() {
        // A line that already carries real words from a previous pass must not
        // lose them just because this pass's raw transcript didn't re-anchor it.
        let mut existing_line = cue(1000, "hello world");
        existing_line.words = Some(vec![word("hello", 900, 1200), word("world", 1200, 1600)]);
        let existing = vec![existing_line];
        let out = attach_word_timings(existing, &[], 10_000);
        assert_eq!(out.len(), 1);
        assert!(out[0].words.is_some());
    }
}
