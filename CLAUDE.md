# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows desktop app (Tauri 2 + WebView2) that detects whatever media is
playing anywhere on the system (via SMTC — Spotify, YouTube, any app) or
plays local files itself, and shows fullscreen beat-aware synced lyrics with
an audio-reactive visual backdrop. There is no Node/Electron process at
runtime — `node`/`npm` are only needed to develop and build it. See
`README.md` for user-facing feature docs and `docs/JOB-ENGINE.md` for the
background-processing design in depth.

## Commands

```sh
npm install
npm run tauri:dev          # run the app in dev mode
npm run tauri:build         # build the installer (runs vendor:sidecar first)
npm run probe                # print one SMTC "now playing" sample as JSON, standalone
```

### Tests and lint (exact commands CI runs — `.github/workflows/ci.yml`)

```sh
npm test                                                          # JS: node's built-in test runner, test/*.test.js
node --test test/mood.test.js                                     # a single JS test file
node --test --test-name-pattern="<name>" test/mood.test.js        # a single JS test by name

cd src-tauri
cargo test --workspace                                            # Rust: app + protocol + sidecar crates
cargo test --workspace <substring>                                # a single test / module (e.g. `stats::`)
cargo test --workspace -- --ignored <name>                        # a live test (network/API key/real audio — see below)
cargo clippy --workspace --all-targets --no-deps -- -D warnings   # exact CI lint gate; --all-targets so #[cfg(test)] is linted too
```

Live/`#[ignore]`d Rust tests need real credentials or fixtures and never run
in CI — e.g. `ACOUSTID_API_KEY=... cargo test --workspace -- --ignored acoustid`,
or `LYRIC_TEST_AUDIO="songs/Artist - Title.mp3" cargo test --workspace -- --ignored real_audio`.
`songs/` is gitignored (commercial audio) — point any such test at a local
file via env var rather than committing one.

### Perf harness (`scripts/perf/`)

Drives the real app over the Chrome DevTools Protocol — this project's
standing rule is **measure the real thing, never guess or extrapolate from
"observed" frame rate** (repeated identical runs vary 3-4x on this hardware).

```sh
npm run perf                    # steady-state scenario harness (dev build)
npm run perf:build-release       # build an instrumented release binary (own CARGO_TARGET_DIR, never bundled)
npm run perf -- --build release  # run the harness against it
npm run perf:startup             # from-launch startup-burst measurement
```

`launch.mjs` gives every perf run its own bundle identifier and WebView2
profile (`<identifier>.perf`) so it never touches the user's real install,
keys, or settings.

## Architecture

### Split: Rust owns everything except drawing

`src-tauri/` (Rust) owns the window, OS integration (SMTC, tray, wallpaper
mode, power-state watchers), all network/LLM calls, local-file decode, and
all cached state. `src/renderer/` (plain JS, no framework/bundler) is a
WebView2 page that **draws only** — it reacts to Tauri events
(`mood`, `genre`, `lyrics`, `attribution`, `beatmap`, `track`, `tick`, ...)
via `src/renderer/tauri-shim.js` and never originates a network call, cache
write, or CPU-heavy analysis pass itself, with one narrow exception: local
file playback has a synchronous JS DSP fallback in `analyze.js` for when
native analysis is unavailable (see the async-command note below — this
fallback path is also *slow*, so keeping native analysis correctly async is
what keeps it from ever being needed on the hot path).

### Cargo workspace: three crates, deliberately not one process

`src-tauri/Cargo.toml` is a workspace with `protocol` (shared wire-format
types) and `sidecar` (binary name `lyric-inference`) as members. The
inference sidecar is a **separate OS process**, spawned fresh **per job**
(not resident) — never linked into the main app binary. This is deliberate:
an ONNX Runtime segfault or OOM takes down only the sidecar, and the OS
reclaims every byte a loaded model held on exit, which a resident process
never gives back. It talks to the main app over framed stdio
(`[u32 len][u8 type][bincode payload]`, message shapes in the `protocol`
crate) with PCM audio passed via a memory-mapped temp file, not piped.

### The job engine is the one scheduler for all background work

`src-tauri/src/jobs/mod.rs` — every background task (lyrics/artwork/mood/
genre/attribution/AcoustID/Wikipedia lookups, waveform+beat+key+structure+
loudness+fingerprint analysis, sidecar transcription) runs as a `Job`
through this engine, never a bare `std::thread::spawn`. Three lanes with
incompatible shapes: **I/O** (`Semaphore(8)`, network/disk), **CPU** (rayon,
`N-1` threads, `analysis.rs`/beat tracking/etc.), **Inference** (`Semaphore(1)`,
the sidecar). Every job is deduplicated by `dedup_key`, cooperatively
cancellable via a `CancelToken` tree, and prioritized `Now` > `Next` > `Idle`
— decided when a lane actually frees up, not at submit time. A track change
cancels everything still queued for the previous track. Read the module doc
comment before adding new background work; don't reach for
`std::thread::spawn` directly.

