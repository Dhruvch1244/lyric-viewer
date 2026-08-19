//! The inference sidecar.
//!
//! A separate process from the app, on purpose (JOB-ENGINE section 2.2):
//!
//! - An ORT segfault or an out-of-memory kills this and nothing else. In the
//!   WebView path it took the whole app with it.
//! - Memory is returned to the OS on exit. An allocator that has grown to hold
//!   a Whisper graph rarely gives it back inside a long-lived process.
//! - Priority is settable at process level, CPU *and* I/O — see `priority`.
//! - It can use every core. The WASM path it replaces is pinned to one thread
//!   because the asset protocol sets no COOP/COEP, so there is no
//!   `SharedArrayBuffer` and therefore no WASM threads.
//!
//! It speaks the framed stdio protocol in the `inference-protocol` crate.
//! stdout is the protocol channel and carries nothing else — anything printed
//! there that is not a frame corrupts the stream, so all logging goes to
//! stderr, which the host drains separately.

mod pcm;
mod priority;

use std::io::{BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use inference_protocol::{read_frame, write_frame, Request, Response, Stage, PROTOCOL_VERSION};

/// Everything the worker needs for one transcription.
struct Job {
    job_id: u64,
    pcm_path: String,
    sample_rate: u32,
    model_dir: String,
    language: Option<String>,
    vad: bool,
    cancel: Arc<AtomicBool>,
}

/// stdout, shared: the reader thread answers `Hello` and `Shutdown` while the
/// worker is emitting progress for a job, so both need to write frames. A
/// mutex rather than a channel because frames must not interleave — a partial
/// frame from one writer inside another's is unrecoverable garbage.
type Out = Arc<Mutex<BufWriter<std::io::Stdout>>>;

/// The job the worker is on, and the flag that stops it. `None` between jobs.
/// Shared so `Cancel`, which arrives on the reader thread, can reach a job
/// already running on the worker.
type CurrentJob = Arc<Mutex<Option<(u64, Arc<AtomicBool>)>>>;

fn send(out: &Out, msg: &Response) {
    let mut w = out.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = write_frame(&mut *w, msg) {
        // The host is gone or the pipe broke. Nothing to recover to — the
        // process exists to serve that one peer.
        eprintln!("[sidecar] cannot write to host: {e}");
    }
}

fn main() {
    priority::deprioritise();

    let out: Out = Arc::new(Mutex::new(BufWriter::new(std::io::stdout())));
    let (tx, rx) = mpsc::channel::<Job>();

    // Concurrency 1, structurally. Two Whisper sessions at once thrash cache
    // and memory for no throughput gain, and a second Demucs graph would
    // roughly double an already >1GB footprint — so the sidecar cannot run
    // two jobs even if the host asks, rather than relying on the host's
    // Inference lane semaphore to be the only guard.
    let worker_out = Arc::clone(&out);
    let worker = std::thread::Builder::new()
        .name("inference".into())
        .spawn(move || {
            for job in rx {
                run_job(job, &worker_out);
            }
        })
        .expect("cannot start the inference worker");

    let current: CurrentJob = Arc::new(Mutex::new(None));

    let mut reader = BufReader::new(std::io::stdin());
    loop {
        let req = match read_frame::<_, Request>(&mut reader) {
            Ok(Some(req)) => req,
            // Clean close: the host exited or dropped the pipe. Normal.
            Ok(None) => break,
            Err(e) => {
                eprintln!("[sidecar] malformed request stream: {e}");
                break;
            }
        };

        match req {
            Request::Hello { version } => {
                if version != PROTOCOL_VERSION {
                    // Answer anyway with our own version so the host can say
                    // something specific; it decides whether to proceed.
                    eprintln!("[sidecar] host speaks protocol {version}, this binary speaks {PROTOCOL_VERSION}");
                }
                send(&out, &Response::Ready { version: PROTOCOL_VERSION, runtime: runtime_description() });
            }
            Request::Transcribe { job_id, pcm_path, sample_rate, model_dir, language, vad } => {
                let cancel = Arc::new(AtomicBool::new(false));
                *current.lock().unwrap() = Some((job_id, Arc::clone(&cancel)));
                let job = Job { job_id, pcm_path, sample_rate, model_dir, language, vad, cancel };
                if tx.send(job).is_err() {
                    send(&out, &Response::Error { job_id, message: "inference worker is gone".into() });
                    break;
                }
            }
            Request::Cancel { job_id } => {
                // Cooperative: this stops the next span being started, it does
                // not interrupt a model run already in flight.
                if let Some((running, flag)) = current.lock().unwrap().as_ref() {
                    if *running == job_id {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            Request::Shutdown => {
                if let Some((_, flag)) = current.lock().unwrap().as_ref() {
                    flag.store(true, Ordering::SeqCst);
                }
                send(&out, &Response::Bye);
                break;
            }
        }
    }

    // Dropping the sender ends the worker's `for job in rx`, so joining is a
    // real wait for the current job to notice cancellation and return —
    // not a hang, and not a kill mid-write either.
    drop(tx);
    let _ = worker.join();
    let mut w = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = w.flush();
}

/// What this binary is, for the host's log and the `Ready` handshake.
fn runtime_description() -> String {
    format!("onnxruntime {}", ort::info())
}

fn run_job(job: Job, out: &Out) {
    let Job { job_id, pcm_path, sample_rate, model_dir, language, vad, cancel } = job;

    if sample_rate != pcm::REQUIRED_SAMPLE_RATE {
        send(
            out,
            &Response::Error {
                job_id,
                message: format!("PCM is {sample_rate} Hz; this expects {} Hz (the host resamples)", pcm::REQUIRED_SAMPLE_RATE),
            },
        );
        return;
    }

    let audio = match pcm::Pcm::open(std::path::Path::new(&pcm_path)) {
        Ok(a) => a,
        Err(e) => {
            send(out, &Response::Error { job_id, message: e });
            return;
        }
    };
    // Peak is worth a line in the log before anything expensive happens: a
    // capture that recorded silence (wrong loopback device, muted output)
    // produces an empty transcription that looks exactly like a model
    // failure, and this distinguishes the two in one number.
    let samples = audio.samples();
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    eprintln!(
        "[sidecar] job {job_id}: {} samples ({} ms), peak {peak:.4}, vad={vad}, lang={language:?}",
        audio.len(),
        audio.duration_ms(sample_rate)
    );
    if peak < 1e-4 {
        send(out, &Response::Error { job_id, message: format!("audio is silent (peak {peak:.6}) — nothing to transcribe") });
        return;
    }

    if cancel.load(Ordering::SeqCst) {
        send(out, &Response::Error { job_id, message: "cancelled".into() });
        return;
    }

    send(out, &Response::Progress { job_id, stage: Stage::LoadingModel, pct: 0 });

    // The model half lands in the next commits of this phase — VAD first,
    // then the Whisper pipeline. Until then this reports a specific failure
    // rather than pretending, so the host's fallback path is exercised by the
    // real binary rather than only by a test double.
    let _ = model_dir;
    send(
        out,
        &Response::Error { job_id, message: "transcription backend not built into this sidecar yet".into() },
    );
}
