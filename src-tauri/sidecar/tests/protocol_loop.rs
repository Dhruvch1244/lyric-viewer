//! Drives the real sidecar binary as a child process.
//!
//! The unit tests cover framing and PCM mapping in isolation; this covers the
//! thing they cannot — that an actual spawned process reads its stdin, writes
//! well-formed frames to its stdout, and exits when told. Every failure mode
//! this catches (a stray `println!` corrupting the stream, a deadlock between
//! the reader and the worker, a process that never exits) is invisible to a
//! unit test because it only exists once there is a real process and real
//! pipes.

use std::io::{BufReader, BufWriter, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use inference_protocol::{read_frame, write_frame, Request, Response, PROTOCOL_VERSION};

struct Sidecar {
    child: Child,
    /// An `Option` so a test can drop it to close the pipe, which is how the
    /// app exiting actually looks from the sidecar's side.
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    fn start() -> Sidecar {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lyric-inference"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, not piped: nobody drains it in this test, and a piped
            // stderr that fills its buffer would block the child mid-log.
            .stderr(Stdio::inherit())
            .spawn()
            .expect("cannot spawn the sidecar binary");
        let stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Sidecar { child, stdin, stdout }
    }

    fn send(&mut self, req: &Request) {
        let stdin = self.stdin.as_mut().expect("stdin already closed");
        write_frame(stdin, req).expect("cannot write a request");
        stdin.flush().unwrap();
    }

    /// Close the request pipe, as a quitting app would.
    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn recv(&mut self) -> Response {
        read_frame::<_, Response>(&mut self.stdout).expect("malformed response stream").expect("sidecar closed the pipe early")
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_pcm(name: &str, samples: &[f32]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(name);
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A second of a 220 Hz tone — not speech, but unambiguously not silence.
fn tone(seconds: usize) -> Vec<f32> {
    let sr = 16_000usize;
    (0..sr * seconds).map(|i| (i as f32 / sr as f32 * std::f32::consts::TAU * 220.0).sin() * 0.4).collect()
}

fn transcribe(job_id: u64, path: &std::path::Path) -> Request {
    Request::Transcribe {
        job_id,
        pcm_path: path.to_string_lossy().into_owned(),
        sample_rate: 16_000,
        model_dir: std::env::temp_dir().to_string_lossy().into_owned(),
        language: Some("en".into()),
        vad: true,
        isolate: false,
    }
}

#[test]
fn answers_the_handshake_with_its_protocol_version() {
    let mut s = Sidecar::start();
    s.send(&Request::Hello { version: PROTOCOL_VERSION });
    match s.recv() {
        Response::Ready { version, runtime } => {
            assert_eq!(version, PROTOCOL_VERSION);
            // Proves ORT is linked and callable in the spawned process, not
            // merely that the crate compiled.
            assert!(runtime.contains("onnxruntime"), "expected an ORT runtime string, got {runtime:?}");
        }
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn exits_cleanly_on_shutdown() {
    let mut s = Sidecar::start();
    s.send(&Request::Shutdown);
    assert!(matches!(s.recv(), Response::Bye));
    let status = s.child.wait().expect("sidecar never exited");
    assert!(status.success(), "sidecar exited with {status:?}");
}

#[test]
fn exits_when_the_host_closes_the_pipe() {
    // How it actually ends most of the time: the app quits without a polite
    // Shutdown. The sidecar must not linger as an orphan process.
    let mut s = Sidecar::start();
    s.send(&Request::Hello { version: PROTOCOL_VERSION });
    let _ = s.recv();

    s.close_stdin();
    let status = s.child.wait().expect("sidecar never exited after its stdin closed");
    assert!(status.success(), "sidecar exited with {status:?}");
}

#[test]
fn reports_silent_audio_as_such_rather_than_as_a_model_failure() {
    let path = write_pcm("lyric-sidecar-silence.pcm", &vec![0.0f32; 16_000]);
    let mut s = Sidecar::start();
    s.send(&transcribe(7, &path));

    match s.recv() {
        Response::Error { job_id, message } => {
            assert_eq!(job_id, 7);
            assert!(message.contains("silent"), "expected a silence diagnosis, got {message:?}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn maps_real_audio_and_reaches_the_model_step() {
    // No model files are staged for this test (model_dir is a bare temp
    // directory), so the expected outcome is a specific "model file not
    // found" error rather than a real transcription. What this proves is
    // everything before that point: the PCM file was mapped, the peak check
    // passed, progress was reported, and the missing VAD model downgraded
    // silently (§7.5) instead of failing the job — leaving Whisper::load as
    // the actual point of failure, named precisely rather than opaquely.
    let path = write_pcm("lyric-sidecar-tone.pcm", &tone(2));
    let mut s = Sidecar::start();
    s.send(&transcribe(9, &path));

    let mut saw_loading = false;
    loop {
        match s.recv() {
            Response::Progress { job_id, .. } => {
                assert_eq!(job_id, 9);
                saw_loading = true;
            }
            Response::Error { job_id, message } => {
                assert_eq!(job_id, 9);
                assert!(
                    message.contains("model file not found"),
                    "unexpected failure before the model step: {message:?}"
                );
                break;
            }
            other => panic!("expected Progress or Error, got {other:?}"),
        }
    }
    assert!(saw_loading, "the job never reported progress");
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_bad_sample_rate_is_refused_before_the_file_is_touched() {
    let mut s = Sidecar::start();
    s.send(&Request::Transcribe {
        job_id: 3,
        pcm_path: "C:\\nonexistent\\never-opened.pcm".into(),
        sample_rate: 44_100,
        model_dir: String::new(),
        language: None,
        vad: false,
        isolate: false,
    });
    match s.recv() {
        Response::Error { job_id, message } => {
            assert_eq!(job_id, 3);
            assert!(message.contains("16000"), "expected the required rate in the message, got {message:?}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn survives_a_missing_pcm_file_and_keeps_serving() {
    let mut s = Sidecar::start();
    s.send(&transcribe(1, std::path::Path::new("C:\\nonexistent\\missing.pcm")));
    assert!(matches!(s.recv(), Response::Error { job_id: 1, .. }));

    // Still alive and still answering — one bad job must not end the process,
    // or every subsequent transcription pays a respawn.
    s.send(&Request::Hello { version: PROTOCOL_VERSION });
    assert!(matches!(s.recv(), Response::Ready { .. }));
}
