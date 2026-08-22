# The Job Engine — offline compute backend

**Status:** Phase 1 landed except the SQLite journal, which moved into Phase 3 and is done (§7.1, §7.7). Phase 2 landed except the local-folder `Idle` backfill, which moved to Phase 7 (§7.2). **Phase 3 is complete**: the sidecar transport (§7.3), the log-mel front end (§7.4), Silero VAD (§7.5), the Whisper encoder/decoder + DTW word alignment (§7.6), model downloading + crash-safe transcription (§7.7), and native SMTC loopback recording (§7.10) are all in — a fresh install can transcribe either a local file or a song heard over SMTC end to end, and survive a crash mid-transcription without losing the work. Deleting `whisper.js` was the one item dropped rather than done, deliberately: §7.10 explains why the WebView path stays as the vocal-isolation fallback. Phase 4 closed — profiled, and the fixes it proposed were rejected on the measurements (§7.9). **Phase 5 is built, wired, and now called for real** (§7.11): a free key was entered 2026-08-22 and the live AcoustID round trip passed. **Phase 6 is complete**: offline beat tracking (§7.12, closing the measured 138 → 174 BPM tempo bug), key detection (§7.13), structure segmentation (§7.14) and loudness normalisation (§7.15). **Phase 7's library indexing half is done (§7.16); its diarization half (§5.8) is built and tested against the real pinned model 2026-08-22 but not yet wired to a live caller** — see §5.8 for exactly what's missing and why.
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

### 5.9 The VAD is a speech detector, and that bounds transcription — **measured 2026-08-22**

Found while building §5.8, and worth more than §5.8 is: **Silero does not
detect sung vocals over dense electronic production at all**, which means
auto-transcription silently cannot work for that class of song. Three tracks,
one probability per 512 samples (`vad::tests::dump_vad_probabilities`):

| | p50 | max | voiced @0.50 | voiced @0.05 |
|---|---|---|---|---|
| rap vocals (Seedhe Maut) | **0.967** | 1.000 | 79% | 81% |
| sung hook over EDM | 0.000 | 0.472 | 0% | 3% |
| instrumental (deadmau5) | 0.000 | 0.314 | 0% | 0% |

Silero is bimodal and very sure of itself. Rap reads as speech and the
pipeline works beautifully on it. A sung hook scores **flat zero through every
bar the vocal actually occupies** — on the EDM track the probability only
leaves zero in the first 20 seconds, and the hook is not there.

Two obvious fixes were measured and **both rejected**:

- **Lower the trigger.** At 0.05 the sung track yields 3% of itself — useless
  for transcription — and the floor is by then close to an instrumental
  track's own noise.
- **Transcribe the whole clip when the VAD finds nothing.** A sung track (max
  0.472) is not separable from a genuinely instrumental one (max 0.314), so
  this would hand Whisper seven minutes of deadmau5 and get confident invented
  lyrics back — precisely the hallucination `vad.rs` exists to prevent.

**Shipped behaviour changed** to stop the pipeline claiming the audio has no
voice in it — it now says what happened and names the remedy (vocal
isolation).

**And the remedy is now proven.** The same EDM track was run through Demucs
(`htdemucs_ft_vocals`, the model `demucs.js` already names) and re-measured:

| | p50 | max | voiced @0.50 |
|---|---|---|---|
| mix | 0.000 | 0.472 | **0%** |
| isolated vocal | **0.759** | 1.000 | **72%** |

Elevated across every 10-second bucket, so that is a whole track becoming
transcribable rather than a fragment recovered. On the rap track isolation
takes an already-good p50 0.967 to 1.000, so it costs nothing where the VAD
already worked.

**Demucs ahead of the VAD is therefore the fix, and the blocker is placement
rather than doubt** — Demucs lives in the WebView and the sidecar cannot reach
it, so it needs porting to `ort`. Measured cost: 165 MB model, ~0.6x realtime
on CPU (69s for 120s), which an Inference-lane job that already runs a Whisper
decode can afford. **Not yet scoped as work.**

That run also verified `demucs.js`'s contract end to end for the first time —
its header still says "not yet run against the live model". Silero does not
score 0.759 on noise, so its segmentation, overlap-add and stem indexing are
right.

### 5.8 Speaker diarization for featured artists — **backend built, not wired to a caller**

`attribute.rs` guesses per-line artist attribution from *text* via an LLM.
Audio diarization (speaker embeddings + clustering) actually knows who is
singing. This was "late phase, or never" as written — done sooner than that,
2026-08-22, once a viable model was found and verified rather than assumed.

