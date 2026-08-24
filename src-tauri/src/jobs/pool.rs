//! Blocking worker pools, one per lane.
//!
//! WHY BLOCKING AND NOT ASYNC BODIES. Every job this engine runs today is
//! blocking by construction: `ureq` for the network, `std::fs` for the cache,
//! `symphonia` for decode. Wrapping them in futures would buy nothing and cost
//! a `reqwest` migration. The *orchestration* is async (see `mod.rs` — priority
//! selection and lane admission are tokio tasks, so the Phase 3 sidecar's async
//! process IPC slots in without a rewrite); the *bodies* run here, on real OS
//! threads that are allowed to block.
//!
//! WHY THREAD PRIORITY IS SET HERE. The v0.11.0 governor bug is the cautionary
//! tale: anything that decides to do less work must not derive its input from
//! how much work it did, or it feeds itself and latches. So this engine has no
//! self-measurement at all. It leans on the OS scheduler instead —
//! `THREAD_PRIORITY_BELOW_NORMAL` on the CPU and inference lanes means the
//! compositor and the render thread win by construction, with no feedback loop
//! to get wrong.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

/// A unit of blocking work handed to a pool thread.
type Task = Box<dyn FnOnce() + Send + 'static>;

/// A fixed set of OS threads draining a shared queue.
///
/// Deliberately not a general-purpose thread pool: there is no resizing, no
/// work stealing, and no panic recovery beyond what `catch_unwind` in the
/// caller provides. Lanes are long-lived and few, so the simplest thing that
/// cannot deadlock is the right thing.
pub(crate) struct Pool {
    tx: Sender<Task>,
}

impl Pool {
    /// Spawn `threads` workers. `below_normal` drops them to
    /// `THREAD_PRIORITY_BELOW_NORMAL` (Windows; a no-op elsewhere).
    ///
    /// `name` prefixes the OS thread names, which is what makes a stuck lane
    /// legible in a debugger or in Process Explorer.
    pub(crate) fn new(threads: usize, below_normal: bool, name: &'static str) -> Self {
        let (tx, rx) = channel::<Task>();
        // One receiver shared by every worker. Holding the lock across `recv`
        // is the standard pattern and is correct here: the guard is dropped at
        // the end of the `let` statement, so the task itself always runs
        // *unlocked* and workers execute concurrently. Only the hand-off is
        // serialised.
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..threads.max(1) {
            let rx = Arc::clone(&rx);
            let _ = std::thread::Builder::new()
                .name(format!("{name}-{i}"))
                .spawn(move || {
                    if below_normal {
                        set_below_normal();
                    }
                    loop {
                        let task = { rx.lock().unwrap_or_else(|e| e.into_inner()).recv() };
                        match task {
                            Ok(task) => task(),
                            // Sender dropped — the engine is going away.
                            Err(_) => break,
                        }
                    }
                });
        }
        Pool { tx }
    }

    /// Queue work. Silently drops if every worker has died, which can only
    /// happen at shutdown — a job lost then has nothing left to report to.
    pub(crate) fn execute(&self, task: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(task));
    }
}

#[cfg(windows)]
fn set_below_normal() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };
    // Failure is not worth reporting: the job still runs, just at normal
    // priority. There is no user-visible consequence to surface.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
fn set_below_normal() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn runs_every_queued_task() {
        let pool = Pool::new(4, false, "test");
        let done = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        for _ in 0..32 {
            let done = Arc::clone(&done);
            let tx = tx.clone();
            pool.execute(move || {
                done.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(());
            });
        }
        drop(tx);
        for _ in 0..32 {
            rx.recv_timeout(Duration::from_secs(5)).expect("task did not run");
        }
        assert_eq!(done.load(Ordering::SeqCst), 32);
    }

    /// The whole point of a pool: a blocked worker must not stop the others.
    /// This is what the shared-receiver locking above would break if the guard
    /// were held across the task body rather than just the hand-off.
    #[test]
    fn workers_run_concurrently() {
        let pool = Pool::new(4, false, "test-conc");
        let (tx, rx) = channel();
        for _ in 0..4 {
            let tx = tx.clone();
            pool.execute(move || {
                std::thread::sleep(Duration::from_millis(200));
                let _ = tx.send(());
            });
        }
        drop(tx);
        let start = std::time::Instant::now();
        for _ in 0..4 {
            rx.recv_timeout(Duration::from_secs(5)).expect("task did not run");
        }
        // Serial execution would need ~800ms; concurrent needs ~200ms. The
        // 600ms bar is loose enough to survive a busy CI box.
        assert!(
            start.elapsed() < Duration::from_millis(600),
            "tasks appear to have run serially: {:?}",
            start.elapsed()
        );
    }
}
