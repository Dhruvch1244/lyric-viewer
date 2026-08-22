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

mod demucs;
mod diarize;
mod dtw;
mod fbank;
mod mel;
mod pcm;
mod priority;
mod vad;
mod whisper;

use std::io::{BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use inference_protocol::{read_frame, write_frame, Cue, Request, Response, SpeakerSpan, Span, Stage, PROTOCOL_VERSION};

/// Everything the worker needs for one job. Two variants rather than two
/// channels: both need the same "concurrency 1 on a dedicated worker thread"
/// property (a second ONNX graph loaded at once roughly doubles an already
/// large footprint), and one channel is the simplest way to guarantee it.
enum Job {
    Transcribe {
        job_id: u64,
        pcm_path: String,
        sample_rate: u32,
        model_dir: String,
        language: Option<String>,
        vad: bool,
        isolate: bool,
        cancel: Arc<AtomicBool>,
    },
    Diarize {
        job_id: u64,
        pcm_path: String,
        sample_rate: u32,
        model_dir: String,
        cancel: Arc<AtomicBool>,
    },
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
            Request::Transcribe { job_id, pcm_path, sample_rate, model_dir, language, vad, isolate } => {
                let cancel = Arc::new(AtomicBool::new(false));
                *current.lock().unwrap() = Some((job_id, Arc::clone(&cancel)));
                let job = Job::Transcribe { job_id, pcm_path, sample_rate, model_dir, language, vad, isolate, cancel };
                if tx.send(job).is_err() {
                    send(&out, &Response::Error { job_id, message: "inference worker is gone".into() });
                    break;
                }
            }
            Request::Diarize { job_id, pcm_path, sample_rate, model_dir } => {
                let cancel = Arc::new(AtomicBool::new(false));
                *current.lock().unwrap() = Some((job_id, Arc::clone(&cancel)));
                let job = Job::Diarize { job_id, pcm_path, sample_rate, model_dir, cancel };
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
    /*
      Leave background mode for the duration of the job, keeping
      BELOW_NORMAL_PRIORITY_CLASS.

      MEASURED, and it is not a small effect: one Demucs segment takes 4.46s
      at normal priority, 5.39s at BELOW_NORMAL, and **51.39s under
      PROCESS_MODE_BACKGROUND_BEGIN — 11.5x**. See
      `demucs::tests::priority_costs_throughput`. Background mode pins every
      thread to the lowest schedulable priority, which for a saturated ORT
      thread pool is a throttle rather than good manners, and on a job that
      runs for minutes it is the difference between "background work" and
      "never finishes".

      What is given up is background *I/O* priority during the model load —
      a few seconds of reads. What is kept is the guarantee that actually
      matters: BELOW_NORMAL means the app still outranks this process for
      CPU, which is what JOB-ENGINE §2.2 rests on. Background mode is
      restored between jobs, so an idle sidecar is still maximally polite.

      (The first write-up of this slowdown blamed denormal floats from real
      audio. That was wrong and the measurement above is what disproved it —
      `onnxruntime-node` ran the same real audio fast, so the audio was never
      the variable. Priority was.)
    */
    priority::end_background();
    match job {
        Job::Transcribe { job_id, pcm_path, sample_rate, model_dir, language, vad, isolate, cancel } => {
            run_transcribe_job(job_id, pcm_path, sample_rate, model_dir, language, vad, isolate, cancel, out)
        }
        Job::Diarize { job_id, pcm_path, sample_rate, model_dir, cancel } => {
            run_diarize_job(job_id, pcm_path, sample_rate, model_dir, cancel, out)
        }
    }
    priority::begin_background();
}

#[allow(clippy::too_many_arguments)]
fn run_transcribe_job(
    job_id: u64,
    pcm_path: String,
    sample_rate: u32,
    model_dir: String,
    language: Option<String>,
    vad: bool,
    isolate: bool,
    cancel: Arc<AtomicBool>,
    out: &Out,
) {
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

    // The retry path. `isolate` is never set on a first attempt — the host
    // turns it on only after this function answered `NeedsIsolation` below and
    // the user agreed to the download. Whatever comes back replaces the mix
    // for the rest of the job: the VAD needs the isolated vocal (that is the
    // whole point), and Whisper does better on it too.
    //
    // `samples` is rebound rather than shadowed inside a branch so everything
    // downstream is oblivious to which of the two it is holding.
    let samples: std::borrow::Cow<'_, [f32]> = if isolate {
        match isolate_vocals(job_id, &samples, &model_dir, &cancel, out) {
            Ok(v) => std::borrow::Cow::Owned(v),
            Err(message) => {
                send(out, &Response::Error { job_id, message });
                return;
            }
        }
    } else {
        std::borrow::Cow::Borrowed(&samples[..])
    };

    // Find the windows worth transcribing. Everything the model would only
    // hallucinate over is dropped here rather than filtered afterwards.
    let windows = match plan_work(job_id, &samples, &model_dir, vad, &cancel, out) {
        Ok(w) => w,
        Err(message) => {
            send(out, &Response::Error { job_id, message });
            return;
        }
    };
    if windows.is_empty() {
        // Measured (vad.rs's module doc): Silero scores a sung hook over dense
        // production flat zero, so "the detector found nothing" and "there is
        // nothing to find" are not the same statement and this code cannot
        // tell them apart. The peak check above already ruled out silence, so
        // there IS audio here — it just does not read as speech.
        if !isolate {
            // Say so, and let the host offer the one thing that fixes it.
            // Not an error: there is a specific, measured remedy, and only
            // the host can ask about the download it needs.
            eprintln!("[sidecar] job {job_id}: no voice in the mix; asking the host about vocal isolation");
            send(out, &Response::NeedsIsolation { job_id });
            return;
        }
        // Already tried it. Now the silence is the honest answer.
        send(
            out,
            &Response::Error {
                job_id,
                message: "could not pick out a voice in this track, even after separating the vocal — \
                          it may genuinely be instrumental"
                    .into(),
            },
        );
        return;
    }

    match transcribe(job_id, &samples, &windows, &model_dir, language.as_deref(), &cancel, out) {
        Ok(cues) => {
            eprintln!("[sidecar] job {job_id}: {} cue(s)", cues.len());
            send(out, &Response::Result { job_id, cues });
        }
        Err(message) => send(out, &Response::Error { job_id, message }),
    }
}

/// Separate the vocal from the mix, so the VAD has something it can hear.
///
/// **Loaded and dropped before Whisper is loaded at all**, which is the point
/// of it being its own function: htdemucs is a large graph and Whisper is
/// another, and holding both would double the peak inside a single job for no
/// reason — nothing needs the separator once it has produced its samples. The
/// sidecar is per-job so the OS reclaims everything on exit either way; this
/// is about the peak *during* the job.
fn isolate_vocals(
    job_id: u64,
    samples: &[f32],
    model_dir: &str,
    cancel: &AtomicBool,
    out: &Out,
) -> Result<Vec<f32>, String> {
    send(out, &Response::Progress { job_id, stage: Stage::IsolatingVocals, pct: 0 });
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let started = std::time::Instant::now();

    let vocals = {
        let mut model = demucs::Demucs::load(std::path::Path::new(model_dir), threads)?;
        model.isolate(
            samples,
            |pct| send(out, &Response::Progress { job_id, stage: Stage::IsolatingVocals, pct }),
            &|| cancel.load(Ordering::SeqCst),
        )?
        // `model` is dropped here, before the caller goes anywhere near Whisper.
    };

    let peak = vocals.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    eprintln!(
        "[sidecar] job {job_id}: isolated vocals in {:?} on {threads} thread(s), peak {peak:.4}",
        started.elapsed()
    );
    Ok(vocals)
}

/// Speaker diarization: embed the whole clip in overlapping windows and
/// cluster them (`diarize.rs`). Much simpler than transcription — no VAD
/// pass, no language, no decoder loop — because the model only ever sees
/// whichever window it is handed; the "song" structure lives entirely in how
/// those windows get clustered afterwards.
fn run_diarize_job(job_id: u64, pcm_path: String, sample_rate: u32, model_dir: String, cancel: Arc<AtomicBool>, out: &Out) {
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
    let samples = audio.samples();
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    eprintln!("[sidecar] job {job_id}: diarizing {} samples ({} ms), peak {peak:.4}", audio.len(), audio.duration_ms(sample_rate));
    if peak < 1e-4 {
        send(out, &Response::Error { job_id, message: format!("audio is silent (peak {peak:.6}) — nothing to diarize") });
        return;
    }
    if cancel.load(Ordering::SeqCst) {
        send(out, &Response::Error { job_id, message: "cancelled".into() });
        return;
    }

    send(out, &Response::Progress { job_id, stage: Stage::LoadingModel, pct: 0 });
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut model = match diarize::Diarizer::load(std::path::Path::new(&model_dir), threads) {
        Ok(m) => m,
        Err(message) => {
            send(out, &Response::Error { job_id, message });
            return;
        }
    };

    // Voice first. A speaker-embedding model has nothing useful to say about
    // an instrumental bar, but it does not say nothing — it returns an
    // unstable vector that clusters as if it were a person. See diarize.rs's
    // module doc for the run that established this.
    let voiced = match voiced_spans(job_id, &samples, &model_dir, &cancel, out) {
        Ok(v) => v,
        Err(message) => {
            send(out, &Response::Error { job_id, message });
            return;
        }
    };
    if voiced.is_empty() {
        // Same limit as transcription, same wording — see `plan_work`.
        send(
            out,
            &Response::Error {
                job_id,
                message: "could not pick out a voice in this track. Sung vocals over a dense mix often \
                          read as instrumental to the speech detector — turning on vocal isolation in \
                          settings usually gets it"
                    .into(),
            },
        );
        return;
    }

    send(out, &Response::Progress { job_id, stage: Stage::Diarizing, pct: 0 });
    let started = std::time::Instant::now();
    match model.diarize(&samples, &voiced, &|| cancel.load(Ordering::SeqCst)) {
        Ok(spans) => {
            eprintln!("[sidecar] job {job_id}: {} speaker span(s) in {:?}", spans.len(), started.elapsed());
            let spans =
                spans.into_iter().map(|s| SpeakerSpan { start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker }).collect();
            send(out, &Response::Diarized { job_id, spans });
        }
        Err(message) => send(out, &Response::Error { job_id, message }),
    }
}

/// The voiced stretches to diarize, or the whole clip if there is no VAD model.
///
/// Degrades rather than fails for the same reason `plan_work` does: the
/// detector is a quality guard, and a missing 2 MB file should make
/// diarization worse, not impossible. It is a much bigger quality guard here
/// than it is for transcription, though — without it the intro alone can
/// invent four speakers — so the fallback says so in the log.
fn voiced_spans(
    job_id: u64,
    samples: &[f32],
    model_dir: &str,
    cancel: &AtomicBool,
    out: &Out,
) -> Result<Vec<Span>, String> {
    let clip_ms = (samples.len() as u64 * 1000 / pcm::REQUIRED_SAMPLE_RATE as u64) as u32;
    let whole = vec![Span { start_ms: 0, end_ms: clip_ms }];

    let mut detector = match vad::SileroVad::load(std::path::Path::new(model_dir)) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[sidecar] job {job_id}: no VAD ({e}); diarizing the whole clip — expect clusters from instrumental passages");
            return Ok(whole);
        }
    };

    send(out, &Response::Progress { job_id, stage: Stage::DetectingSpeech, pct: 0 });
    let started = std::time::Instant::now();
    let spans = detector.spans(
        samples,
        |pct| send(out, &Response::Progress { job_id, stage: Stage::DetectingSpeech, pct }),
        &|| cancel.load(Ordering::SeqCst),
    )?;

    eprintln!(
        "[sidecar] job {job_id}: VAD found {} span(s), {} ms voiced of {clip_ms} ms ({}%), in {:?}",
        spans.len(),
        vad::total_ms(&spans),
        vad::total_ms(&spans) * 100 / clip_ms.max(1),
        started.elapsed()
    );
    Ok(spans)
}