**The model problem this section worried about was real.** Unlike Whisper
(`onnx-community`'s authoritative export), no first-party ONNX speaker-
embedding export exists — only small, zero-download community re-uploads.
Two candidates were inspected: a SpeechBrain ECAPA-TDNN export (needs an
opaque auxiliary binary to reproduce its exact feature preprocessing) and an
export of the ResNet34 backbone from `pyannote/wespeaker-voxceleb-resnet34-LM`
— the same model pyannote's own diarization pipeline uses — whose Kaldi-fbank
recipe is fully specified inline on the card. The second was picked, actually
downloaded, and run end-to-end before being pinned (`models.rs`'s
`DIARIZATION_FILES`, real SHA-256, not copied from the card).

**What's built and tested:**
- `sidecar/src/fbank.rs` — the Kaldi-fbank front end the model requires
  (frame/hop, hamming window, `round_to_power_of_two`, preemphasis, per-
  utterance mean subtraction), unit-tested for shape and framing correctness.
- `sidecar/src/diarize.rs` — loads the pinned ONNX model, embeds fixed
  windows of audio, greedy single-pass clustering by cosine similarity
  (capped at `MAX_SPEAKERS`, mirroring `attribute.rs::MAX_ARTISTS`).
  `diarize_real_model_produces_sane_embeddings` (`#[ignore]`d, needs the real
  model on disk) ran the actual pinned model: deterministic output, and a
  same-signal pair scored a clearly higher cosine similarity than a
  different-signal pair — real evidence the graph and front end agree with
  each other, not proof this separates two real singing voices in a mix.
- `inference-protocol`: `Request::Diarize` / `Response::Diarized` /
  `Stage::Diarizing` / `SpeakerSpan`, protocol version bumped to 2.
- Host: `inference::diarize` (mirrors `inference::transcribe`), a
  `diarize_local_file` Tauri command on its own Inference-lane job, gated by
  the existing `model_consent` flow against its own independent model file
  (`models::ensure_diarization`) — kept separate from the Whisper/VAD set so
  the existing consent prompt's "Whisper + a voice detector" copy stays
  accurate for everyone who never touches this feature.
- `attribute::refine_with_diarization` — fills LLM-unresolved (`-1`) lines
  from the majority vote of already-attributed lines sharing that line's
  diarization cluster. Pure and unit-tested; never overwrites a confident
  answer.

**UPDATE 2026-08-22 — first run against real music. The plumbing works; the
capability does not, and that is now measured rather than suspected.** Three
bugs were found and fixed (no VAD gate, so an instrumental intro produced four
of six clusters; the `MAX_SPEAKERS` cap silently switching the algorithm from
"threshold" to "force-join nearest" once full; spans overlapping, reporting
318.8s of coverage on a 304.1s track). Greedy single-pass assignment was
replaced with agglomerative clustering, because greedy could not recover from
its own start. Coverage went 4.3s → 241.3s of 241.3s voiced.

None of which made it *work*. On Seedhe Maut — "Red", a duo, the similarity
distributions overlap almost entirely (same-voice median 0.650; different-voice
median 0.350 but **max 0.655**), and **forced to exactly two clusters it
returns 320 windows against 1**. There is no two-lobed structure in the
embedding space, so this is not a threshold to tune or an algorithm to swap —
the distinction is not in the embeddings. The model is VoxCeleb-trained (clean
speech, one speaker per recording) and the same beat running under both artists
plausibly dominates what it encodes.

**That test has now been run, and it closes the question.** Removing the
instrumental was the obvious explanation — the same beat under both artists
dominating the embedding — and it is wrong. Against Demucs-isolated vocals:

| | adjacent median | far-apart median | forced k=2 |
|---|---|---|---|
| full mix | 0.650 | 0.350 | 320 : 1 |
| isolated vocal | 0.672 | 0.304 | **154 : 1** |

Marginally better separation, nowhere near enough, and the forced two-way
split is as degenerate as it was on the mix. These two voices are not
distinguishable in these embeddings with or without the drums. What remains is
the model or the task itself, and either is a far larger question than §5.8 is
worth. **Treat diarization as parked, not in progress.**

**Not done: nothing calls any of this automatically yet.** `resolve_attribution`
fires off lyric text alone, at the point lyrics are fetched — before playback,
before any audio exists. Diarization needs raw audio, which today only exists
in this pipeline when a song needs transcription (no synced lyrics found).
Wiring diarization into the common case (an already-synced song) needs audio
capture to happen for attribution's sake too, not only transcription's — a
real, scoped next step, not a stub. `diarize_local_file` is callable by hand
in the meantime against any local file.

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
| **3** ✅ | Inference sidecar: `ort`, mmap PCM transfer, framed stdio, **Silero VAD + Whisper** (word-level, DTW-aligned), models download and verify themselves, SQLite journal, **native loopback recording** so SMTC playback reaches the same pipeline (§7.3–7.7, §7.10). Demucs is the one thing still only in the WebView, which is why `whisper.js` stays. | Medium — new binary, model loading, new IPC protocol | Yes — faster, no stutter, fewer hallucinations |
| **4** ✅ | Binary / derived audio IPC. **Profiled; both fixes rejected** — the cost was 0.038% of a core, not 1.5–5%, and Tauri's binary channel is slower than its eval-based `emit` at this size. Shipped instead: a waveform demand gate, 2179 → 804 B/frame. See §6 and §7.9. | Low, unproven value | No |
| **5** ✅ | Fingerprinting → AcoustID (5.1). Fixes browser metadata. **Built, wired, and now called for real** — `fingerprint.rs`, `acoustid.rs`, `musicbrainz.rs`, hooked into the transcription path (§7.11). A key was entered 2026-08-22 and the live round trip passed; both halves are now verified live. | Medium — new network dependency, needs an AcoustID API key | **Yes — correct lyrics on YouTube** |
| **6** ✅ | DSP suite: **beat tracking (5.3) done** — Ellis DP tracker, one global tempo, real beat positions (§7.12). **Key (5.5) done** — chroma + Krumhansl-Schmuckler, tempo chip and palette tint (§7.13). **Structure (5.4) done** — Foote novelty over the same chroma, feeding the heat map's existing section naming (§7.14). **Loudness (5.6) done** — EBU R128 integrated loudness driving a per-track gain on the live envelope (§7.15). Pure Rust, incremental. | Low each | Yes — visuals |
| **7** 🔶 | Library indexing (5.7) — **done (§7.16):** persisted watch-folder list, background rescan, and Idle-lane pre-analysis (beat map, key, structure, loudness) of everything it finds. Diarization (5.8) — **backend built and verified against the real pinned model 2026-08-22; not wired to a live caller** (see §5.8). | Medium / high | Yes — a watched folder survives a restart and pre-analyses itself in the background |

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

**The SQLite journal — deferred here, landed in Phase 3 (§7.7).** It was
deferred out of Phase 1 for reasons that turned out to still be right once it
was actually built: every job that existed then repaints the *playing* song,
and nothing is playing at startup, so replaying one onto an idle overlay would
be worse than losing it — and `Runnable` is a boxed trait object holding an
`AppHandle`, which cannot be serialized, so a journal could not simply persist
the job type directly. §7.7 explains the shape that resolved both: the
journal is scoped to exactly the one job worth resuming (transcription), and a
resumed job writes to the cache silently instead of going through `Runnable`
at all.

The rest of §4 — a general cache index and FTS5 over lyric text — is
independent of the journal and stays unstarted; see §7.7 for why it was
deliberately not bundled in alongside the journal.

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

Still to come in this phase (stages 2–5 and §7.10 closed the rest of this
list): native song-length loopback recording so the SMTC path needs no PCM
over IPC, the SQLite work, and only then deleting `whisper.js` and its ~26 MB
of vendored WASM. The last of those did not happen — see §7.10.

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

### 7.7 Phase 3, stage 5: models that actually download, and a crash that no longer loses the work

Two gaps closed together, because the second needed the first to be testable
end to end.

**`models.rs`: the download `inference.rs::model_dir`'s own doc comment
always claimed happened, and never did.** Before this landed, nothing in the
app ever wrote a file into that directory — every real transcription attempt
on a fresh install failed inside the sidecar with "model file not found",
which is a correct message pointing at the wrong fix (the fix was never
"reinstall", it was "nothing ever fetches the model"). `models::ensure` now
downloads and SHA-256-verifies the six files the sidecar needs (five Whisper
`_timestamped` artifacts, one Silero VAD), each pinned to an exact source
**commit**, not a branch — the same reasoning as `mel.rs`'s pinned reference
numbers: "the file at this URL" is not a stable identity, and a silently
different file would make transcription silently wrong rather than fail
loudly. Verification only runs once, right after a download; an
already-present file is trusted on size alone, which is what keeps `ensure`
cheap enough to call before every single transcription rather than only at
install time. `models::tests::every_file_downloads_and_verifies_against_the_real_sources`
(`#[ignore]`d) is the proof this actually works against the real hosts, not
just against the table of hashes — run it after touching any URL or hash here.

Mirrors the shape `whisper.js` already had for the WASM path (model fetched
lazily on first use, cached after), so this is not new user-facing behaviour,
only a real implementation of behaviour the app already claimed to have.

**`journal.rs`: the SQLite journal §7.1 deferred, scoped down to what §2.4
actually asked for.** §7.1's reasons for deferring still applied once this was
built — every OTHER job type repaints the *playing* song, so replaying one at
startup (when nothing is playing) is a regression, not a feature — so the
journal is deliberately narrow: one table, one job type (transcription),
**presence means incomplete**. A row is inserted right before a transcription
starts and deleted the moment it ends, success or failure or cancellation
alike — so a row still present at the next startup can only mean the process
ended without running that code, i.e. a crash, and the PCM temp file it
names (normally deleted by `Session::drop`, which a hard kill never runs) is
still on disk, decoded and resampled, waiting for a decoder that never got to
run against it.

`inference.rs::pcm_temp_path` is the one place that knows the temp-file naming
format; `write_pcm` uses it to create the file, `journal::start` is given the
same path to record before the sidecar spawns, and `resume_stale_transcriptions`
reads it back — a deliberate single source of truth, because two independently
written copies of that format string is exactly the kind of thing that drifts.

A resumed transcription cannot go through the same path a live one does,
because it must never repeat what §7.1 first ruled out: `finalize_transcription`
now takes a `quiet` flag (`finalize_transcription_inner`) that keeps every
cache write and drops every `transcribe-progress` emit. This is not only about
the `lyrics` overlay — `setStatus` in the renderer is a global one-line status
indicator, not track-scoped, so an unsuppressed "matched real lyrics" from a
resumed background job at startup would read as being about whatever song the
user starts next. Same asymmetry Phase 2's precompute already relies on: a
cache write nobody sees is safe, a status message about the wrong song is a
visible glitch.

**Deliberately not bundled in:** §4's other two SQLite jobs — a general cache
index queryable by artist/album/"has beatmap", and FTS5 over lyric text for
"find the song with this line". Both are real, both are independent of the
journal, and neither is required for Phase 3 to be complete or for
transcription to work — §4 itself calls them "niche capabilities," not
infrastructure. Building them now would mean touching the JSON-file lyric
cache that Phase 2's "songs start instantly" win depends on, for a feature
nothing yet asks for. Left for a phase whose actual purpose is search/browse,
same as 5.3–5.6 waited for a DSP phase rather than riding along with the VAD
that happened to need `rustfft` too.

### 7.8 A shipped bug this phase's own investigation uncovered

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

### 7.9 Phase 4 as built: profiled, mostly declined

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

### 7.10 Phase 3, stage 6: recording the song in the backend that already hears it

The last structural gap. Local files reached the sidecar from stage 1, because
Rust decodes them anyway; **SMTC playback — a browser, Spotify, anything this
app does not control — still went through the WebView**, where `capture.js`
accumulated a `ScriptProcessorNode`'s output and handed `transcribeAudio` a
multi-megabyte `Float32Array` so that Rust could see it at all. That was the
one remaining reason for whole-song PCM to cross IPC, and it was never
necessary: `audio.rs` has run a WASAPI loopback thread since the native audio
path landed. The samples were already in the backend; only the plumbing said
otherwise.

So `audio.rs` taps its own capture thread a second time. `start_recording`
opens a `RecordingSink` — raw mono f32 at the device's native rate, streamed to
a temp file — and the packet loop appends to it. `stop_recording` hands back
`(path, rate)`; `discard_recording` throws it away when real lyrics turn up
mid-song. Nothing but a track object crosses IPC in either direction, and
`stop_native_song_recording` feeds
`run_native_transcription` — the function `transcribe_local_file`'s job was
split into for exactly this — so from the resample onwards the two sources are
indistinguishable: same model download, same journal row, same sidecar, same
`finalize_transcription`.

Three decisions worth recording, each because the alternative fails quietly:

- **The renderer asks which recorder it may use; it does not infer one.**
  `AudioReactive.isActive()` is true for *both* capture paths, and the
  getDisplayMedia fallback has no WASAPI thread to tap — the audio exists only
  as a `MediaStream` inside the WebView. Deciding from `isActive()` would
  produce a recording of pure silence with no error anywhere. Instead
  `startNativeSongRecording` returning false *is* the signal to fall back
  (`src/renderer/listen.js`), which is the same lesson 0.21.0's `SetParent`
  bug taught: ask the system what happened.
- **A packet whose rate does not match the sink's is dropped, not appended.**
  Capture can stop and restart inside one recording (♫ toggled, device
  changed), and a restart can open at a different format. Concatenating 44.1
  and 48 kHz into one file does not fail — it produces a transcription whose
  timestamps drift, which nothing downstream can detect.
- **Recordings are swept at startup, not journaled.** A transcription is worth
  resuming after a crash (§7.7); a *recording* is not — it only makes sense
  while its song is still playing. But the file survives, and at native rate a
  capped 12-minute one is over 100 MB, so `sweep_stale_recordings` deletes
  temp files from other pids that have gone an hour untouched. An hour, not
  twelve minutes, because a recording that hits its cap stops being written
  while still perfectly live; other pids and not this one, because the app has
  no single-instance guard.

**`whisper.js` was not deleted, and that is the one item this phase dropped
rather than finished.** Its stated purpose was to remove ~26 MB of vendored
WASM once nothing needed it — but something does. Vocal isolation (§5.2's
Demucs) has never been ported to the sidecar, and it runs as a pre-pass on the
PCM *before* Whisper sees it, so the isolation and the transcription have to
live in the same process. Deleting the WebView path would silently delete that
opt-in with it. `listen.js` therefore routes an isolation-enabled recording to
the WebView deliberately, and the three files (`whisper.js`, `demucs.js`,
`capture.js`) are kept as a real fallback rather than as dead weight nobody got
round to removing. The 26 MB comes back when Demucs lands in the sidecar, not
before.

Tested where being wrong is invisible: `listen.js`'s recorder choice and its
start/stop race through fake dependencies that log what they were asked to do
(22 tests — a leaked recorder raises nothing, it just leaves a temp file), and
`audio.rs`'s sink, cap, rate check and sweep predicate as pure functions (the
sweep *deletes* files, so its decision is tested as
`is_abandoned_recording(name, own_prefix, age)` rather than by planting files
and trusting mtime granularity). What is not covered anywhere, and is the
honest boundary: the WASAPI thread itself calling `record_batch` once per
packet, which needs a real device.

