# The Job Engine — offline compute backend

**Status:** Phase 1 landed except the SQLite journal (see §7.1). Phases 2–7 not started.
**Branch:** `feat/job-engine`

A local, async compute service inside the Tauri process, plus an isolated
inference sidecar. It replaces five uncoordinated `std::thread::spawn` call
sites with one scheduler, moves Whisper and Demucs out of the WebView, and
opens the door to a set of per-song analyses that are not reachable today.

---

## 1. Why this, and not something else

Three things are already established and shape every decision below:

- **Rendering is not the bottleneck.** Measured in v0.11.0: total CPU draw cost
  is ~3 ms of a 16.7 ms budget, and ghost mode removes ~95% of it without a
  reliable frame-rate improvement. Any plan aimed at the draw loop is aimed at
  the wrong 3 ms.
- **Whisper and Demucs are the real load, and they run in the wrong process.**
  `src/renderer/whisper.js:65` pins `numThreads = 1` — not a choice, a
  consequence of the asset protocol setting no COOP/COEP, so no
  `SharedArrayBuffer`, so no WASM threads. That constraint does not exist
  outside a browser.
- **Background work was uncoordinated.** Five call sites across
  `commands/lyrics_cmds.rs` and `commands/artwork_cmds.rs` each spawned a bare
  OS thread. Skipping through five tracks started five lyric fetches and five
  artwork fan-outs, none of which could be cancelled or deduplicated. *(Fixed
  in Phase 1 — all five now go through the engine.)*

---

## 2. Architecture

```
   SMTC track change ──┐
   user action ────────┤        submit(Job, Priority, TrackKey)
   idle timer ─────────┘                    │
                                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │  JobEngine — tokio                                         │
   │    mpsc intake · keyed dedup · CancellationToken tree       │
   │    SQLite journal (survives restart)                        │
   └───┬──────────────────┬───────────────────────┬─────────────┘
       │                  │                       │
   ┌───▼─────────┐  ┌─────▼──────────┐  ┌─────────▼─────────────┐
   │  I/O lane   │  │   CPU lane     │  │  Inference lane       │
   │ Semaphore(8)│  │ rayon, N-1     │  │ Semaphore(1)          │
   │ async tasks │  │ BELOW_NORMAL   │  │ ── sidecar process ──┐│
   │             │  │                │  │  BELOW_NORMAL_       ││
   │ lyrics      │  │ analysis.rs    │  │  PRIORITY_CLASS      ││
   │ artwork     │  │ beat track     │  │  + BACKGROUND_BEGIN  ││
   │ LLM         │  │ structure      │  │                      ││
   │ AcoustID    │  │ key / loudness │  │  ort: VAD, Whisper,  ││
   │             │  │ fingerprint    │  │       Demucs         ││
   └──────┬──────┘  └────────┬───────┘  └──────────┬───────────┘│
          │                  │                     │            │
          └──────────────────┴─────────────────────┴────────────┘
                             ▼
            SQLite (WAL) — cache index · FTS5 lyrics · journal
                             ▼
            renderer: draws only, never computes
```

### 2.1 Why three lanes and not one pool

They have incompatible shapes. Network jobs are I/O-bound and want many
concurrent tasks with almost no CPU. Analysis is CPU-bound and wants exactly
`N-1` threads. Inference wants **concurrency 1** — two simultaneous Whisper
sessions thrash cache and memory for zero throughput gain, and a second Demucs
session would roughly double an already >1 GB footprint.

### 2.2 Why a sidecar process, not in-process inference

| | Today (WebView) | In Tauri process | Sidecar |
|---|---|---|---|
| Threads | **1** (forced) | All cores | All cores |
| Contention with render thread | Direct | Indirect | **None** |
| ORT segfault / OOM | Kills app | Kills app | Kills sidecar only |
| Memory after job | Allocator rarely returns it | Same | **OS reclaims everything on exit** |
| Priority control | None | Thread-level | **Process-level, incl. I/O** |
| Binary size / startup | — | Links a large C++ runtime into the app | Isolated |

The process-spawn plumbing already exists in `localcli.rs:258-277`.

`PROCESS_MODE_BACKGROUND_BEGIN` is the key win over thread priority alone: it
deprioritizes the process's **I/O** as well as its CPU, so model loading can't
starve the app's own disk reads.

### 2.3 Runtime choice: `ort`, not `whisper-rs`

Decisive factor: **Demucs is ONNX-only**, so `ort` is required regardless.
Using it for Whisper too means one runtime, one sidecar, and no change to
`scripts/vendor-whisper.js` or `scripts/vendor-demucs.js` — they already fetch
the exact ONNX artefacts needed.

