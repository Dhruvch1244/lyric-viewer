//! The job engine — one scheduler for every piece of background work.
//!
//! WHAT IT REPLACES. Before this, each background task was a bare
//! `std::thread::spawn`: `resolve_lyrics`, `resolve_artwork`, `resolve_mood`,
//! `resolve_attribution`, `presync`. Nothing knew about anything else, so
//! skipping through five tracks started five lyric fetches and five artwork
//! fan-outs, none of which could be deduplicated, prioritised, or stopped. The
//! work for a track you had already skipped past ran to completion, competing
//! with the work for the track you were actually listening to.
//!
//! THREE GUARANTEES:
//!   1. **Dedup.** One in-flight job per `dedup_key`. Re-submitting is a no-op.
//!   2. **Cancellation.** `cancel_track` stops everything queued for a track.
//!      Cooperative — see `CancelToken` for what that does and doesn't mean.
//!   3. **Priority.** `Now` beats `Next` beats `Idle`, decided at the moment a
//!      lane frees up rather than at submit time, so a `Now` job that arrives
//!      while an `Idle` backlog is queued still goes next.
//!
//! ASYNC WHERE IT EARNS ITS KEEP. Lane admission and priority selection are
//! tokio tasks; job bodies are blocking closures on OS threads (see `pool.rs`
//! for why). The async half is what lets Phase 3's sidecar — async process IPC
//! over framed stdio — drop in without reshaping the engine.
//!
//! NO SELF-MEASUREMENT. This engine never asks how busy the app is. That is
//! deliberate: the v0.11.0 frame governor derived its throttle from the
//! interval between *drawn* frames, measured its own throttling, and latched at
//! lowest quality with the load long gone. Admission control here is the OS
//! scheduler and nothing else — see `pool.rs`.

pub(crate) mod pool;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::{mpsc, Semaphore};

use pool::Pool;

/// Which worker pool a job runs on, and therefore how many of its kind may run
/// at once and at what OS thread priority.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Lane {
    /// Network and disk. Many threads, normal priority — these are latency
    /// bound, not CPU bound, so the limit exists to be polite to upstreams
    /// (LRCLIB, NetEase, Kugou, iTunes, Deezer) rather than to protect the CPU.
    Io,
    /// Pure computation: `analysis.rs`, beat tracking, palette extraction.
    /// `N-1` threads at below-normal priority.
    Cpu,
    /// Whisper / Demucs. **Concurrency 1** — two sessions at once thrash cache
    /// and memory for no throughput gain, and a second Demucs graph would
    /// roughly double an already >1GB footprint. Below-normal priority.
    /// Currently unused; Phase 3 fills it with the sidecar.
    Inference,
}

impl Lane {
    const ALL: [Lane; 3] = [Lane::Io, Lane::Cpu, Lane::Inference];

    fn index(self) -> usize {
        match self {
            Lane::Io => 0,
            Lane::Cpu => 1,
            Lane::Inference => 2,
        }
    }
}

/// When this job should run relative to everything else queued.
///
/// All three have producers as of Phase 2: `Now` is the playing song's own
/// lookups, `Next` is speculative precompute (the local queue lookahead and
/// the play-history prediction), and `Idle` is the pre-sync bulk import.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Priority {
    /// The track playing right now. The user is waiting.
    Now,
    /// Speculative work for what is likely to play next (Phase 2).
    Next,
    /// Backfill with no deadline — library indexing, re-analysis.
    Idle,
}

impl Priority {
    fn index(self) -> usize {
        match self {
            Priority::Now => 0,
            Priority::Next => 1,
            Priority::Idle => 2,
        }
    }
}