### 7.11 Phase 5: identifying the song from the sound

§5.1's case in one line: SMTC from a browser reports the *video* title, every
lookup downstream inherits it, and no amount of text cleaning recovers a title
that was never in the string. `lyrics::clean_title` can strip `(Official
Video)`; it cannot turn a channel name into an artist.

Three modules, split by what can be wrong and how:

- **`fingerprint.rs`** — PCM in, a Chromaprint string out. Pure computation, no
  network, no key. `rusty-chromaprint` rather than a C binding, for the same
  reason `sha2` beat system OpenSSL: Windows needs no toolchain and nothing
  ships beside the exe. It also carries `FingerprintCompressor`, which is the
  part that actually matters — AcoustID does not accept raw u32 fingerprints,
  it accepts Chromaprint's own compressed encoding, and hand-rolling that
  format produces a request rejected for reasons no local test reproduces.
- **`acoustid.rs`** — when to ask, what to send, how to read the answer, and
  which candidate to believe. Everything here is offline and tested offline
  except the one `ureq` call.
- **`musicbrainz.rs`** — MBID → canonical credit, keyless. Not the happy path
  (`meta=recordings` usually inlines the metadata) but genuinely reached: a
  fingerprint AcoustID knows, linked to a recording it returned bare, is
  common. It is also the *better* source when reached — MusicBrainz carries
  the join phrases (`"A feat. B"`) that AcoustID's flat name list loses, and
  that string goes straight into a lyric search.