The cost: `whisper-rs` (whisper.cpp) gives DTW word timestamps for free and
`ort` does not. Mitigation is to phase it — segment-level timing first (all of
the speed, none of the new risk), then evaluate word-level DTW against the
existing `align.rs`, which already aligns cues to real lyric text.

### 2.4 PCM transfer: memory-mapped file, not a pipe

A 4-minute song resampled to 16 kHz mono f32 is ~15 MB. Piping that per job is
wasteful. Instead the engine writes PCM to a temp file, and the sidecar
memory-maps it read-only. The stdio channel then carries only small
length-prefixed control frames:

```
[u32 len][u8 type][bincode payload]

→ Request  { job_id, pcm_path, sample_rate, spans, model }
← Progress { job_id, pct }
← Result   { job_id, cues }
← Error    { job_id, message }
```

---

## 3. Async design

Tauri 2 already ships tokio via `tauri::async_runtime`, so there is no new
runtime to introduce.

| Concern | Primitive |
|---|---|
| Job intake | `tokio::sync::mpsc` (bounded — backpressure, not unbounded growth) |
| Lane limits | `tokio::sync::Semaphore` per lane |
| Cancellation | `tokio_util::sync::CancellationToken`, one child token per `TrackKey` |
| Worker loops | `tokio::select!` on `{ job, cancel }` |
| Progress → renderer | `tauri::ipc::Channel<Progress>` — per-call stream, not a global event |
| CPU work | `rayon` pool with a `start_handler` that sets `THREAD_PRIORITY_BELOW_NORMAL` |
| Sidecar | `tokio::process::Command` + async framed stdio |

### 3.1 HTTP client

The codebase currently uses `ureq`, which is blocking. Two options:

- **Recommended:** move the I/O lane to `reqwest` (async-native, connection
  pooling, HTTP/2). Pooling matters here because lyric resolution fans out to
  LRCLIB / NetEase / KuGou / Genius, often to the same hosts repeatedly.
- **Low-risk:** keep `ureq` inside `spawn_blocking`. Works, costs a thread per
  in-flight request, no dependency churn.

I'd take `reqwest`, but it is a genuine dependency swap and can be deferred to
its own phase without blocking anything else.

### 3.2 Admission control — let the OS do it

The v0.11.0 governor bug is the cautionary tale here: it derived its throttle
from the interval between *drawn* frames, so it measured its own throttling and
latched at lowest quality forever.

**The job engine must not repeat this.** It must not decide whether to start CPU
work by measuring how slow the app currently is. Use signals that cannot feed
back:

- `BELOW_NORMAL_PRIORITY_CLASS` + `PROCESS_MODE_BACKGROUND_BEGIN` on the
  sidecar. The OS scheduler guarantees the compositor and render thread win.
- `THREAD_PRIORITY_BELOW_NORMAL` on CPU-lane threads.
- The existing `watchers::start_power_watcher` (`lib.rs:132`) already tracks
  battery state, and `Win32_System_Power` is already in `Cargo.toml` — gate
  Demucs (and optionally Whisper) off on battery.

---

## 4. Storage: SQLite replaces the JSON cache

One file, WAL mode, three jobs:

1. **Job journal.** A transcription interrupted by a quit resumes on next
   launch instead of being lost.
2. **Cache index.** Query by artist / album / recently-played / "has beatmap",
   which the current flat JSON cache cannot do without loading everything.
3. **FTS5 over lyric text.** Enables "find the song with this line" — a feature
   that is otherwise a full scan.

`rusqlite` with the `bundled` feature adds no system dependency. WAL mode gives
concurrent readers with a single writer, which is exactly this workload.

---

## 5. Niche capabilities this unlocks

These are the reason to build a *general* engine rather than a Whisper-specific
fix. Each is a `Job` variant; none requires re-architecting.

### 5.1 Audio fingerprinting → correct metadata **(highest value)**

**The problem:** SMTC from a browser reports the *video title*, not artist and
title — `"Song Name (Official Video) [4K] Lyrics"`. Every downstream lookup
inherits that garbage, and this is the single largest source of wrong lyrics in
browser playback.

**The fix:** fingerprint the loopback PCM you already capture → AcoustID →
MusicBrainz recording ID → canonical artist/title → correct lyrics.

`chromaprint-next` is a pure-Rust port that produces **bit-identical**
fingerprints to the C reference across all five algorithm variants, and
benchmarks ~4% faster than the C library (269 vs 258 Melem/s at 120 s). Pure
Rust means no new C toolchain dependency on Windows.

### 5.2 Silero VAD before Whisper **(best effort-to-payoff ratio)**

