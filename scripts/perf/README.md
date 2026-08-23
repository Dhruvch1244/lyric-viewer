# Perf harness

Drives the real app over the DevTools protocol and records what drawing costs.

```bash
npm run perf                  # dev build, 7 scenarios, compare against baseline.json
npm run perf:baseline         # same, but overwrite baseline.json with the result
npm run perf:build-release    # compile the instrumented release binary (needed once)
node scripts/perf/harness.mjs --build release
node scripts/perf/harness.mjs --include-wallpaper
```

Exit code is non-zero when a scenario regresses or blows a budget, so it works
as a pre-release gate.

## What it asserts, and what it refuses to

| Signal | Treatment | Why |
|---|---|---|
| `drawCostMs` p50 | **Asserted** against `baseline.json` | Repeats. Measured spread across three back-to-back runs: 0–15%. |
| Per-section `perfCost` p90 | **Asserted** against `PERF_BUDGET_MS` | Catches a layer that was always too expensive — a baseline would simply enshrine it. |
| Backdrop parked or drawing | **Asserted** against `expectBackdrop` | A parked loop reports a stale cost that looks like a cheap one. |
| Active engine | **Asserted** against `expectEngine` | A scenario that fails to switch engine measures the wrong thing while looking healthy. |
| `frameIntervalMs` | **Recorded, never asserted** | Varied 37–57ms across those same three identical runs. An fps-based A/B here produces a confident wrong answer, and twice nearly did. |
| Process memory | Recorded | Only meaningful from a release build. |

`PERF_BUDGET_MS` is parsed out of `src/renderer/renderer.js` rather than copied
here. A second copy would drift the first time a budget changed, and then the
gate would be enforcing a number nobody believes.

## How it works

- **No production code is instrumented.** `renderer.js` is a classic script, so
  its top-level `let` bindings — `drawCostMs`, `frameIntervalMs`, `perfCost`,
  `presetId`, `liteMode`, `cues`, `lastDrawnAt` — are global lexical bindings
  that `Runtime.evaluate` can read *and assign to*. The harness needs no hooks.
- **Determinism comes from one seam.** `renderer.js`'s
  `window.AudioReactive.sample(now)` is the only way audio reaches the
  backdrop, so the driver replaces `window.AudioReactive` with a scripted
  envelope: a seeded PRNG over a fixed timeline with kicks, a build-up and a
  drop. No audio file is involved, which matters because `songs/` is gitignored
  (commercial music, public remote).
- **The timeline advances per frame, not per millisecond.** A slow frame sees
  the same input as a fast one. Driving it from `performance.now()` would make
  the input depend on the thing being measured.
- **A perf run cannot touch your real install.** The build gets its own bundle
  identifier (its own app-data directory) and its own
  `WEBVIEW2_USER_DATA_FOLDER`, so the display mode, Lite flag and `perfDebug`
  it sets are written somewhere else.

## Traps, all of them paid for once already

- **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` does not work.** wry 0.55.1
  (`src/webview2/mod.rs:294`) calls `set_additional_browser_arguments`
  unconditionally, defaulting to
  `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`, and that
  API overrides the environment variable. The port has to come from the Tauri
  config, which is read at compile time. `launch.mjs` generates the override
  from `tauri.conf.json` and passes it to `--config` as inline JSON — a
  checked-in `tauri.perf.conf.json` would have to restate the whole
  `app.windows` array, because Tauri merges configs as an RFC 7386 merge-patch
  and arrays are replaced rather than merged.
- **Do not match the page target by URL.** `tauri dev` serves from
  `http://127.0.0.1:1430/`, a bundled build loads `http://tauri.localhost/…`,
  and MilkDrop's CSP-isolated iframe can appear as its own target. The harness
  identifies the page by asking whether `canRender` and `drawCostMs` exist.
- **`perfCost` freezes rather than decaying.** It is an EMA advanced only when
  a layer actually draws, so a layer that stops drawing keeps its last value
  forever. The first run of this harness had `ghost` — a look with almost no
  layers — confidently reporting `concert`'s `mathCurves` cost. The driver
  zeroes `perfCost` and `drawCostMs` on install for exactly this reason.
- **A parked backdrop reports a plausible number.** Compact modes return early
  in `drawBackdrop` before the cost timer starts, so `drawCostMs` keeps its
  last value. `lastDrawnAt` is the discriminator: it advances only past that
  early return.
- **`PERF_DEBUG` is read once at load.** Without
  `localStorage.perfDebug = '1'` *and a reload*, every per-section cost reads
  zero and the run looks clean because nothing was measured. The harness sets
  it and reloads before the first scenario.
- **Spawn the Tauri CLI's `.js`, not `npx`.** Node 20+ refuses to spawn a
  `.cmd` shim without `shell: true` (EINVAL, the CVE-2024-27980 fix), and a
  shell would then strip the quotes from the inline JSON config.
- **`tauri dev` is a supervisor.** Killing it does not kill the app it spawned;
  `stop()` uses `taskkill /T` so a run cannot leave an orphaned always-on-top
  overlay on someone's screen.

## Measuring the startup burst (P3)

```bash
npm run perf:startup                  # 120s from process launch, sampled every 200ms
npm run perf:startup -- --duration 60
```

Separate from the harness above, and observational rather than a gate — no
baseline, no pass/fail. It records `frameIntervalMs`/`drawCostMs` from the
moment the process launches, prints a bucketed fps-equivalent series so a dip
is visible without opening the output JSON (`scripts/perf/runs/startup-*.json`),
and stops on its own after `--duration` or on Ctrl-C (still saving what it
has).

Two things it deliberately does *not* do, both load-bearing:

- **No `PERF_DEBUG` reload.** The steady-state harness reloads the page once
  to turn on per-section `perfCost`. `frameIntervalMs`/`drawCostMs` update
  unconditionally regardless of that flag, and a reload here would destroy
  the exact from-launch window being measured.
- **No synthetic audio driver.** `scenarios.mjs`'s driver replaces
  `window.AudioReactive` specifically so the harness never needs a real,
  gitignored track — but the startup burst is caused by the subsystem that
  bypasses (decode, offline beatmap/heatmap analysis, lyric/artwork fetch).
  This app only observes SMTC; it doesn't play anything itself. **A
  cold-launch-only run with nothing playing will show a flat, uninteresting
  series** — that's expected, and is itself evidence `setup()` isn't the
  culprit (see PERF-UX.md P3). To capture the actual burst, start a real
  track in whatever media app you normally use after the "Recording for…"
  line prints; the timestamps in the output are what let you line the dip up
  with when playback actually started.

## Reading the baseline

`baseline.json` is committed; `runs/` is not. The baseline records the machine
that produced it, and `compare.mjs` warns rather than fails when the CPU
differs — draw cost is hardware-bound, so a delta measured on another computer
is unproven, not a regression.

Re-baseline deliberately (`npm run perf:baseline`), never to make a red run go
green.