/// Cooperative cancellation.
///
/// **This cannot interrupt a running job.** A `ureq` call already blocked in a
/// socket read will finish that read; a `symphonia` decode will finish its
/// packet. What it does guarantee: a job that has not started yet never starts,
/// and a job that polls `cancelled()` at its checkpoints stops at the next one.
/// Job bodies are expected to check before each expensive step — see
/// `LyricsJob::run` for the pattern.
#[derive(Clone, Default)]
pub(crate) struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Anything the engine can run.
///
/// `run` is blocking and takes `self` by box, so a job owns its inputs
/// outright — there is no borrowing back into engine state from a worker
/// thread, which is what keeps the locking here trivial.
pub(crate) trait Runnable: Send + 'static {
    fn lane(&self) -> Lane;

    /// Identity for deduplication. Two submissions with the same key are the
    /// same work; the second is dropped while the first is in flight. Include
    /// the job kind as well as the track — `lyrics:<key>` and `artwork:<key>`
    /// are different work for the same song.
    fn dedup_key(&self) -> String;

    /// The track this job belongs to, if any. `cancel_track` uses it. Jobs
    /// with no track (an app-wide update check, say) are never cancelled by a
    /// track change.
    fn track(&self) -> Option<String> {
        None
    }

    fn run(self: Box<Self>, cancel: &CancelToken);
}

/// One queued job plus the token its submitter registered for it.
struct Envelope {
    job: Box<dyn Runnable>,
    cancel: CancelToken,
}

/// Which jobs are in flight, and how to reach their cancel tokens.
///
/// A plain `std::sync::Mutex`, never held across an await — every critical
/// section here is a couple of hash lookups.
#[derive(Default)]
struct Registry {
    /// `dedup_key` → its token. Presence here *is* the definition of
    /// "in flight", covering both queued and running.
    inflight: HashMap<String, CancelToken>,
    /// track → the `dedup_key`s currently in flight for it.
    by_track: HashMap<String, HashSet<String>>,
}

/// Per-lane submission channels, one per priority.
struct LaneSender {
    tx: [mpsc::UnboundedSender<Envelope>; 3],
}

pub(crate) struct Engine {
    lanes: Vec<LaneSender>,
    registry: Arc<Mutex<Registry>>,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

/// The process-wide engine.
///
/// A singleton for the same reason `state::APP_HANDLE` is one: the call sites
/// are free functions (`resolve_lyrics(app, ..)`) reached from four different
/// modules, and threading a handle through all of them would be churn for no
/// gain. Built on first use.
pub(crate) fn engine() -> &'static Engine {
    ENGINE.get_or_init(Engine::start)
}

/// Submit a job. Returns `false` if an identical job is already in flight.
pub(crate) fn submit(job: impl Runnable, priority: Priority) -> bool {
    engine().submit(Box::new(job), priority)
}

/// Cancel everything in flight for a track. Call on track change.
pub(crate) fn cancel_track(track: &str) {
    engine().cancel_track(track);
}

/// Cancel everything in flight for whatever track is playing right now — the
/// user-facing "cancel" affordance (the `hud-work` chip), as opposed to
/// `cancel_track`'s automatic call on a track change. Cooperative, same as
/// every other cancellation here: the sidecar stops at its next checkpoint,
/// not mid-instruction.
pub(crate) fn cancel_current() {
    let cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(track) = cur {
        cancel_track(&track);
    }
}

/// Which track key is playing right now, as far as the engine knows.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// Tell the engine the playing track changed, cancelling everything still in
/// flight for the previous one.
///
/// Lives here rather than in the SMTC watcher because the engine is what knows
/// what is outstanding, and because there are two ways a track can change —
/// the SMTC poll (`watchers::emit_smtc_sample`) and local playback
/// (`playback::set_local_track`). Both funnel through `resolve_lyrics`, so
/// calling it from there gives exactly one insertion point instead of two that
/// could drift apart.
pub(crate) fn set_current_track(key: &str) {
    let mut cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    if cur.as_deref() == Some(key) {
        return; // same song (a re-resolve, a seek) — leave its work alone
    }
    if let Some(prev) = cur.take() {
        cancel_track(&prev);
    }
    *cur = Some(key.to_string());
}

impl Engine {
    fn start() -> Engine {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let cpu_threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(1).max(1))
            .unwrap_or(1);