A 2.3 MB ONNX model that classifies ~30 ms chunks in **under 1 ms on CPU**.
Two independent wins:

- **Speed.** A typical song is 40–60% instrumental. Transcribing only voiced
  spans cuts Whisper's work roughly in half, on top of the 3–8× from native
  threading.
- **Correctness.** Whisper hallucinates lyrics over instrumental passages. This
  is a known failure mode that VAD gating removes structurally — it is why
  faster-whisper adopted Silero. Better output, not just faster output.

It also hands the visual layer an exact map of where the vocals aren't, which
is directly useful for instrumental-section behaviour.

### 5.3 Offline beat tracking with tempo lock

There is a measured live-tempo drift bug — 138 BPM read as 174 on a 138 BPM
track. A causal, streaming tempo estimator drifts by construction; an offline
dynamic-programming beat tracker over the whole song does not.

`aubio-rs` / `bliss-audio-aubio-rs` provide this, but bind to the aubio **C
library** — a real build burden on Windows. Since `analysis.rs` already
computes an onset envelope, I'd instead implement the Ellis DP beat tracker on
top of it: roughly 150 lines of pure Rust, no new native dependency, and fully
unit-testable in the style `analysis.rs` already uses.

### 5.4 Structure segmentation — verse / chorus / bridge

Self-similarity matrix over chroma or MFCC → novelty curve → boundaries. This
is what lets the visuals **anticipate** a chorus rather than react to one,
which is exactly what the existing build-up / anticipation-ring work is
reaching for. Uses `rustfft`, already a dependency.

### 5.5 Musical key detection

Chroma vector → Krumhansl-Schmuckler correlation → key and mode. Nearly free
once 5.4 computes chroma. Drives palette by key: minor cool, major warm.

### 5.6 EBU R128 loudness normalization

Visual intensity currently depends on how hot a track was mastered. Integrated
loudness gives a per-track gain so a quiet jazz record and a loud EDM track
drive the visuals with equal force. The `ebur128` crate does this directly.

### 5.7 Local library indexing

`symphonia` already decodes every common format. Watch a music folder and
pre-analyse it in the `Idle` lane, so every local file starts with full
analysis, beat map, and structure already on disk.

### 5.8 Speaker diarization for featured artists — **exploratory**

`attribute.rs` currently guesses per-line artist attribution from *text* via an
LLM. Audio diarization (speaker embeddings + clustering) actually knows who is
rapping. On-brand for the duo/feature-heavy library this app targets, but the
models are larger and the payoff is unproven. Late phase, or never.

---

## 6. The IPC firehose

`audio.rs:294-298` base64-encodes 1536 bytes and emits it as JSON, 50×/second,
onto the thread running the rAF loop.

Measured reference point: `JSON.parse` on a 5 KB payload costs 0.5–2 ms, while
`DataView` reads over the same bytes are effectively free. Scaling to this
~2 KB payload and 50 Hz puts the cost somewhere around **15–50 ms per second of
main-thread time — 1.5–5% of the main thread — before the base64 decode.**

That is an extrapolation from a published benchmark, **not a measurement of
this app.** Phase 4 starts by profiling it.

Two fixes, in value order:

1. **Send derived scalars, not raw bytes.** Most of `audio.js` consumes
   level / bass / treble / kick / drop flags. Computing those in Rust turns
   1536 bytes into ~8 floats — a ~50× payload cut.
2. **Binary channel for MilkDrop's waveform,** which genuinely needs raw bytes.
   Tauri 2 exposes `ipc::Response` for `Vec<u8>` and `Channel` for push
   streaming; it deliberately provides no framing/codec layer, so a small
   length-prefixed protocol and a `DataView` decoder are ours to write.

---

## 7. Phasing

| Phase | Scope | Risk | User-visible? |
|---|---|---|---|
| **1** ✅ | `jobs` module: `Job`/`Priority`/`TrackKey`, mpsc intake, keyed dedup, cancellation tree, three lanes, below-normal priority. Port existing `thread::spawn` sites onto it. (SQLite journal moved to Phase 3 — §7.1.) | Low — behaviour-preserving refactor, unit-testable | No, except two main-thread stalls removed |
| **2** | Speculative precompute on `Next`/`Idle`. Generalises the existing `presync` path from paste-a-list to automatic. | Low | **Yes — songs start instantly** |
| **3** | Inference sidecar: `ort`, mmap PCM transfer, framed stdio, **Silero VAD + Whisper** (segment-level). Demucs follows. SQLite journal lands here — a half-finished transcription is the first job worth resuming. | Medium — new binary, model loading, new IPC protocol | Yes — faster, no stutter, fewer hallucinations |
| **4** | Binary / derived audio IPC. **Profile before building.** | Low, unproven value | Marginal |
| **5** | Fingerprinting → AcoustID (5.1). Fixes browser metadata. | Medium — new network dependency, needs an AcoustID API key | **Yes — correct lyrics on YouTube** |
| **6** | DSP suite: beat tracking (5.3), structure (5.4), key (5.5), loudness (5.6). Pure Rust, incremental. | Low each | Yes — visuals |
| **7** | Library indexing (5.7). Diarization (5.8) only if 3 and 6 land well. | Medium / high | Yes |

