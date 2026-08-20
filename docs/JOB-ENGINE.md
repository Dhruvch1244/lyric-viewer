# The Job Engine — offline compute backend

**Status:** Phase 1 landed except the SQLite journal (§7.1). Phase 2 landed except the local-folder `Idle` backfill, which moved to Phase 7 (§7.2). Phase 3: the sidecar transport (§7.3), the log-mel front end (§7.4), Silero VAD (§7.5) and the Whisper encoder/decoder + DTW word alignment (§7.6) are in and produce real, verified transcriptions with per-word timing end to end; only the SQLite work remains. Phase 4 closed — profiled, and the fixes it proposed were rejected on the measurements (§7.8). Phases 5–7 not started.
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

## 6. The IPC firehose — profiled, and it is not one

`audio.rs` base64-encodes 1536 bytes and emits it as JSON, 50×/second, onto
the thread running the rAF loop.

This section used to estimate that at **1.5–5% of the main thread**, scaled
from a published `JSON.parse` benchmark, and §8 listed it as the one unverified
number in the document. Phase 4's instruction was to profile before building.
Profiling changed the answer.

**Two things the estimate got wrong.**

First, `emit` is not a message. Reading `tauri-2.11.5/src/event/mod.rs`,
`emit_js_script` builds a **JavaScript source string** with the payload inlined
as a literal and evals it in the webview. So the per-frame renderer cost is a
~2.2 KB script *compile*, not a `JSON.parse` — and each frame's source is
unique, so V8's compilation cache cannot hit.

Second, the real numbers are two orders of magnitude below the estimate.
Measured on V8 (node 24, the same engine WebView2 runs), 200k iterations,
median of 7 runs, unique source per iteration so nothing is cached:

| Per-frame work | Cost | At 50 Hz |
|---|---|---|
| `eval` of the emitted script (2179 B) | 0.0023 ms | 0.116 ms/s |
| `JSON.parse` + `atob` + the `charCodeAt` loop | 0.0053 ms | 0.264 ms/s |
| **Total transport cost** | **0.0076 ms** | **0.38 ms/s — 0.038% of one core** |

The estimate was **~40–130× too high**. Not measured here, and worth naming:
WebView2 runs the browser out of process, so `webview.eval` is a cross-process
`ExecuteScript` call whose overhead this node harness does not capture. That
cost scales with script size, which is the one reason payload size still
matters at all.

**Both proposed fixes are now rejected, for reasons the profiling exposed.**

1. ~~Send derived scalars, not raw bytes.~~ It would move the DSP into Rust,
   but `audio.js` must keep its JS implementation regardless for the
   getDisplayMedia fallback path, which reads a real `AnalyserNode` with no IPC
   in it. That buys two implementations of tuned DSP that must not drift, to
   save 0.38 ms/s. The drift risk is the real cost, and it is not worth it.
2. ~~Binary channel for MilkDrop's waveform.~~ Tauri's `Channel` is worse than
   `emit` here, in both of its branches. `channel.rs` sends `Raw` payloads
   **under 1024 bytes** by evaluating `new Uint8Array([12,34,…])` — a JSON
   array of numbers, ~4 chars per byte, which is *three times worse* than
   base64's 1.33. Anything **over** 1024 bytes goes through a `fetch` round
   trip instead, and Tauri's own source comments that eval beats fetch by ~2×
   on WebView2 at these sizes. Measured: the sub-1 KB channel path costs
   0.0030 ms/frame against `emit`'s 0.0023. A "binary channel" on this runtime
   is a regression.

**What did land: a waveform demand gate.** The one defensible finding is that
the payload is mostly waste. The waveform is 1024 of the 1536 bytes and has
exactly one consumer — MilkDrop, via `AudioReactive.timeDomain` — while the
spectrum drives all the DSP. Whenever MilkDrop is not the active engine, three
quarters of every frame is built, base64'd, inlined into a script, compiled and
decoded for nobody.

So `audio.js` gates it on demand: calling `timeDomain` marks the waveform
wanted, 60 frames without a call releases it via `set_audio_waveform(false)`,
and `audio.rs` then omits the `t` key entirely. Frames drop from **2179 to 804
bytes**. The gate is counted in frames rather than milliseconds on purpose —
`sample()` is handed the caller's clock and `timeDomain()` is handed nothing,
so a timestamp would compare two time bases (the first version did, and the
test caught it). Driving it from demand rather than from MilkDrop's lifecycle
means any future waveform consumer is handled for free, and a consumer that
stops asking cannot leave the payload inflated.

