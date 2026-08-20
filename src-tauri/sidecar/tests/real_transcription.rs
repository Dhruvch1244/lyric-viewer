//! End-to-end transcription against real speech, driving the real binary.
//!
//! `#[ignore]`d, because it needs ~79 MB of downloaded model files that CI does
//! not have. It is the test that actually proves the pipeline works, though —
//! mel, VAD, encoder, decoder and DTW together, over a protocol connection to
//! a spawned process, exactly as the app uses it.
//!
//! Run it with:
//!
//! ```text
//! cargo test -p lyric-inference --test real_transcription -- --ignored --nocapture
//! ```
//!
//! Provide the audio as raw f32 mono 16 kHz PCM at `LYRIC_TEST_PCM`, and the
//! model directory at `LYRIC_TEST_MODELS`. `scripts/make-speech-fixture.ps1`
//! writes a suitable file using the Windows speech synthesiser, which is what
//! this was developed against — known words, known order, no licensing
//! question, and available on every machine this app targets.

use std::io::{BufReader, BufWriter};
use std::process::{Command, Stdio};

use inference_protocol::{read_frame, write_frame, Request, Response, PROTOCOL_VERSION};

fn sidecar_binary() -> std::path::PathBuf {
    // The integration-test binary sits in target/<profile>/deps.
    let mut dir = std::env::current_exe().expect("no test binary path");
    dir.pop();
    if dir.ends_with("deps") {
        dir.pop();
    }
    dir.join(if cfg!(windows) { "lyric-inference.exe" } else { "lyric-inference" })
}

#[test]
#[ignore = "needs downloaded models and a PCM fixture; see the module docs"]
fn real_speech_is_transcribed_with_word_timing() {
    let pcm_path = std::env::var("LYRIC_TEST_PCM").expect("set LYRIC_TEST_PCM to a raw f32 mono 16kHz file");
    let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS to the model directory");

    let mut child = Command::new(sidecar_binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // the sidecar's own timings are the point
        .spawn()
        .expect("cannot spawn the sidecar");

    let mut w = BufWriter::new(child.stdin.take().unwrap());
    let mut r = BufReader::new(child.stdout.take().unwrap());

    write_frame(&mut w, &Request::Hello { version: PROTOCOL_VERSION }).unwrap();
    match read_frame::<_, Response>(&mut r).unwrap() {
        Some(Response::Ready { version, runtime }) => {
            assert_eq!(version, PROTOCOL_VERSION);
            println!("sidecar ready: {runtime}");
        }
        other => panic!("expected Ready, got {other:?}"),
    }

    write_frame(
        &mut w,
        &Request::Transcribe {
            job_id: 1,
            pcm_path,
            sample_rate: 16_000,
            model_dir,
            language: Some("en".into()),
            vad: true,
        },
    )
    .unwrap();

    let cues = loop {
        match read_frame::<_, Response>(&mut r).unwrap() {
            Some(Response::Progress { stage, pct, .. }) => println!("progress: {stage:?} {pct}%"),
            Some(Response::Result { cues, .. }) => break cues,
            Some(Response::Error { message, .. }) => panic!("sidecar reported: {message}"),
            other => panic!("unexpected frame: {other:?}"),
        }
    };

    for cue in &cues {
        println!("[{:>6}..{:>6}] {}", cue.time_ms, cue.end_ms, cue.text);
        for word in &cue.words {
            println!("    {:>6}..{:>6}  {}", word.start_ms, word.end_ms, word.word);
        }
    }

    let text = cues.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ").to_lowercase();
    assert!(!cues.is_empty(), "no cues at all");

    // The fixture's words, in order. Checked individually rather than as one
    // string so a single mis-heard word names itself in the failure.
    for expected in ["quick", "brown", "fox", "jumps", "lazy", "dog", "testing"] {
        assert!(text.contains(expected), "transcription is missing {expected:?}: {text:?}");
    }

    // Timing must be measured, not invented.
    //
    // This is not a formality: an earlier version of the pipeline passed a
    // weaker form of exactly this check (monotonic, >2s total span) while
    // every word from the third on was silently collapsed onto the SAME
    // timestamp — non-decreasing and spanning >2s is true of "290, 690, 690,
    // 690, 690, 690, 690, 690, 690, 690, 6990" too. The bug was two things
    // stacked: (1) the priming pass's attention was being merged into the
    // per-token rows `build_attention` reads, so every real token's alignment
    // was reading the row belonging to the token 4 positions earlier; (2)
    // Silero VAD was being fed bare 512-sample windows with no trailing
    // context, so it never even fired above 0.12 on real speech. Both are
    // fixed and covered by their own unit tests (whisper.rs, vad.rs), but
    // THIS is the test that would have caught the compound failure, so its
    // assertions have to be strong enough to actually fail on it.
    let words: Vec<_> = cues.iter().flat_map(|c| c.words.iter()).collect();
    assert!(words.len() >= 7, "expected per-word timing, got {} words", words.len());

    let mut distinct_starts: Vec<u32> = words.iter().map(|w| w.start_ms).collect();
    distinct_starts.dedup();
    assert!(
        distinct_starts.len() >= words.len() - 1,
        "words collapsed onto shared timestamps: {:?}",
        words.iter().map(|w| (w.word.as_str(), w.start_ms)).collect::<Vec<_>>()
    );

    for pair in words.windows(2) {
        assert!(pair[1].start_ms >= pair[0].start_ms, "words out of order: {pair:?}");
        let gap = pair[1].start_ms.saturating_sub(pair[0].end_ms);
        // A word this synthesiser speaks is on the order of 200-800ms.
        // Real timing scatters between words; degenerate timing (everything
        // dumped at one boundary) does not.
        assert!(gap < 3_000, "improbable gap between consecutive words: {pair:?}");
    }
    let span = words.last().unwrap().end_ms - words[0].start_ms;
    assert!(span > 2_000, "all the words landed on top of each other: {span} ms");
    assert!(span < 8_500, "words spilled past the end of an 8s clip: {span} ms");

    let _ = write_frame(&mut w, &Request::Shutdown);
    let _ = child.wait();
}