        let mut lanes = Vec::with_capacity(Lane::ALL.len());
        for lane in Lane::ALL {
            let (threads, below_normal, limit, name) = match lane {
                // 6 concurrent network calls is enough to fan out to every
                // lyric and artwork source at once without looking like abuse
                // to any of them.
                Lane::Io => (6, false, 6, "job-io"),
                Lane::Cpu => (cpu_threads, true, cpu_threads, "job-cpu"),
                Lane::Inference => (1, true, 1, "job-infer"),
            };
            lanes.push(spawn_lane(
                Pool::new(threads, below_normal, name),
                limit,
                Arc::clone(&registry),
            ));
        }

        Engine { lanes, registry }
    }

    fn submit(&self, job: Box<dyn Runnable>, priority: Priority) -> bool {
        let key = job.dedup_key();
        let track = job.track();
        let cancel = CancelToken::default();

        // Register before queueing. Doing it the other way round would let two
        // submissions of the same key both pass the check and both queue.
        {
            let mut reg = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            if reg.inflight.contains_key(&key) {
                return false;
            }
            reg.inflight.insert(key.clone(), cancel.clone());
            if let Some(track) = &track {
                reg.by_track.entry(track.clone()).or_default().insert(key.clone());
            }
        }

        let lane = self.lanes[job.lane().index()].tx[priority.index()].clone();
        if lane.send(Envelope { job, cancel }).is_err() {
            // Lane dispatcher gone (shutdown). Don't leave a phantom entry
            // behind that would block this key forever.
            release(&self.registry, &key, track.as_deref());
            return false;
        }
        true
    }

    fn cancel_track(&self, track: &str) {
        let reg = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        let Some(keys) = reg.by_track.get(track) else { return };
        for key in keys {
            if let Some(token) = reg.inflight.get(key) {
                token.cancel();
            }
        }
        // Entries are NOT removed here. A running job still owns its slot
        // until it returns; it clears its own registration in `release`.
        // Removing early would let a duplicate submit slip in beside a job
        // that is still running.
    }
}

/// Drop a job's registration once it is done (or was never started).
fn release(registry: &Arc<Mutex<Registry>>, key: &str, track: Option<&str>) {
    let mut reg = registry.lock().unwrap_or_else(|e| e.into_inner());
    reg.inflight.remove(key);
    if let Some(track) = track {
        if let Some(keys) = reg.by_track.get_mut(track) {
            keys.remove(key);
            if keys.is_empty() {
                reg.by_track.remove(track);
            }
        }
    }
}