Both defaults are "waveform on" — `audio.rs`'s static and the renderer's
initial state — so an older frontend against a newer binary, or a renderer that
never calls the command, keeps working unchanged.

---

## 7. Phasing

| Phase | Scope | Risk | User-visible? |
|---|---|---|---|
| **1** ✅ | `jobs` module: `Job`/`Priority`/`TrackKey`, mpsc intake, keyed dedup, cancellation tree, three lanes, below-normal priority. Port existing `thread::spawn` sites onto it. (SQLite journal moved to Phase 3 — §7.1.) | Low — behaviour-preserving refactor, unit-testable | No, except two main-thread stalls removed |
| **2** ✅ | Speculative precompute on `Next`/`Idle`. Generalises the existing `presync` path from paste-a-list to automatic. | Low | **Yes — songs start instantly** |
| **3** 🔶 | Inference sidecar: `ort`, mmap PCM transfer, framed stdio, **Silero VAD + Whisper** (word-level, DTW-aligned) ✅ — real transcription with real per-word timing, verified end to end (§7.3–7.6). Demucs follows. SQLite journal lands here — a half-finished transcription is the first job worth resuming; still open. | Medium — new binary, model loading, new IPC protocol | Yes — faster, no stutter, fewer hallucinations |
| **4** ✅ | Binary / derived audio IPC. **Profiled; both fixes rejected** — the cost was 0.038% of a core, not 1.5–5%, and Tauri's binary channel is slower than its eval-based `emit` at this size. Shipped instead: a waveform demand gate, 2179 → 804 B/frame. See §6 and §7.8. | Low, unproven value | No |
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

### 7.2 Phase 2 as built

Two sources of "what plays next", because the two playback paths differ:

- **Local files — known, not guessed.** `LocalPlayer` owns the queue, so
  `player.js` hands the next two entries to a new `precompute_tracks` command
  when a track starts. No prediction involved.
- **SMTC — predicted from play history.** Windows' media session reports only
  what is playing; it has no queue and no lookahead. `history.rs` keeps the
  last 500 plays in `history.json` and, on each track change, warms the cache
  for the song that has followed this one at least twice before. Album and
  playlist listening is repetitive enough for that to hit often.

Both converge on one `PrecomputeJob` at `Priority::Next`, keyed
`precompute:<track>`, so the two routes dedup against each other during local
playback where both are live.

**The safety property that makes speculating acceptable: precompute never
emits.** It writes the on-disk lyrics cache and nothing else. A wrong guess
therefore costs one wasted request and is invisible — it cannot put another
song's words on screen. That asymmetry is what allows a predictor this crude.
It also writes in exactly the shape `LyricsJob`'s disk-cache branch reads, so
a correctly-predicted song takes the instant path when it starts.

Lyrics only. Artwork was left out deliberately: `artwork.rs` has no disk
cache, so there would be nothing for a precomputed fetch to leave behind.
Mood and attribution are also skipped — both are paid LLM calls, and neither
gates the "song starts instantly" experience the way the lyric lookup does.

Not done from this phase's description: automatic `Idle` backfill of a local
music folder. That needs a persisted library to backfill *from*, and this app
has none — adding folders enqueues them for playback rather than indexing
them. It belongs with §5.7, which is already scheduled as Phase 7.

### 7.3 Phase 3, stage 1: the sidecar exists and talks

Phase 3 is being landed in stages so the WebView transcription path stays live
until its replacement is actually in the tree. **Stage 1 is the transport, not
the model.**

Landed:

- `src-tauri` is now a **cargo workspace**: the app, `protocol/`, and
  `sidecar/`. The app does *not* depend on `ort` — that isolation is the point
  (§2.2), and the dependency graph now enforces it rather than documenting it.
- `protocol/` — the framed stdio wire format, `[u32 len][u8 kind][bincode]`,
  shared by both sides so the shapes cannot drift. The `kind` byte lets the
  host drop `Progress` frames without decoding them.
- `sidecar/` — a real binary that sets `BELOW_NORMAL_PRIORITY_CLASS` +
  `PROCESS_MODE_BACKGROUND_BEGIN` on itself, memory-maps the host's PCM temp
  file, and serves the protocol on a reader thread with a single worker
  thread behind it (concurrency 1 structurally, not by the host's good
  behaviour).