**Where it runs, and why not as a job of its own.** Identification is hooked
into `run_native_transcription`, not given a `Job` variant. That is the one
moment the app already holds a song's worth of decoded PCM, so identification
costs a fingerprint pass and one request instead of a second recording — and
it is also where a wrong title does the most damage. A transcription of a
mislabelled song finds no real lyrics to align against, so `align.rs` is
skipped and Whisper's mishearings get written to the cache as *the* lyrics for
that song, permanently. Identifying first is what turns that into a real
alignment.

**The subtlety worth writing down: the corrected name must not become the
cache key.** `finalize_transcription_inner` derives `key` from the *player's*
metadata and applies the identification strictly after, because the next play
of that song will report the same video title again and look under the same
garbage key. Caching under the true name would mean identifying, transcribing,
and then never finding the result. So the true name drives the plain-lyric
fetch, the LLM's correction context, and what is shown on screen; the key stays
what the player says.

**Two decisions made in the direction of doing nothing:**

- **`worth_identifying` is narrow on purpose.** A bare `" - "` in a title is
  not a signal — Spotify's own catalogue is full of `"Song 2 - Remastered
  2012"`, and firing on those would spend a fingerprint and a request on most
  of a normal library. What does fire: no artist at all, a channel-shaped
  artist (`VEVO`, `- Topic`, `Records`), unambiguous platform noise (`official
  video`, `lyric video`, `[4K]`), a pipe, or the artist repeated at the front
  of the title (`"Seedhe Maut - Nanchaku"` credited to `Seedhe Maut` — a media
  player never does that, an upload almost always does).