Phase 1 is worth doing on its own merits even if nothing after it ships — it is
a strict improvement over five uncoordinated threads.

### 7.1 Phase 1 as built

Done: `src-tauri/src/jobs/{mod,pool}.rs` — `Runnable`/`Priority`/`Lane`,
per-lane mpsc intake at three priorities, keyed dedup, the cancellation
registry, capacity-then-choice dispatch, below-normal CPU threads. All five
`thread::spawn` sites from §1 are ported: `resolve_lyrics`, `resolve_artwork`,
`resolve_mood`, `resolve_attribution` as `Now` jobs keyed by track, and
`presync_list` as one serial `Idle` job.

Two main-thread stalls were found and fixed while porting, both the same
defect class as the file-picker deadlock: `presync_list` ran an entire
playlist inline on a sync command (a network round trip plus 150 ms per
track), and `artwork_candidates` spawned a thread only to block on
`rx.recv()` waiting for a three-source fan-out. The latter stays a plain
`(async)` command rather than becoming a job — the renderer awaits its return
value, and the engine is fire-and-forget with no reply channel.

**Not done: the SQLite journal.** Deferred to Phase 3 on purpose, because it
has no correct consumer before then:

- Every job that exists today emits an event that repaints the *playing*
  song. Nothing is playing at startup, so replaying a journalled lyric,
  artwork, mood or attribution job would push the previous session's results
  onto an idle overlay. Restoring them is worse than losing them.
- Pre-sync is the one long job worth resuming, and it already resumes
  idempotently for free: `presync_one` skips anything already cached, so
  re-running the same list continues where it stopped.
- `Runnable` is a boxed trait object holding an `AppHandle`, which cannot be
  serialized. A journal needs a parallel serializable job-descriptor enum plus
  a reconstruction step — a real change to the engine's core trait, and one
  whose shape should be decided by the requirement that actually justifies it
  (a half-finished transcription, §2.4) rather than guessed at now.

The rest of §4 — cache index, FTS5 over lyric text — is independent of the
journal and unstarted.

Phases 2 and 5 are where a user would actually notice. If the goal is impact
per unit of work, **1 → 2 → 5 → 3** is a defensible reordering of the middle.

---

## 8. What is measured and what is not

Stated plainly, because several numbers here came from benchmarks that are not
this app:

| Claim | Basis |
|---|---|
| ~3 ms draw cost, ghost mode removes ~95% | **Measured** on this app, v0.11.0 |
| Live tempo drift 138 → 174 BPM | **Measured** on this app |
| `numThreads = 1` in the WASM path | **Read from source** (`whisper.js:65`) |
| Native multi-thread vs single-thread WASM: 3–8× | **Estimate** from the threading change alone |
| VAD roughly halves Whisper work | **Estimate** from typical vocal/instrumental ratio |
| Silero: 2.3 MB, <1 ms per 30 ms chunk | Published, third-party |
| chromaprint-next bit-identical, ~4% faster than C | Published, third-party |
| Audio IPC costs 1.5–5% of the main thread | **Extrapolation** from a published `JSON.parse` benchmark. Unverified here. Profile first. |

---

## 9. Sources

- [chromaprint-next — pure-Rust Chromaprint](https://github.com/attilagyorffy/chromaprint-next)
- [rusty-chromaprint](https://crates.io/crates/rusty-chromaprint)
- [Silero VAD with ONNX Runtime](https://dev.to/kiarina/extracting-speech-segments-with-silero-vad-and-onnx-runtime-3h8a)
- [whisper.cpp + Silero VAD](https://github.com/gumblex/whisper_vad)
- [aubio-rs](https://github.com/katyo/aubio-rs) · [bliss-audio-aubio-rs](https://crates.io/crates/bliss-audio-aubio-rs)
- [Tauri IPC improvements discussion](https://github.com/tauri-apps/tauri/discussions/5690)
- [Tauri binary IPC issue #7127](https://github.com/tauri-apps/tauri/issues/7127)
- [tauri-wire — binary framing benchmarks](https://github.com/userFRM/tauri-wire)