- `src/inference.rs` — the host client. **One process per job**: it is spawned
  for a transcription and exits after, which is what buys §2.2's "OS reclaims
  everything on exit". No supervision state machine, no restart policy.
- `commands::lyrics_cmds::transcribe_local_file` on the **Inference lane**,
  feeding results into the existing `finalize_transcription` so alignment,
  LLM correction and caching are shared with the WebView path rather than
  duplicated.
- Bundling: `externalBin` lives in a **bundle-time config overlay**
  (`tauri.bundle.conf.json`), not the base config — `tauri-build` fails at
  `cargo check` time if a declared `externalBin` is missing, and the staged
  binary is gitignored build output, so putting it in the base config would
  break `cargo test` and CI for anyone who had not built the sidecar first.
  `scripts/vendor-sidecar.js` builds and stages it with the target triple
  Tauri expects. ORT links statically: the staged 20.5 MB exe runs from an
  empty directory with no DLLs beside it (verified, not assumed).

Verified here, not assumed: ORT 1.28.0 downloads, links, and initialises
inside the spawned child (the `Ready` handshake reports its build string), and
seven integration tests drive the real process — handshake, clean shutdown,
shutdown by closed pipe, silent-audio diagnosis, PCM mapping, bad sample rate,
and surviving a bad job without dying.

Still to come in this phase (stages 2–4 below closed the rest of this list
except the last two): native song-length loopback recording so the SMTC path
needs no PCM over IPC, the SQLite work, and only then deleting `whisper.js`
and its ~26 MB of vendored WASM.

### 7.4 Phase 3, stage 2: the log-mel front end

Whisper does not take audio. It takes an 80×3000 log-mel spectrogram computed
in one exact way, and a front end that is subtly wrong produces a model that
runs happily and transcribes nonsense — no error, only bad words. That makes
this the one part of the pipeline where "it compiles and looks right" is worth
nothing.

So `sidecar/src/mel.rs` is checked against **transformers.js**, and
specifically against the version of it that `src/renderer/whisper.js` runs
today. Matching an independently written implementation is the strongest
available check without a reference recording; matching *that* one means the
native path cannot regress what the WASM path already produces.
`scripts/gen-mel-reference.mjs` prints the Rust constants, so the numbers are
reproducible rather than transcribed once and trusted.

Agreement is to **~1e-5** on every probe, on features whose full range is 2.0 —
including frames 0, 1 and 2999, which sit against the reflect padding where a
sine mirrored into a corner splatters energy across every band. Those three are
the sharpest test of the padding in the set.

Two things worth recording because both first read as front-end bugs and
neither was:

- **The reference signal has to be generated in f64.** At t ≈ 30 s the argument
  to `sin` is ~83 000 radians, where f32's seven digits leave the phase wrong,
  the tone stops being periodic in the analysis window, and leakage lifts every
  quiet mel band off the dynamic-range floor. The first version of the test
  computed it in f32 and reported a 0.19 discrepancy that was entirely the
  test's own.
- **The f32 STFT is fine.** The obvious suspect for that discrepancy was
  precision — Whisper clamps to eight decades below the window's loudest bin,
  which is close to f32's noise floor. Both variants were run against the
  reference: identical to 1e-5. The f64 STFT bought nothing and is not used.

Wired into `run_job` rather than left as a tested-but-unreached module: the
staged binary now runs the front end over real captured audio and logs its
cost and coverage, so a chunking bug shows up as a wrong number in a log line
instead of as a transcription that quietly stops early.

### 7.5 Phase 3, stage 3: Silero VAD, and why it is not only about speed

§2's case for the VAD was that it roughly halves Whisper's work. That is the
smaller half of the reason. The larger one: given 30 s of instrumental, Whisper
does not return nothing — it invents plausible lyrics, confidently, with
timestamps, and no confidence score reliably catches it. Not asking it is the
only fix that works.

`sidecar/src/vad.rs` is split so that the part which can be wrong quietly is
the part under test:

- `SpeechGate` — Silero's own hysteresis state machine, driven one probability
  per 512-sample window. Two thresholds, not one: a single threshold makes a
  voice flicker across 0.5 and shatters a sung line into a dozen spans. Pure,
  and tested against hand-built probability streams whose answers are known —
  including the case that matters most, that an instrumental produces *no*
  spans at all.
