//! Getting out of the app's way, at the OS level.
//!
//! This is the reason a sidecar beats in-process inference (JOB-ENGINE
//! section 2.2). Thread priority alone only demotes CPU; a model load reading
//! a few hundred MB off disk can still starve the app's own reads. Setting it
//! on the *process* covers both.
//!
//! `PROCESS_MODE_BACKGROUND_BEGIN` is the important half: it lowers I/O
//! priority as well as CPU, and Windows applies it to the whole process
//! including threads created later — which matters because ORT spawns its own
//! thread pool after this runs.

/// Drop this process to background scheduling. Best-effort: a failure here
/// makes the sidecar rude, not broken, so it is never fatal.
#[cfg(windows)]
pub fn deprioritise() {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_MODE_BACKGROUND_BEGIN,
    };

    unsafe {
        let me = GetCurrentProcess();
        // Order matters. BACKGROUND_BEGIN is documented to fail if the process
        // is already in background mode, and it also pins the priority class
        // while it is active — so set the class first, then enter background
        // mode on top of it.
        let _ = SetPriorityClass(me, BELOW_NORMAL_PRIORITY_CLASS);
        let _ = SetPriorityClass(me, PROCESS_MODE_BACKGROUND_BEGIN);
    }
}

/// Leave background mode, keeping `BELOW_NORMAL_PRIORITY_CLASS`.
///
/// Background mode is two things at once, and only one of them is wanted for
/// a long CPU-bound stretch. It lowers **I/O and memory** priority, which is
/// what stops a model load starving the app's own reads — genuinely valuable.
/// It also pins every thread to the **lowest possible** scheduling priority,
/// which for a multi-threaded ORT graph is not "polite", it is a throttle.
///
/// Measured, which is why this exists: see `priority_costs_throughput` in
/// `demucs.rs`. Leaving background mode does not make the sidecar rude — the
/// process is still BELOW_NORMAL, so the app still outranks it for CPU and
/// the guarantee JOB-ENGINE §2.2 rests on is intact.
#[cfg(windows)]
pub fn end_background() {
    use windows::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, PROCESS_MODE_BACKGROUND_END};

    unsafe {
        let _ = SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_END);
    }
}

/// Re-enter background mode after `end_background`.
#[cfg(windows)]
pub fn begin_background() {
    use windows::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, PROCESS_MODE_BACKGROUND_BEGIN};

    unsafe {
        let _ = SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN);
    }
}

#[cfg(not(windows))]
pub fn deprioritise() {
    // The app is Windows-only (see docs); this exists so the crate still
    // builds and tests on a CI runner that is not.
}

#[cfg(not(windows))]
pub fn end_background() {}

#[cfg(not(windows))]
pub fn begin_background() {}