- **`MIN_SCORE` is 0.8 and a duration mismatch is fatal.** A wrong
  identification is worse than none: it rewrites the track's identity for the
  lyric lookup, the artwork, the play history and the cache, and none of those
  can tell they were lied to. A genuine match on clean audio scores well above
  0.9, so the band below 0.8 is where a noisy capture brushes against a
  different recording. The duration check catches the specific near-miss that
  scores high anyway — the radio edit instead of the album cut, whose lyrics
  do not line up.

**What is verified and what is not.** The fingerprinter's algorithm id, its
determinism, that different audio fingerprints differently, that the encoding
is URL-safe base64 whose header declares the algorithm, that the cap works,
and — the property AcoustID actually relies on — that a time-shifted copy of
the same audio still matches under `match_fingerprints`. The AcoustID request
shape, response parsing and candidate choice are covered against fixtures,
including the mistake that would be invisible in production: sending the
analysed excerpt's length as `duration` instead of the whole track's, which
lowers every score behind a perfectly successful HTTP 200. **MusicBrainz is
verified against the live service** (`a_real_recording_resolves`, `#[ignore]`d
— it returns `Queen / Bohemian Rhapsody / 355s`).

**AcoustID has now been called for real (2026-08-22).** A free application key
was entered — `ACOUSTID_API_KEY` in `keys.json`, same mechanism the 🔑 panel
writes — and `acoustid::tests::a_real_lookup_answers` passed against the live
service: it deliberately fingerprints synthetic audio that matches nothing, so
a pass proves the request is *accepted* and the response parses, without
depending on any particular song being in the index. `available()` is true on
this install from the next launch onward. **Still open:** that test proves the
request/response shape works, not that a real recording's fingerprint returns
a correct, confident match — nobody has run the full loopback-capture →
fingerprint → AcoustID → MusicBrainz chain against a real song playing through
a browser tab yet. Treat *that* end-to-end path as the remaining plausible-not-
proven piece, not the API call itself.

### 7.12 Phase 6, part 1: the beat grid, and the tempo bug it closes

§5.3's case is the only one in this document backed by a bug the app actually
shipped: on a real 138 BPM track the live estimator reported **174**. That is
not a tuning failure. A causal estimator watching a rolling window has to
commit before the evidence that would settle the question has arrived, and
inside any one window a syncopated bar is indistinguishable from a faster
tempo. Nothing you can do to a streaming estimator fixes that; you have to
stop streaming.

`beats.rs` is Ellis's dynamic-programming beat tracker (2007) — the standard
answer, and ~150 lines of arithmetic:

1. **Onset strength envelope** — half-wave-rectified spectral flux over 40
   log-spaced bands, log-compressed, then flattened against its own local mean
   over 1.5 s. That last step is what stops the DP putting every beat in the
   loudest chorus.
2. **One global tempo** — autocorrelation of that envelope, weighted by a
   log-Gaussian centred on 120 BPM. The weighting is load-bearing, not
   cosmetic: a click train's autocorrelation peaks just as hard at two and
   three times the true period, and nothing in the signal says which is "the"
   tempo. Without it a 138 BPM track can be reported as 69 with complete
   confidence.