/// Start one lane: three priority queues, a capacity semaphore, and a
/// dispatcher task that marries them to a blocking pool.
fn spawn_lane(pool: Pool, limit: usize, registry: Arc<Mutex<Registry>>) -> LaneSender {
    let (now_tx, mut now_rx) = mpsc::unbounded_channel::<Envelope>();
    let (next_tx, mut next_rx) = mpsc::unbounded_channel::<Envelope>();
    let (idle_tx, mut idle_rx) = mpsc::unbounded_channel::<Envelope>();

    let permits = Arc::new(Semaphore::new(limit));

    tauri::async_runtime::spawn(async move {
        loop {
            // CAPACITY FIRST, THEN CHOICE. Waiting for a free slot *before*
            // picking means the choice is made against the queue as it stands
            // at that moment — so a `Now` job submitted while an `Idle`
            // backlog sits queued still goes next. Picking first would freeze
            // the decision at arrival time and let `Idle` work block `Now`.
            let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                break; // semaphore closed — shutting down
            };

            let envelope = tokio::select! {
                biased;
                Some(e) = now_rx.recv() => e,
                Some(e) = next_rx.recv() => e,
                Some(e) = idle_rx.recv() => e,
                else => break, // every sender dropped
            };

            let Envelope { job, cancel } = envelope;
            let key = job.dedup_key();
            let track = job.track();
            let registry = Arc::clone(&registry);

            pool.execute(move || {
                // Cancelled while queued — never start it at all. This is the
                // case cooperative cancellation actually handles well, and the
                // common one: a track change while a fetch waits for a slot.
                if !cancel.cancelled() {
                    job.run(&cancel);
                }
                release(&registry, &key, track.as_deref());
                drop(permit);
            });
        }
    });

    LaneSender { tx: [now_tx, next_tx, idle_tx] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    /// A job that reports when it ran and can be told to block.
    struct TestJob {
        key: String,
        track: Option<String>,
        lane: Lane,
        ran: Arc<AtomicUsize>,
        started: Option<std_mpsc::Sender<String>>,
        hold: Option<Arc<AtomicBool>>,
    }

    impl TestJob {
        fn new(key: &str, ran: Arc<AtomicUsize>) -> Self {
            TestJob {
                key: key.to_string(),
                track: None,
                lane: Lane::Io,
                ran,
                started: None,
                hold: None,
            }
        }
        fn track(mut self, t: &str) -> Self {
            self.track = Some(t.to_string());
            self
        }
        fn reporting(mut self, tx: std_mpsc::Sender<String>) -> Self {
            self.started = Some(tx);
            self
        }
        fn holding(mut self, flag: Arc<AtomicBool>) -> Self {
            self.hold = Some(flag);
            self
        }
    }

    impl Runnable for TestJob {
        fn lane(&self) -> Lane {
            self.lane
        }
        fn dedup_key(&self) -> String {
            self.key.clone()
        }
        fn track(&self) -> Option<String> {
            self.track.clone()
        }
        fn run(self: Box<Self>, _cancel: &CancelToken) {
            self.ran.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = &self.started {
                let _ = tx.send(self.key.clone());
            }
            if let Some(hold) = &self.hold {
                // Spin until released, so the caller can control occupancy.
                while hold.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    /// Each test gets its own engine — the global one is shared and would make
    /// these order-dependent.
    fn engine_with(io_limit: usize) -> Engine {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let mut lanes = Vec::new();
        for lane in Lane::ALL {
            let limit = if lane == Lane::Io { io_limit } else { 1 };
            lanes.push(spawn_lane(
                Pool::new(limit, false, "test-lane"),
                limit,
                Arc::clone(&registry),
            ));
        }
        Engine { lanes, registry }
    }

    #[test]
    fn runs_a_submitted_job() {
        let eng = engine_with(2);
        let ran = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = std_mpsc::channel();
        assert!(eng.submit(Box::new(TestJob::new("a", Arc::clone(&ran)).reporting(tx)), Priority::Now));
        rx.recv_timeout(Duration::from_secs(5)).expect("job never ran");
        assert_eq!(ran.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn deduplicates_while_in_flight() {
        let eng = engine_with(1);
        let ran = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(true));
        let (tx, rx) = std_mpsc::channel();

        // First one occupies the only worker and stays there.
        assert!(eng.submit(
            Box::new(
                TestJob::new("dupe", Arc::clone(&ran))
                    .reporting(tx)
                    .holding(Arc::clone(&hold))
            ),
            Priority::Now
        ));
        rx.recv_timeout(Duration::from_secs(5)).expect("first job never started");

        // Same key while the first is still running — rejected.
        assert!(!eng.submit(Box::new(TestJob::new("dupe", Arc::clone(&ran))), Priority::Now));

        hold.store(false, Ordering::SeqCst);
        assert_eq!(ran.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn same_key_allowed_again_after_completion() {
        let eng = engine_with(1);
        let ran = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = std_mpsc::channel();

        assert!(eng.submit(
            Box::new(TestJob::new("k", Arc::clone(&ran)).reporting(tx.clone())),
            Priority::Now
        ));
        rx.recv_timeout(Duration::from_secs(5)).unwrap();

        // The registration is cleared by the worker after `run` returns, so
        // retry until it lands rather than racing it.
        let mut accepted = false;
        for _ in 0..100 {
            if eng.submit(
                Box::new(TestJob::new("k", Arc::clone(&ran)).reporting(tx.clone())),
                Priority::Now,
            ) {
                accepted = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(accepted, "key never freed after the job completed");
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn cancel_track_stops_queued_jobs() {
        let eng = engine_with(1);
        let ran = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(true));
        let (tx, rx) = std_mpsc::channel();

        // Occupy the single worker so the rest queue behind it.
        assert!(eng.submit(
            Box::new(
                TestJob::new("blocker", Arc::clone(&ran))
                    .track("other")
                    .reporting(tx)
                    .holding(Arc::clone(&hold))
            ),
            Priority::Now
        ));
        rx.recv_timeout(Duration::from_secs(5)).expect("blocker never started");

        for i in 0..4 {
            assert!(eng.submit(
                Box::new(TestJob::new(&format!("q{i}"), Arc::clone(&ran)).track("doomed")),
                Priority::Now
            ));
        }

        // Track changed: everything queued for it is abandoned before it runs.
        eng.cancel_track("doomed");
        hold.store(false, Ordering::SeqCst);

        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            ran.load(Ordering::SeqCst),
            1,
            "only the blocker should have run; cancelled jobs must never start"
        );
    }

    /// A job with no track must survive a track change. The pre-sync bulk
    /// import depends on this: it is work for songs that are deliberately not
    /// playing, so skipping the current track must not abandon it.
    #[test]
    fn untracked_jobs_survive_a_track_change() {
        let eng = engine_with(1);
        let ran = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(true));
        let (tx, rx) = std_mpsc::channel();

        // Occupy the only worker so the rest queue behind it.
        assert!(eng.submit(
            Box::new(
                TestJob::new("blocker", Arc::clone(&ran))
                    .track("playing")
                    .reporting(tx.clone())
                    .holding(Arc::clone(&hold))
            ),
            Priority::Now
        ));
        rx.recv_timeout(Duration::from_secs(5)).expect("blocker never started");

        // One tied to the playing track, one tied to nothing.
        assert!(eng.submit(
            Box::new(TestJob::new("tracked", Arc::clone(&ran)).track("playing").reporting(tx.clone())),
            Priority::Now
        ));
        assert!(eng.submit(Box::new(TestJob::new("untracked", Arc::clone(&ran)).reporting(tx)), Priority::Idle));

        eng.cancel_track("playing");
        hold.store(false, Ordering::SeqCst);

        let next = rx.recv_timeout(Duration::from_secs(5)).expect("the untracked job never ran");
        assert_eq!(next, "untracked", "cancel_track took a job that was not its own");

        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(ran.load(Ordering::SeqCst), 2, "the tracked job should have been cancelled, the untracked one kept");
    }

    /// `Now` submitted *after* a queue of `Idle` work must still go first.
    /// This is the property that "capacity first, then choice" buys, and the
    /// one that a naive pick-then-wait dispatcher gets wrong.
    #[test]
    fn priority_beats_arrival_order() {
        let eng = engine_with(1);
        let ran = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(true));
        let (started_tx, started_rx) = std_mpsc::channel();

        assert!(eng.submit(
            Box::new(
                TestJob::new("blocker", Arc::clone(&ran))
                    .reporting(started_tx.clone())
                    .holding(Arc::clone(&hold))
            ),
            Priority::Now
        ));
        started_rx.recv_timeout(Duration::from_secs(5)).expect("blocker never started");

        for i in 0..3 {
            assert!(eng.submit(
                Box::new(TestJob::new(&format!("idle{i}"), Arc::clone(&ran)).reporting(started_tx.clone())),
                Priority::Idle
            ));
        }
        // Arrives last, must run first.
        assert!(eng.submit(
            Box::new(TestJob::new("urgent", Arc::clone(&ran)).reporting(started_tx)),
            Priority::Now
        ));

        hold.store(false, Ordering::SeqCst);

        let first = started_rx.recv_timeout(Duration::from_secs(5)).expect("nothing ran after unblocking");
        assert_eq!(first, "urgent", "priority was not respected; got {first}");
    }
}