/// Load the model and run every window through it.
///
/// One `Whisper` for the whole job, not one per window: loading a 77 MB pair
/// of graphs takes longer than transcribing a window with them.
fn transcribe(
    job_id: u64,
    samples: &[f32],
    windows: &[Span],
    model_dir: &str,
    language: Option<&str>,
    cancel: &AtomicBool,
    out: &Out,
) -> Result<Vec<Cue>, String> {
    let started = std::time::Instant::now();
    // All of them. The sidecar is already BELOW_NORMAL at process level, so
    // the OS scheduler — not a thread count — is what keeps it off the UI's
    // back, and leaving cores idle here only makes the job take longer.
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut model = whisper::Whisper::load(std::path::Path::new(model_dir), threads)?;
    let mut front_end = mel::MelSpectrogram::new(mel::N_MELS);
    eprintln!("[sidecar] job {job_id}: model loaded in {:?} on {threads} thread(s)", started.elapsed());

    send(out, &Response::Progress { job_id, stage: Stage::Transcribing, pct: 0 });

    let mut cues: Vec<Cue> = Vec::new();
    for (i, window) in windows.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let start = (window.start_ms as usize * mel::SAMPLE_RATE as usize / 1000).min(samples.len());
        let end = (window.end_ms as usize * mel::SAMPLE_RATE as usize / 1000).min(samples.len());
        if end <= start {
            continue;
        }

        let window_started = std::time::Instant::now();
        let produced = model.transcribe_window(
            &mut front_end,
            &samples[start..end],
            window.start_ms,
            language,
            &|| cancel.load(Ordering::SeqCst),
        )?;
        eprintln!(
            "[sidecar] job {job_id}: window {}/{} ({}..{} ms) -> {} cue(s) in {:?}",
            i + 1,
            windows.len(),
            window.start_ms,
            window.end_ms,
            produced.len(),
            window_started.elapsed()
        );
        cues.extend(produced);

        send(out, &Response::Progress {
            job_id,
            stage: Stage::Transcribing,
            pct: ((i + 1) * 100 / windows.len()) as u8,
        });
    }

    eprintln!("[sidecar] job {job_id}: transcription finished in {:?}", started.elapsed());
    Ok(cues)
}

