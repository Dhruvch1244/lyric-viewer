//! The vocal-isolation retry, end to end against the real binary.
//!
//! This is the test that proves JOB-ENGINE §5.10 actually works, and it is
//! built around the measurement that motivated it: on an EDM track with a sung
//! hook, Silero finds **0% voiced** in the mix and **72%** once the vocal is
//! separated (`vad.rs`'s module doc). So the sidecar must
//!
//! 1. answer `NeedsIsolation` rather than an error on the first attempt, and
//! 2. actually produce cues on the second, with `isolate: true`.
//!
//! A pass means a whole class of song went from untranscribable to
//! transcribable. `#[ignore]`d because it needs the Whisper set *and* the
//! 165MB isolation model, and takes a couple of minutes.
//!
//! ```text
//! LYRIC_TEST_PCM=<edm-mix.pcm> LYRIC_TEST_MODELS=<dir> \
//!   cargo test --release -p lyric-inference --test real_isolation -- --ignored --nocapture
//! ```

use std::io::{BufReader, BufWriter};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use inference_protocol::{read_frame, write_frame, Request, Response, PROTOCOL_VERSION};

fn sidecar_binary() -> std::path::PathBuf {
    let mut dir = std::env::current_exe().expect("no test binary path");
    dir.pop();
    if dir.ends_with("deps") {
        dir.pop();
    }
    dir.join(if cfg!(windows) { "lyric-inference.exe" } else { "lyric-inference" })
}

struct Sidecar {
    child: Child,
    w: BufWriter<ChildStdin>,
    r: BufReader<ChildStdout>,
}

impl Sidecar {
    fn start() -> Self {
        let mut child = Command::new(sidecar_binary())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // its own timings are half the point
            .spawn()
            .expect("cannot spawn the sidecar");
        let w = BufWriter::new(child.stdin.take().unwrap());
        let r = BufReader::new(child.stdout.take().unwrap());
        let mut s = Self { child, w, r };
        write_frame(&mut s.w, &Request::Hello { version: PROTOCOL_VERSION }).unwrap();
        match s.recv() {
            Response::Ready { version, runtime } => {
                assert_eq!(version, PROTOCOL_VERSION);
                println!("sidecar ready: {runtime}");
            }
            other => panic!("expected Ready, got {other:?}"),
        }
        s
    }

    fn recv(&mut self) -> Response {
        read_frame::<_, Response>(&mut self.r).expect("stream broke").expect("sidecar closed early")
    }

    /// Drain progress frames and return the first real answer.
    fn outcome(&mut self) -> Response {
        loop {
            match self.recv() {
                Response::Progress { stage, pct, .. } => println!("  progress: {stage:?} {pct}%"),
                other => return other,
            }
        }
    }
}

#[test]
#[ignore = "needs the Whisper set + the 165MB isolation model and a PCM fixture; see the module docs"]
fn a_track_the_vad_cannot_hear_is_rescued_by_isolating_the_vocal() {
    let pcm_path = std::env::var("LYRIC_TEST_PCM").expect("set LYRIC_TEST_PCM to a raw f32 mono 16kHz mix");
    let model_dir = std::env::var("LYRIC_TEST_MODELS").expect("set LYRIC_TEST_MODELS");

    let mut s = Sidecar::start();

    // --- first attempt: the mix, exactly as the host sends it today ---
    println!("\n--- attempt 1: the mix ---");
    write_frame(
        &mut s.w,
        &Request::Transcribe {
            job_id: 1,
            pcm_path: pcm_path.clone(),
            sample_rate: 16_000,
            model_dir: model_dir.clone(),
            language: None,
            vad: true,
            isolate: false,
        },
    )
    .unwrap();

    match s.outcome() {
        Response::NeedsIsolation { job_id } => {
            assert_eq!(job_id, 1);
            println!("asked for isolation, as it should — the VAD heard nothing in the mix");
        }
        Response::Result { cues, .. } => {
            panic!("this fixture is supposed to be one the VAD cannot hear, but it transcribed {} cue(s)", cues.len())
        }
        other => panic!("expected NeedsIsolation, got {other:?}"),
    }

    // --- second attempt: the same audio, vocal separated first ---
    println!("\n--- attempt 2: with isolation ---");
    let started = std::time::Instant::now();
    write_frame(
        &mut s.w,
        &Request::Transcribe {
            job_id: 2,
            pcm_path,
            sample_rate: 16_000,
            model_dir,
            language: None,
            vad: true,
            isolate: true,
        },
    )
    .unwrap();

    let cues = match s.outcome() {
        Response::Result { cues, .. } => cues,
        Response::NeedsIsolation { .. } => panic!("asked for isolation twice — the retry flag did not take"),
        Response::Error { message, .. } => panic!("isolation retry failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };
    println!("\ntranscribed in {:?}", started.elapsed());
    for cue in cues.iter().take(20) {
        println!("  [{:>6}..{:>6}] {}", cue.time_ms, cue.end_ms, cue.text);
    }

    // The whole point: a track that produced nothing now produces words.
    assert!(!cues.is_empty(), "isolation produced no cues at all");
    let text: String = cues.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ");
    assert!(
        text.chars().filter(|c| c.is_alphabetic()).count() >= 20,
        "got cues but almost no words, which is what a hallucination over silence looks like: {text:?}"
    );

    let _ = write_frame(&mut s.w, &Request::Shutdown);
    let _ = s.child.wait();
}