3. **The grid by dynamic programming** — every beat placed where the envelope
   is strong *and* the spacing from the previous beat is near the global
   period, maximised over the whole song at once. This is the step a streaming
   tracker cannot perform, and the reason the result cannot drift: there is one
   period for the entire track, so a syncopated bar would have to pay a penalty
   for every beat after it as well.

`aubio` does all this too, but binds to a C library that is a real build burden
on Windows (§5.3 said so and it is still true). `rustfft` was already a
dependency, so this adds nothing to the tree.

**Two things it returns beyond a BPM, and both matter.**

- **The beat positions, not just the period.** The renderer's clock previously
  took its phase from `Tempo.phaseFor`, which needs live loopback capture — so
  with ♫ off, which is most of the time, the period was exactly right and the
  phase free-ran and slid against the music. `SongAnalysis.beatPhaseAt` reads
  the current playback position against the measured grid instead, and needs no
  audio at all. It also reads the *grid*, not an assumed period, because a real
  grid breathes.
- **A confidence.** Normalised autocorrelation at the chosen period. An ambient
  or rubato track scores low and gets no grid, which is the correct answer —
  the failure mode worth avoiding is a tracker that always answers and hands
  the visuals a beat clock for music that has no beat.

**Where the tempo number now comes from.** `applyAnalysis` prefers
`result.beats.bpm` over `Tempo.estimate(onsets)` and reports which it used. The
lock-in machinery downstream is unchanged — `Tempo.setPrior(bpm)` already
existed and already stops the live estimator re-deriving and overwriting a
known tempo — so this replaces the *value* fed into a mechanism that was
already right, rather than rebuilding it.

**Cost:** 30 s of audio tracks in 0.02 s in a release build, so a four-minute
song is around 0.15 s, on a thread that had already decoded the file.

**Tested against click trains whose answer is known by construction**,
including one at 138 BPM specifically because that is the case that was wrong.
Beyond the tempo, three properties that a BPM assertion alone cannot see: that
the grid lands *on* the clicks within two hops (a grid can have exactly the
right tempo and be half a beat out of phase, which passes every BPM check and
looks wrong in every frame), that it spans the whole song rather than a
confident fragment, and that silence produces no grid at all. The onset
envelope is checked separately for being peaked rather than flat — a flat
envelope still yields a confident-looking tempo and an evenly spaced grid of
nothing.

### 7.13 Phase 6, part 2: musical key, and refusing to name one

§5.5, in two steps neither of which is large. **Chroma**: fold the spectrum
onto the twelve pitch classes, so a song in A minor puts weight on A, C and E
regardless of which octaves they were played in — the invariance the method
needs and the reason a raw spectrum will not do. **Krumhansl-Schmuckler**:
correlate that twelve-vector against the twenty-four published key profiles
(twelve rotations each of a major and a minor template, measured from listener
ratings) and take the best.

The STFT here is four times `beats.rs`'s window and *not* shared with it,
because the two want opposite things: a beat tracker needs time resolution to
place a transient, a key detector needs frequency resolution to tell a low C
from a low C♯. 8192 samples at 44.1 kHz is 5.4 Hz per bin, which separates
semitones down to about F♯2.

**The failure worth engineering against is being confidently wrong.** Key
detection on real recordings is hard — a mix with heavy sub-bass and dense
percussion has chroma dominated by noise, and the correlation will still name
a key without hesitation. So the confidence is the **margin over the best
differing key**, not the raw correlation: the runner-up is almost always the
relative major/minor or the dominant, which share most of their notes, and
every plausible key correlates highly at once. Below a threshold `detect`
returns nothing. Saying nothing is a fine answer; tinting the whole app for a
key the song is not in is not.

Two things the tests caught that nothing else would have:

- **A transposition error in the published major profile.** The constant had
  been written with one value dropped and a made-up one appended. Nothing
  fails when that happens — no panic, no wrong shape, just a detector that
  quietly favours the wrong keys for a whole class of songs. The test that
  found it asserts the profile's peak is its tonic and that each mode favours
  its own third, which is the structural claim the numbers exist to make.
- **Pearson correlation is scale- and contrast-invariant.** A first attempt at
  a confidence test blended a profile toward flat and expected less certainty;
  the correlation was identical to fifteen decimal places. That is a property
  worth having (a quiet passage and a loud one in the same key must agree, or
  the key would appear to change when the chorus arrives) and it is now
  asserted rather than assumed.

**Where it shows up.** The tempo chip becomes `♩ 128 · F# minor`, and the
palette is tinted by mode — minor toward blue, major toward amber. That tint
is a partial nudge *toward* a target hue, not a fixed rotation, because a fixed
rotation warms a blue palette and cools a red one; the wraparound in
`hueTowards` is the part that can be quietly wrong (350° → 10° is +20, not
−340) and is unit-tested. Applying it also forced the two duplicated
palette-assignment blocks — one for the artwork palette, one for the mood
palette — into a single `applyPalette`, since a tint applied to only one of
them would recolour the app differently depending on which pass answered last.

### 7.14 Phase 6, part 3: where the song changes section