/// Decide which stretches of the clip to transcribe.
///
/// **This cannot transcribe sung vocals over dense electronic production, and
/// the limit is Silero's, not the audio's.** Measured across three tracks —
/// see `vad.rs`'s module doc for the numbers. Rap scores p50 0.967 and works;
/// a sung hook over EDM scores flat zero through every bar it occupies.
///
/// Two candidate fixes were measured and **both rejected**:
///
/// - *Lower the trigger.* At 0.05 the sung track yields 3% of itself and the
///   floor is by then close to an instrumental track's noise.
/// - *Fall back to the whole clip when the VAD finds nothing.* A sung track
///   (max 0.472) is not separable from a genuinely instrumental one (max
///   0.314), so this would feed Whisper seven minutes of deadmau5 and get
///   confident invented lyrics back — reason 2 in `vad.rs`'s own doc.
///
/// So the caller says what happened and names the remedy (vocal isolation)
/// instead of reporting that the track has no speech in it. A real fix is
/// either Demucs ahead of the VAD — the app has it, but only in the WebView —
/// or a singing-voice detector in place of a speech one.
///
/// A missing VAD model is different and still downgrades to the whole clip:
/// that is a deployment problem, not a claim about the audio.
///
/// With the VAD available this is its speech spans, batched into 30 s windows.
/// Without it — the model file is missing, or the host asked for `vad: false`
/// — it is the whole clip in 30 s windows, which is what the WASM path does
/// today.
///
/// A missing VAD model **downgrades rather than fails**. The detector is an
/// optimisation and a hallucination guard; not having it makes transcription
/// slower and noisier, not impossible, and failing the whole job over a
/// missing 2 MB file would be the wrong trade.
fn plan_work(
    job_id: u64,
    samples: &[f32],
    model_dir: &str,
    vad_requested: bool,
    cancel: &AtomicBool,
    out: &Out,
) -> Result<Vec<Span>, String> {
    let whole = vec![Span { start_ms: 0, end_ms: (samples.len() as u64 * 1000 / pcm::REQUIRED_SAMPLE_RATE as u64) as u32 }];

    if !vad_requested {
        return Ok(vad::plan_windows(&whole));
    }

    let mut detector = match vad::SileroVad::load(std::path::Path::new(model_dir)) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[sidecar] job {job_id}: no VAD ({e}); transcribing the whole clip");
            return Ok(vad::plan_windows(&whole));
        }
    };

    send(out, &Response::Progress { job_id, stage: Stage::DetectingSpeech, pct: 0 });
    let started = std::time::Instant::now();
    let spans = detector.spans(
        samples,
        |pct| send(out, &Response::Progress { job_id, stage: Stage::DetectingSpeech, pct }),
        &|| cancel.load(Ordering::SeqCst),
    )?;

    let windows = vad::plan_windows(&spans);
    // The saving is the point of the pass, so it is reported as a number
    // rather than assumed. Voiced time is summed, not measured first-to-last.
    let clip_ms = whole[0].end_ms.max(1);
    eprintln!(
        "[sidecar] job {job_id}: VAD found {} span(s), {} ms voiced of {clip_ms} ms ({}%), batched into {} window(s), in {:?}",
        spans.len(),
        vad::total_ms(&spans),
        vad::total_ms(&spans) * 100 / clip_ms,
        windows.len(),
        started.elapsed()
    );
    Ok(windows)
}