- `plan_windows` — batches spans into ≤30 s Whisper inputs. This is where the
  speed actually comes from, and it is easy to get backwards: Whisper's input
  is a fixed 30 s whether it is full or not, so a 2 s span and a 30 s window
  cost the model the same. Transcribing spans one at a time would be **slower
  than not running the VAD at all**.
- `SileroVad` — the ONNX wrapper, kept thin because it is the part that needs a
  model file to exercise.

Two decisions worth recording:

- **A missing VAD model downgrades, it does not fail.** The detector is an
  optimisation and a hallucination guard; without it transcription is slower
  and noisier, not impossible. Failing a whole job over a missing 2 MB file is
  the wrong trade, so `plan_work` logs and falls back to the whole clip in 30 s
  windows — which is exactly what the WASM path does today.
- **`sr`'s tensor rank is read from the graph, not assumed.** Published Silero
  checkpoints declare it as a scalar or as a 1-element tensor depending on
  version, and ONNX Runtime rejects the wrong rank rather than broadcasting.

The sidecar now logs voiced-versus-total and audio-versus-model-input. The
second is the one to look at before tuning any constant here: every window is
padded to a full 30 s whatever it holds, so the gap between those two numbers
is precisely the work the batching failed to save.

**A third thing, found only once real speech was run through it, not
recoverable from the graph's own declared shapes:** the ONNX input is
`[-1, -1]` — nothing rejects a bare 512-sample window, it just scores
everything near zero. Probed directly against 8 s of real speech: a
context-less 512-sample window produced a maximum probability of **0.12**
across the whole clip — every window silently below the 0.5 threshold, hence
"VAD found 0 span(s)" on audio that plainly has speech in it. Silero v5's real
input is 576 samples: 64 samples of trailing context from the previous window
prepended to the new 512. With that context, the same clip's peaks reached
1.0. `sidecar/src/vad.rs`'s `SileroVad` now carries a 64-sample context buffer
between calls; the constant and the measurement live next to each other in
`CONTEXT_SAMPLES`'s doc comment so a future reader does not have to re-derive
it from a probe.

### 7.6 Phase 3, stage 4: the decoder, DTW, and two bugs only a real decode found

The encoder and the greedy decoder live in `sidecar/src/whisper.rs`; the
attention-to-timing math is `sidecar/src/dtw.rs`, split out because it is pure
arithmetic over numbers and therefore fully unit-testable without a model file
— normalisation, the median filter, the warp itself and the token→frame
collapse each have known-answer tests (§9's table on the median filter's edge
behaviour and the warp's monotonicity is the kind of thing that is easy to get
subtly backwards and have it still compile).

Greedy decoding, not beam search — deliberately. Everything downstream is
`align.rs`, which replaces the transcription with the *real* lyric text
whenever one is found; spending 4× the compute on a slightly better guess at a
word about to be discarded is not a trade worth making here.

**`_timestamped` is not a preference, it is a requirement — and this cost the
WebView path its entire feature.** Word timing comes from the decoder's
cross-attention weights, and `onnx-community/whisper-base`, the model the
WASM path had named, exports none. `Whisper::load` now checks for
`cross_attentions.*` outputs up front and refuses with a message that names
the fix, rather than failing per-window with a missing-tensor error deep in a
decode. See the `whisper.js` fix below and the JS test that pins the model id.

**Two more bugs, and both share a shape: the model's declared I/O shapes gave
no reason to suspect either, and both were only visible once a real decode ran
end to end.** `sidecar/tests/real_transcription.rs` — `#[ignore]`d, needs
downloaded models and a synthesised-speech fixture from
`scripts/make-speech-fixture.ps1` — is what caught them, and it is the reason
that test's assertions check for evenly-spread, strictly-advancing word
timestamps rather than merely "non-decreasing and spans >2s": the first
version of this test passed with the second bug still present, because
"290, 690, 690, 690, …, 690, 6990" satisfies both those weaker properties.