§5.4, by Foote's method, on the chromagram key detection already computes.
Build the self-similarity matrix — a song's has visible square blocks along
the diagonal, because within a chorus every frame resembles every other — then
slide a **checkerboard kernel** down it. The kernel is positive on the two
"within a block" quadrants and negative on the two "across the boundary" ones,
so its response spikes exactly where the music stops resembling itself. The
peaks of that response are the boundaries.

**Why not the energy tiers `heatmap.js` already derives.** Those split a song
where its *loudness* changes, which is a decent proxy and wrong in two common
cases: a verse and a chorus at the same level read as one section, and a
crescendo inside one section reads as two. Chroma novelty splits where the
*harmony* changes, which is what a section boundary is.

**The two compose rather than compete**, and that is the part worth copying
elsewhere. `structure.rs` supplies *where* the boundaries are; `HeatMap`
still names and levels each resulting section exactly as before, so `kind`
("drop", "build", "verse") means what it always meant and every existing
consumer — the timeline, the drop countdown, `sectionAt` — needed no change.
`setSections(null)` returns to the tier fallback, which is what every SMTC
track and every local file too uniform to commit to a boundary still uses.

**A relative threshold cannot refuse, and that was a real bug.** The first
version accepted peaks more than one standard deviation above the novelty
curve's mean. A song that never changes harmony has a novelty curve flat at
approximately zero — so its standard deviation is also approximately zero, and
floating-point noise is many sigma above the mean. It found boundaries in a
single sustained chord. The fix is a second, absolute floor expressed as a
fraction of what a *perfect* boundary would score (about half the kernel's
total magnitude, since the positive quadrants see similarity 1 and the
negative ones see 0), so it stays meaningful if the kernel size ever changes.

Peaks are also taken strongest-first rather than left-to-right: two candidates
closer than the minimum section length are resolved in favour of the better
one, where a forward scan would keep whichever came first and suppress a
stronger boundary just after it.

**Deliberately not done:** naming sections by repetition — the A-B-A-B-C that
would let "chorus" mean the one that recurs. That needs segment clustering on
top of this and nothing consumes it yet; the boundaries are the part with a
consumer today.

### 7.15 Phase 6, part 4: loudness, and the two things it must not correct for

§5.6, and the smallest item in the phase. The visuals react to how loud the
audio is, so today they also react to how hard the track was *mastered*: a
modern release pinned at −6 LUFS drives everything to the ceiling and a
dynamic recording at −20 barely moves it, even though a listener would call
them equally loud.

**The peak normalisation already in `analysis.rs` does not cover this.** That
scales each track's envelopes by its own *peak*, which two recordings can share
while sounding nothing alike — a compressed master has far more energy under
the same peak than a dynamic one. EBU R128 measures gated mean loudness through
a K-weighting filter, which is a model of perceived loudness rather than of the
waveform's extremes. The `ebur128` crate is the reference implementation rather
than a re-derivation, which matters here: those filter coefficients and the
two-stage gating are fiddly, published, and produce a plausible-looking number
when subtly wrong.

Two things it deliberately does not correct for:

- **System volume.** The live path hears whatever the user's volume knob is
  set to. That is their choice about the room they are in; the master's level
  is not. Correcting for it would also be a feedback loop — the visuals would
  fight every volume change, which is exactly the shape of the v0.11.0
  governor bug §3.2 warns about.
- **Anything unmeasured.** Every SMTC track, and any local file too short or
  too quiet for R128 to report on, gets a gain of exactly 1. The gain is reset
  to 1 on every track change rather than latched, because a previous song's
  correction applied to this one is confidently wrong in a specific direction,
  which is worse than absent.

Applied to the four band levels after they are averaged, **not** to the
spectrum. The centroid, the flux and the band shape are all ratios within one
frame, so scaling every bin by a constant changes none of them — doing it there
would cost a pass over 512 bins per frame for no effect. And the setter rejects
implausible values back to 1 instead of clamping them: clamping silently
accepts a caller that has gone wrong, where this is a bias toward a reference
level and a gain of 40 is a bug, not a very quiet record.

**Phase 6 is complete.**

Phases 2 and 5 are where a user would actually notice. If the goal is impact
per unit of work, **1 → 2 → 5 → 3** is a defensible reordering of the middle.

---

### 7.16 Phase 7: a library that survives a restart, and keeps itself analysed

§5.7's actual gap, before this: `open_local_folder` (§ above, `playback.rs`)
scans a folder once, on click, and hands the result straight to the queue.
Nothing about the folder itself is remembered — close the app and reopen it,
and every folder has to be re-picked and re-scanned from a blank slate, and
nothing is pre-analysed until the moment it's actually played.

**Landed** (`library.rs`, `commands/library_cmds.rs`):

- `Prefs.library_folders: Vec<String>` — the watch list, persisted the same
  way as every other preference. Just the list; scan results live in their
  own file (`library-index.json`) so this stays small even at a few thousand
  tracks.
- A manual, bounded-depth folder walk (`scan_folder`) rather than a `walkdir`
  dependency — matching this codebase's habit of reaching for `std` first.
  Symlinks are not followed, and a depth cap backstops a cycle that check
  somehow misses.