### `async` on a `#[tauri::command]` is load-bearing, not decoration

**A command handler without the `async` keyword runs on Tauri's main
thread.** Any command doing blocking I/O or CPU work (network requests,
`std::fs` reads of non-trivial files, spawning a child process, audio
decode/DSP) must be `#[tauri::command(async)]`, or it freezes the entire
UI — every other command and all rendering — for its whole duration. This
has bitten this codebase for real: `analyze_local_file`/`read_local_file`
were missing it and froze the app for 40-85s during local playback before
being fixed. When adding a new command, check what it actually does before
assuming plain `fn` is fine.

### Two track sources, one funnel

SMTC (`smtc.rs`, native WinRT — replaced a PowerShell 5.1 poller that cost
~92MB resident) covers any external app; `LocalPlayer`
(`src/renderer/player.js`) owns its own queue when the app plays files
itself. Both paths converge on `resolve_lyrics` in
`src-tauri/src/commands/lyrics_cmds.rs` — the one place every track change
reaches, where the previous track's outstanding jobs get cancelled before
the new track's own lookups start. `commands/*.rs` are thin
`#[tauri::command]` wrappers; the actual logic lives in same-named modules
at `src-tauri/src/*.rs` (e.g. `commands/lyrics_cmds.rs` calls into
`lyrics.rs`, `genre.rs`, `mood.rs`, `wiki.rs`, `acoustid.rs`, `stats.rs`).

### Storage: no database server, three purpose-built stores

- **Per-track JSON cache** — one file per song under the app's config dir
  (`lyrics/<key>.json`), holding lyrics, mood, genre, attribution, and
  Wikipedia song-info together. `key` is a hand-rolled djb2 hash of
  `lower(artist)|lower(title)` (`track_key` in `lyrics_cmds.rs`) — no
  crate. Adding a new per-song cached field means adding a key to this same
  file, not a new store.
- **SQLite (WAL, via `rusqlite`)** — used *only* by `journal.rs` for the job
  engine's crash-survival journal. Note: `docs/JOB-ENGINE.md` §4 describes
  SQLite as also replacing the JSON cache as an index — that never actually
  happened; the JSON-file cache above is still current. Treat that doc's
  historical/aspirational sections with a grain of salt against the code.
- **`history.rs`** (bounded, 500 plays, no timestamp) drives next-track
  *prediction* for SMTC sources with no visible queue. **`stats.rs`**
  (`listening-log.jsonl`, unbounded, append-only) is a separate log for
  *recall* — Insights panel stats and the "Similar songs" feature. They are
  deliberately two different shapes for two different consumers; don't
  merge them.

### Visual presets are chosen, not random, and mood/genre bias them consistently

`src/renderer/presets.js`'s `forTrack(trackKey, moodKey, genreKey)` hashes
the track identity to pick a look deterministically (same song → same look,
across restarts, no stored state needed) and, when mood and/or genre are
known, biases toward a curated subset for each — intersecting both when both
are known, falling back to mood alone (not genre) when the intersection is
empty. Anything else in this codebase that needs a notion of "similar" to a
song (e.g. `stats.rs`'s `similar_songs`) mirrors this exact same
intersect-then-mood-fallback order rather than inventing a second definition
of similarity.

## Conventions specific to this codebase

- **Doc comments explain *why*, not what** — trade-offs considered, what was
  measured, what was rejected and why. This is load-bearing for
  understanding the code, not decoration; read them before changing
  behavior they justify.
- **"std first."** Small algorithmic needs (hashing a track key, epoch-day
  arithmetic for streaks) are hand-rolled rather than pulling in a crate —
  see `track_key` in `lyrics_cmds.rs`, the weekday math in `stats.rs`.
  Follow this instinct before adding a new dependency for something small.
- **Claims about behavior get measured, not assumed**, especially anything
  performance-related — the perf harness and the `#[ignore]`d live Rust
  tests exist specifically so a real number backs a real claim.
- Windows-specific code (SMTC, wallpaper mode, WASAPI capture) is gated with
  `#[cfg(windows)]`; the project builds and runs cross-platform minus those
  features (CI's Rust job runs on `ubuntu-latest`), but active feature
  development targets Windows only.