- **Cross-attention past-key-values are not really cached across steps in
  this export.** The natural reading of a merged decoder's KV cache is: feed
  back whatever `present.N.{decoder,encoder}.{key,value}` came out, every
  step, same as the self-attention cache. That is right for the decoder side
  and wrong for the encoder (cross-attention) side. Measured directly: on the
  no-cache priming call, `present.N.encoder.key` is real —
  `[1, 8, 1500, 64]`, the genuine cross-attention over the whole encoded
  window. On every call *after* that (`use_cache_branch=true`), the
  same-named output comes back with a degenerate shape whose data buffer is
  **empty**, and feeding that back crashed the very next step with a shape
  mismatch impossible to misread: `shape [1, 8, 1, 64] (512 elements) is
  different from the length of the data provided (0 elements)`. The fix
  matches how cross-attention actually works — it depends only on the
  encoder's output, which never changes across steps — so `decoder_step` now
  computes it once, on the priming call, and holds it fixed for the rest of
  the decode rather than reading it back from `present.*` again.
- **The priming pass's own attention was leaking into the alignment.**
  `AttentionCollector` gathers cross-attention rows per decoder call and
  `decode` appends them into per-head buffers that `build_attention` later
  reads as one `ENCODER_FRAMES`-sized block per *generated* token, starting
  at offset 0. The first version of `decode` merged the 4-token prompt's
  attention into that buffer before any real token's. Every real token's
  alignment was therefore reading the row belonging to the token **4
  positions earlier** — which is silent corruption, not a crash: the output
  still had the right shape, still passed the "monotonic, nonempty" checks,
  and simply put most of the words at the same timestamp. Fixed by never
  merging the priming call's attention in the first place — `collect()`
  already clears its pending buffer before every real call, so leaving the
  priming rows unmerged is enough; nothing needs to be explicitly discarded.

Confirmed together, against 8 s of speech synthesised with the Windows speech
synthesiser (`scripts/make-speech-fixture.ps1` — chosen over a real recording
because it needs no licence and reproduces byte-identically on the same
machine): the transcribed text matched the reference exactly, and per-word
timestamps came back evenly spread across the whole clip, strictly advancing,
each word landing at a plausible position for a spoken sentence at that pace.
This is real evidence the decoder and the alignment are both producing
correct output, not merely that they run without crashing.

### 7.7 A shipped bug this phase's own investigation uncovered

Reading the decoder's ONNX graph — to know what shape of cross-attention
output the Rust DTW pass needed — is what exposed that
`onnx-community/whisper-base` has no such output at all. That meant the
**WebView path currently in production has never successfully transcribed
anything**: `return_timestamps: 'word'` throws against that model, and
`whisper.js`'s `transcribe` had no catch around the call, so the throw
propagated and failed the whole transcription, not just the word timing.

Fixed independently of the Rust rewrite, since it is a shipped-app bug, not a
phase-3 concern: `DEFAULT_MODEL` now names `onnx-community/whisper-base_timestamped`
(the same weights, exported with `output_attentions=True`), and `transcribe`
falls back to segment timestamps rather than propagating if word timing is
ever unavailable again. Measured the same way as the Rust side: both model ids
run against the same synthesised-speech fixture through this exact pipeline
configuration — the old id threw the "must contain cross attentions" error,
the new one returned 11 word-level chunks, and both agreed on the text at
segment level.

### 7.8 Phase 4 as built: profiled, mostly declined

The phase's own instruction was "profile before building", and the profiling
retired both of the fixes it proposed — the estimate that motivated them was
~40–130× too high, and Tauri's binary channel is *slower* than the eval-based
`emit` it would have replaced. §6 carries the numbers and the reasoning.

What shipped is the finding the profiling did support: three quarters of every
audio frame is a waveform that only MilkDrop reads, so it is now sent only
while something is asking for it. `set_audio_waveform` (command) ·
`audio::build_payload` (Rust, unit-tested) · the demand gate in `audio.js`
(unit-tested through a fake backend, including the older-backend and
absent-`t`-key cases).

Recording a declined phase rather than deleting it is the point: the next
person to notice 1536 bytes crossing the boundary 50×/second should find the
measurement instead of repeating it.

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
| ~~Audio IPC costs 1.5–5% of the main thread~~ | **Withdrawn.** Was an extrapolation from a published `JSON.parse` benchmark; measurement put it at 0.038% of one core — see §6. |
| Audio IPC costs 0.38 ms per second of main thread | **Measured** on V8 (node 24), 200k iterations, median of 7 runs, unique script per frame. Excludes WebView2's out-of-process `ExecuteScript` overhead, which is not measurable from a node harness. |
| Tauri `Channel` raw frames are slower than `emit` at this size | **Measured** (0.0030 vs 0.0023 ms/frame) and **read from source** (`channel.rs`: a JSON number array under 1 KB, a `fetch` round trip over it). |

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