- `rescan` diffs a fresh walk against the persisted index — new file, changed
  file (size or mtime moved), or gone (deleted, or its folder was dropped
  from the watch list) — and emits `library-changed` with the counts. Pulled
  apart into a pure `diff_index` plus the I/O around it (load, walk, save,
  emit) specifically so the diff logic has unit tests that don't need a real
  `AppHandle` — the same shape `correct.rs`'s `merge_corrections` uses.
- `start_library_watcher`: one more `std::thread::spawn` loop alongside the
  SMTC and wallpaper watchers in `watchers.rs`, polling every 60s. Reads
  `Prefs.library_folders` fresh each tick rather than snapshotting it at
  startup, so adding or removing a folder takes effect without restarting
  the thread. 60s, not `SMTC_INTERVAL_MS`'s 250ms or the power watcher's 2s:
  a folder walk is real disk I/O, and library contents change on human
  timescales (copying in an album), not the sub-second timescales those
  other two watchers exist for.
- **The Idle-lane analysis backfill** — 5.7's other half. Each `LibraryEntry`
  now carries an `analyzed` flag, reset to `false` whenever `diff_index` sees
  a file appear or change and left alone when it doesn't. `queue_backfill`
  walks the index after every scan and submits one `LibraryAnalyzeJob` per
  unanalysed file at `Priority::Idle`, `Lane::Cpu` — one job per file, not
  one job for the whole backlog the way `PresyncJob` is, since this is
  CPU-bound local work with nothing to be polite to and should actually use
  the CPU lane's `N-1` worker threads rather than tie up one of them running
  everything serially. Each job runs the exact same DSP pass
  `analyze_local_file` runs on demand — pulled out as
  `playback::analyze_local_file_value` so there is one implementation, not
  two that could drift — strips the per-window envelope (live-reactive data
  the renderer wants during THIS play, not a durable summary; keeping it
  would multiply the cache by every song's sample count for nothing a cold
  backfill needs) and persists the rest (beats/key/section
  starts/loudness/duration) to `library-analysis/<hash of the path>.json`.
  `INDEX_LOCK`, a plain `Mutex<()>`, serialises the index read-modify-write
  against several of these finishing at once across the CPU lane's threads —
  contention costs microseconds against DSP work measured in the hundreds of
  milliseconds (§7.12), so it is not a bottleneck.
- Three commands — `add_library_folder` (same picker + `AlwaysOnTopGuard`
  shape as `open_local_folder`, plus an immediate `rescan` so the count isn't
  stale until the next tick), `remove_library_folder`, `get_library_folders`
  (now also reporting `analyzedCount` per folder) — and matching
  `window.player` entries in `tauri-shim.js`
  (`addLibraryFolder`/`removeLibraryFolder`/`getLibraryFolders`,
  `onLibraryChanged`).
- A "Watched folders" strip inside the existing Library panel (`index.html`,
  `renderer.js`) rather than a new HUD chip — folders show their tail name,
  an "analysed/found" count, and a remove control, refreshed on
  `library-changed` while the panel is open.

**Not done:** diarization (5.8) — the backend (fbank front end, ONNX embedding,
clustering, the IPC/host wiring, a callable Tauri command) is built and
verified against the real pinned model; what's missing is a live caller, since
attribution's own trigger point runs before any audio exists for most songs.
See §5.8 for the exact gap. Phase 7's only remaining piece.

---

## 8. What is measured and what is not

Stated plainly, because several numbers here came from benchmarks that are not
this app:

| Claim | Basis |
|---|---|
| ~3 ms draw cost, ghost mode removes ~95% | **Measured** on this app, v0.11.0 |
| Live tempo drift 138 → 174 BPM | **Measured** on this app. **Closed in §7.12** — the offline DP tracker recovers 138 to within 2% on a synthetic 138 BPM train, and the grid it produces has no window to drift within. Not yet re-checked against that original real track. |
| Offline beat tracking costs ~0.15 s for a four-minute song | **Measured** — 30 s of audio tracks in 0.02 s in a release build. |
| `numThreads = 1` in the WASM path | **Read from source** (`whisper.js:65`) |
| Native multi-thread vs single-thread WASM: 3–8× | **Estimate** from the threading change alone |
| VAD roughly halves Whisper work | **Estimate** from typical vocal/instrumental ratio |
| Silero: 2.3 MB, <1 ms per 30 ms chunk | Published, third-party |
| ~~chromaprint-next bit-identical, ~4% faster than C~~ | **Not adopted.** §7.11 shipped `rusty-chromaprint` instead: `chromaprint-next` is at 0.1.0 and its docs.rs build 404s, while `rusty-chromaprint` 0.3.0 carries the `FingerprintCompressor` AcoustID requires. Both are pure Rust, which was the actual requirement. |
| The fingerprint survives a time shift | **Measured** on this app — `fingerprint::tests::the_fingerprint_follows_the_content_not_the_clock` matches a clip against a copy of itself offset by 2 s. |
| A MusicBrainz recording MBID resolves to a canonical credit | **Measured** against the live service (`musicbrainz::tests::a_real_recording_resolves`). |
| An AcoustID lookup returns anything at all | **Run for real, 2026-08-22** — `acoustid::tests::a_real_lookup_answers` passed against the live service with a real key. Proves the request/response shape; a real song's fingerprint returning a *correct* match is still unconfirmed — see §7.11. |
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
