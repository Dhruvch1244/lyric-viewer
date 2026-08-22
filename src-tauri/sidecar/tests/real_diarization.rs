//! End-to-end speaker diarization against real music, driving the real binary.
//!
//! `#[ignore]`d, because it needs the ~25 MB speaker-embedding model and an
//! audio fixture that CI does not have. It is the test that would actually
//! settle the open question in `docs/JOB-ENGINE.md` §5.8: the pipeline is
//! verified against *synthetic tones* — deterministic output, and a
//! same-signal pair scoring higher than a different-signal pair — but nobody
//! has run it on two real singing voices over a real mix, which is the only
//! thing it exists to do.
//!
//! Run it with:
//!
//! ```text
//! cargo test -p lyric-inference --test real_diarization -- --ignored --nocapture
//! ```
//!
//! Provide raw f32 mono 16 kHz PCM at `LYRIC_TEST_PCM` and the model directory
//! at `LYRIC_TEST_MODELS`. To make the PCM from an mp3, see the
//! `write_pcm_fixture` tool in the app crate's `analysis.rs` — that crate owns
//! the decoder, this one deliberately does not.
//!
//! **Read the printed timeline, not just the pass/fail.** A duo trading verses
//! should produce runs of seconds, alternating a handful of times across the
//! track. Output that alternates every window, or collapses to one speaker for
//! the whole song, is the interesting result — and it is the kind of thing an
//! assertion threshold cannot tell you on its own.

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
#[ignore = "needs the speaker-embedding model and a PCM fixture; see the module docs"]
fn real_audio_is_split_into_speakers() {
    let pcm_path = std::env::var("LYRIC_TEST_PCM").expect("set LYRIC_TEST_PCM to a raw f32 mono 16kHz file");
    let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS to the model directory");

    // Opt-in, because it only holds for a track known to have two or more
    // voices. Left off for a solo track, where one cluster is the correct
    // answer and asserting otherwise would be nonsense.
    let expect_multiple = std::env::var("LYRIC_TEST_EXPECT_SPEAKERS").ok().and_then(|v| v.parse::<usize>().ok());

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

    let started = std::time::Instant::now();
    write_frame(&mut w, &Request::Diarize { job_id: 1, pcm_path, sample_rate: 16_000, model_dir }).unwrap();

    let spans = loop {
        match read_frame::<_, Response>(&mut r).unwrap() {
            Some(Response::Progress { stage, pct, .. }) => println!("progress: {stage:?} {pct}%"),
            Some(Response::Diarized { spans, .. }) => break spans,
            Some(Response::Error { message, .. }) => panic!("sidecar reported: {message}"),
            other => panic!("unexpected frame: {other:?}"),
        }
    };
    let elapsed = started.elapsed();

    assert!(!spans.is_empty(), "no speaker spans at all");

    // The timeline, which is the actual deliverable of this test.
    println!("\n--- speaker timeline ---");
    for s in &spans {
        let secs = |ms: u32| format!("{}:{:02}", ms / 60_000, (ms % 60_000) / 1000);
        println!(
            "  speaker {}  {:>6} .. {:>6}   ({:.1}s)",
            s.speaker,
            secs(s.start_ms),
            secs(s.end_ms),
            (s.end_ms - s.start_ms) as f64 / 1000.0
        );
    }

    let mut ids: Vec<u32> = spans.iter().map(|s| s.speaker).collect();
    ids.sort_unstable();
    ids.dedup();

    let total_ms: u32 = spans.iter().map(|s| s.end_ms - s.start_ms).sum();
    println!("\n{} span(s), {} distinct speaker(s), {:.1}s covered, in {elapsed:?}", spans.len(), ids.len(), total_ms as f64 / 1000.0);
    for id in &ids {
        let held: u32 = spans.iter().filter(|s| s.speaker == *id).map(|s| s.end_ms - s.start_ms).sum();
        println!("  speaker {id}: {:.1}s ({:.0}%)", held as f64 / 1000.0, held as f64 / total_ms.max(1) as f64 * 100.0);
    }

    /* ---------------------------------------------- structural invariants --- */

    assert!(ids.len() <= 6, "clustering exceeded MAX_SPEAKERS: {ids:?}");
    assert_eq!(*ids.first().unwrap(), 0, "cluster ids must start at 0, got {ids:?}");
    assert!(
        ids.windows(2).all(|p| p[1] == p[0] + 1),
        "cluster ids must be contiguous — a gap means a cluster was created and never assigned: {ids:?}"
    );

    for s in &spans {
        assert!(s.end_ms > s.start_ms, "empty or inverted span: {s:?}");
    }
    for pair in spans.windows(2) {
        assert!(pair[1].start_ms >= pair[0].start_ms, "spans out of order: {pair:?}");
        assert!(pair[1].start_ms >= pair[0].end_ms, "spans overlap: {pair:?}");
        // Touching spans must differ; spans either side of a silence may not,
        // because merge_adjacent deliberately refuses to bridge a gap the VAD
        // found no voice in.
        if pair[1].start_ms == pair[0].end_ms {
            assert_ne!(pair[0].speaker, pair[1].speaker, "contiguous spans share a speaker — merge_adjacent did not run: {pair:?}");
        }
    }

    /* -------------------------------------------------- the real question --- */

    // Shut the sidecar down before asserting, so a failure below cannot leave
    // a process holding a model in memory.
    let _ = write_frame(&mut w, &Request::Shutdown);
    let _ = child.wait();

    // Attribute most of what it was given, or say nothing useful happened.
    //
    // This exists because the first version of this test passed while the run
    // was plainly broken: a too-strict threshold produced "6 distinct
    // speakers" over 4.3 seconds of a 304-second track and every structural
    // assertion above was still satisfied. Counting speakers is not evidence
    // of a working diarizer; covering the audio with them is.
    let first = spans.first().unwrap().start_ms;
    let last = spans.last().unwrap().end_ms;
    let covered: u32 = spans.iter().map(|s| s.end_ms - s.start_ms).sum();
    let reach = last.saturating_sub(first).max(1);
    assert!(
        covered * 100 / reach >= 60,
        "spans cover only {covered}ms of the {reach}ms they span — the clustering is declining \
         most windows, not diarizing them"
    );
    assert!(
        reach >= 60_000,
        "diarization reached only {reach}ms into the track; it gave up early rather than finishing"
    );

    if let Some(expected) = expect_multiple {
        assert!(
            ids.len() >= expected,
            "expected at least {expected} distinct speakers on this track, found {}. \
             Either the clustering threshold (SIMILARITY_THRESHOLD in diarize.rs) is wrong for \
             singing over a dense mix, or the embedding is dominated by the instrumental rather \
             than the voice. Both are real findings — see the timeline above.",
            ids.len()
        );
    }
}
