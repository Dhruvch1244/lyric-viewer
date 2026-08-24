# Performance & UX Roadmap

Written 2026-08-22, at the point `ROADMAP.md`'s feature sequencing table went
all-✅/❌-decided. The features are essentially in. This is the next axis: make
what exists **cost less** and **read better**.

Same house rules as every other doc here — each item says what the evidence
is, what is measured versus assumed, and what the first move is. Items with no
number behind them say so out loud rather than borrowing confidence from the
ones that do.

---

## 0. The standing doctrine, restated

Carried forward because it has been re-learned the expensive way more than
once:

- **CPU cost repeats; frame rate does not.** Repeated identical runs vary 3–4×
  in fps on this hardware. Optimise against `drawCostMs` (smoothed, repeatable
  to ~0.1ms), never against observed fps.
- **Profile before optimising.** 0.16.0's draw-call audit blamed 300 arcs; the
  real cost was `shiftHex` per particle per frame, no canvas call at all, 5×
  the expense.
- **Native code is the wrong lever for drawing.** Measured twice. Total CPU
  render cost is a few ms of a 16.7ms budget; `(program)` — native compositing
  — dominates every profile. Rust earned its place in the *shell* and in *ML
  inference*, not the draw loop.
- **A governor must not measure its own throttling.** The swirl's resolution
  governor fed itself once and each rung change caused the next.

---

## 1. What is already done — do not re-litigate

Listed so this roadmap does not accidentally propose work that shipped:

| Already in | Evidence |
|---|---|
| Adaptive quality governor on `drawCostMs`, resolution ladder for **both** GPU and 2D layers, DPR capped at 1.0, adaptive frame-skip (`throttleMs`) | `renderer.js` §"adaptive quality governor" |
| Per-section frame budgets (`PERF_BUDGET_MS`: galaxy, bokeh, glows, sprites, confetti, mathCurves, constellation) | `renderer.js:1332` |
| Compact modes **genuinely** shed cost — `MilkDrop.destroy()`, both GPU surfaces and the 2D canvas removed from the page, not merely hidden | `renderer.js:5777` |
| Parked/hidden frames draw nothing (`canRender()` short-circuits the whole backdrop) | `renderer.js:3255` |
| Audio IPC profiled and **cleared** — 0.038% of a core, not the estimated 1.5–5%; waveform demand gate 2179 → 804 B/frame | JOB-ENGINE §6, §7.9 |
| Job engine: 3 lanes, keyed dedup, cancellation tree, below-normal priority | JOB-ENGINE §7.1 |
| Inference out-of-process, per-job, `BELOW_NORMAL_PRIORITY_CLASS`, memory reclaimed by the OS on exit | `inference.rs` module doc |
| `prefers-reduced-motion` honoured in CSS (4 blocks) **and** JS | `styles.css`, `renderer.js:385` |
| 32 buttons document-wide carry `title` tooltips; 69 aria/role/tabindex attributes present | `index.html` |

The render loop is not low-hanging fruit. **Everything below is deliberately
somewhere else.**

---

## 2. Performance track

### P1 — Make performance measurable in-repo *(prerequisite)*

**The gap is tooling, not doctrine.** §0 says "profile before optimising" and
"optimise against `drawCostMs`" — but there is no checked-in way to do either:

- `scripts/` holds seven vendor/build scripts and **no perf harness**.
- `NEXT_STEPS.md` cites `scratchpad/profile.js` as *the* tool that found the
  0.16.0 regression. **`scratchpad/` does not exist in the repo** — that tool
  was never committed.
- `PERF_BUDGET_MS` warns to the **dev console only**, after 30 over-budget
  frames. Nothing fails, nothing records, nobody sees it in CI.
- CI runs `npm test` + `cargo test` + clippy. **No perf job.**

So every performance claim in this document — and every one in the next
release's notes — currently costs a from-scratch measurement rig. That is the
actual reason perf work here has been episodic.

**First move:** commit a harness that drives the *real* app (the standing rule:
one window per process, `show: true`, real IPC channel names — hidden windows
throttle rAF and fabricate timing bugs) and dumps a JSON baseline of
`drawCostMs`, per-section `perfCost`, `frameIntervalMs`, and process memory.
Then make `PERF_BUDGET_MS` assertable against it.

**Unknown worth checking first:** whether WebView2's DevTools protocol is
reachable from a harness the way Electron's CDP was. The whole phase depends
on it. If it is not, the fallback is an in-page instrumentation build that
posts its own numbers out — worse, but sufficient.

**Risk:** low. **Impact:** unlocks everything below.

---

### P2 — Stop rendering when nobody is looking *(the biggest real-world win)*

**Verified in the code this session, not inferred:**

```rust
// watchers.rs — start_power_watcher
if !WALLPAPER_ATTACHED.load(Ordering::Relaxed) { continue; }
```

```js
// renderer.js:417
function canRender() { return overlayVisible && !wallpaperSuspended; }
```

`overlay-visibility` is emitted from exactly one place: the **tray's manual
hide toggle** (`tray.rs:40`). The battery/lock/exclusive-fullscreen suspend
that `wallpaperSuspended` carries is gated behind `WALLPAPER_ATTACHED`, so it
**only ever fires in wallpaper mode**.

Therefore, in the **default fullscreen overlay mode**, the app runs a WebGL2
shader plus a full-screen 2D canvas at up to 60fps:

- on battery, with no policy at all;
- behind a locked screen;
- behind another app's exclusive fullscreen;
- while fully occluded — **there is no occlusion detection anywhere** in the
  codebase outside `wallpaper.rs`'s own `GetForegroundWindow`/`IsIconic` use.

And `liteMode` is **manual only** (`renderer.js:6108`, restored from
localStorage) — nothing engages it automatically, ever.

For a product whose thesis is *"something that is simply on"*, this is the
largest genuine cost left, and it is a **battery and thermal** cost rather
than a frame-rate one — which is exactly why every previous fps-shaped
investigation walked straight past it.

**The design nuance that matters:** the right policy is **per mode**, and
"pause" is wrong for the overlay.

| State | Wallpaper mode | Overlay mode (full/bar/strip) |
|---|---|---|
| Screen locked | pause (already does) | **pause** — nobody can see it |
| Exclusive-fullscreen game | pause (already does) | **pause** — it is not composited anyway |
| Occluded / minimised | — | **pause** |
| On battery | pause (already does — it is decoration) | **throttle, never blank** — the user deliberately opened a visualiser; blanking it is a bug. Drop to the Lite rung, say so once, let them override. |

**First move:** lift the `WALLPAPER_ATTACHED` early-return into a per-mode
policy, and add real occlusion detection. Verify with P1's harness that a
locked screen actually drops `drawCostMs` to zero rather than merely looking
paused.

**Risk:** medium — a wrong "not visible" verdict blanks the app the user is
looking at. This needs the state-coverage lesson applied deliberately: test
*with a song playing*, *mid-panel*, *across a mode switch*.

**Verified against real OS state (2026-08-24), and the "occluded" reason is
mostly dead code — by design, not by bug.** `scripts/perf/verify-p2.mjs`
drives the app through minimize, virtual-desktop switch, and an exclusive
fullscreen cover, across all three overlay modes. Minimize and
virtual-desktop both failed uniformly (9/9, clean, no exceptions). Digging
into why, rather than assuming a detection bug:

- **Minimize can never happen to this window, through any mechanism.**
  `window.minimize()`, Win+D ("show desktop"), and Win+M ("minimize all
  windows") were all tried directly — none of them so much as flips
  `isMinimized()`. The window's own config (`skipTaskbar: true`,
  `decorations: false`) puts it in Windows' `WS_EX_TOOLWINDOW`-adjacent
  category, which every one of those subsystems explicitly excludes. There
  is no user action that reaches this code path. `is_main_window_occluded`'s
  `IsIconic` check is correct code guarding a state that cannot occur.
- **Virtual-desktop switching does not cloak this window — confirmed by
  screenshot, not inferred.** Switched to a freshly created, empty virtual
  desktop and captured it: the swirl backdrop and welcome card were still
  rendering there, full opacity. The window is not tracked by Explorer's
  virtual-desktop manager (same untracked-tool-window category as above), so
  DWM never applies `DWMWA_CLOAKED` when the user switches away. **This is
  intentional, not a bug — confirmed with the product owner.** This app is
  an OSD-style overlay (RTSS, Rainmeter, and Discord's overlay all use the
  same exemption on purpose): the entire pitch is lyrics that follow you
  regardless of which desktop or app has focus. Pinning the window to one
  desktop (`IVirtualDesktopManager::MoveWindowToDesktop`) would "fix" the
  cloak check at the cost of breaking that. **Decision: leave the window
  and the detection code exactly as they are.** `is_main_window_occluded`'s
  cloak check stays in place — harmless, and would engage correctly if the
  window's styling ever changes — but budget nothing on it working today.
- **Exclusive-fullscreen genuinely works — confirmed on a clean rerun.** It
  also failed in that first run, but a follow-up diagnostic showed the
  spawned cover window really did win `GetForegroundWindow`, and
  `overlayPaused` correctly flipped `true`. The first run's failure traced
  to whatever window happened to hold real OS focus at that exact moment
  (Windows' focus-steal prevention is sensitive to it) — an environmental
  fluke in that one run, not a harness or app bug. A clean rerun of
  `verify-p2.mjs` (fullscreen only, its default now — see below) passed
  3/3 across `full`/`bar`/`strip`.

Net effect on this item's real-world value for the default **overlay**
modes: exclusive-fullscreen pause is confirmed working. Lock-screen remains
unautomatable (needs a human). Occlusion via minimize or desktop-switch will
never contribute, by design — accept that rather than chase it further.

---

### P3 — The startup burst

**Historically measured, never acted on.** Frame rate across the first 73
seconds of a real track ran 116 → 20 → 19 → 29 → 53 → 36 → 87 → 171 → 240 fps
and recovered completely, correlating with startup work (decode, offline
analysis, lyric and artwork fetch) rather than with the visual engine.
`NEXT_STEPS.md` closes that entry with *"Whether the startup burst can be
staggered has not been tried."* It still has not been.

**What changed since:** there is now a job engine with lanes and priorities
(`Lane::{Io,Cpu,Inference}`, `Priority::{Now,Next,Idle}`, `jobs/mod.rs`) —
but no delay/defer primitive. `Idle` means backfill-with-no-deadline, not
backfill-after-N-ms; grepping `jobs/` for `sleep`/`delay` turns up test code
only. Staggering onto `Idle` is available; staggering onto a *timer* is not
built.

**What fires at startup today** (`lib.rs` `setup()`, in order): panic hook,
tray, hotkeys, prefs load, stale-recording sweep, journal open + **resume any
stale transcription**, API keys, **update check**, display-mode/wallpaper
apply, SMTC watcher, pointer-forwarding loop, power watcher, library watcher.
Renderer-side: `getPrefs`, `getTranscribeConfig`, then a model-cache warm-up.

**Corrected, verified against current source (P1's harness in hand) rather
than assumed:** the previous version of this section named "an update check
and a library rescan in particular" as competing with first paint. Neither
does, and nothing else on the list does either:

| Step | What actually happens |
|---|---|
| Update check (`commands/updater.rs:16-28`) | `tauri::async_runtime::spawn`s and returns immediately — the `setup()` call is non-blocking today. |
| Library watcher (`library.rs:443-453`) | Sleeps 60s **before** its first scan. Costs nothing at first paint — the opposite of the old framing. |
| Resume stale transcription (`lib.rs:136-143`) | Only loops and calls `jobs::submit(_, Priority::Idle)` per job — a HashMap lookup and a channel send. The real work runs later, already on the `Inference` lane. |
| `start_smtc` / `start_pointer_forwarding` / `start_power_watcher` (`watchers.rs`) | Each spawns and returns immediately; the thread's first real action waits for its own initial sleep (250ms / 33ms / 2s). |
| Renderer bootstrap (`renderer.js:7288-7301`) | `requestAnimationFrame(drawBackdrop)`/`requestAnimationFrame(frame)` are scheduled **before** `getPrefs()`/`getOffset()`/`resyncSmtc()` are even called — first frame isn't gated on any of them. |
| Model-cache warm-up (`schedulePreload`, `renderer.js:5154-5166`) | Already `requestIdleCallback`, already an 8s timeout. Already correctly deferred. |

So there is nothing here that both (a) blocks first paint and (b) has a
"move it later" fix available. The likely real cause of the historical
116→...→240 fps sequence is work triggered by **a track actually starting**
— decode, beatmap/heatmap offline analysis, lyric/artwork fetch — which runs
on the job engine's `Cpu`/`Io` lanes and competes with the render thread for
real CPU cores. That is a different phenomenon from app cold-launch, and
P1's harness structurally cannot reproduce it: `scenarios.mjs`'s driver
replaces `window.AudioReactive` with a synthetic envelope specifically to
avoid needing a real, gitignored track — which also skips the exact
subsystem that would cause this burst.

**First move:** `npm run perf:startup` (`scripts/perf/startup.mjs`) records
`frameIntervalMs`/`drawCostMs` from process launch through a real track
actually playing, and prints a bucketed fps-equivalent series so a dip is
visible without opening the JSON. It is observational, not a gate — no
baseline, no pass/fail. **Do not reorder anything in `setup()` or the
renderer bootstrap before this produces a number**; every specific target
the old version of this section named turned out to be already fine, and
guessing at a different one would repeat the exact mistake this doc's own
§0 warns about. If a real run shows the dip correlating with `Cpu`/`Io` lane
activity, the next move is tuning that lane's concurrency/priority — not
`setup()` — and is its own follow-up.

**Measured (2026-08-23, `--build dev`, real track).** The script now takes
`--track <path>`, calling `window.LocalPlayer.enqueue()` right after CDP
attach instead of waiting for a human to start playback externally — the
same entry point `libraryCard`'s click handler uses. Driven against a real
5-track set, the dip is real and worse than the historical fps series
above: **for ~30s starting immediately after enqueue, the renderer stopped
answering `Runtime.evaluate` at all** (two back-to-back 15s CDP timeouts),
and by the time it answered again `LocalPlayer.isActive()` had gone
`false` — the track had aborted, not merely stalled. Reproduced twice: a
plain 100s `--track` run collected zero samples across the entire window,
and a step-by-step diagnostic (300ms polling) caught the same ~30s dead
zone landing right after the enqueue call, immediately followed by
`isActive()` flipping false.

**Isolated (2026-08-23, `--build release`): debug-build artifact, not a real
bug.** `npm run perf:build-release` was built and the same `--track` run
repeated against it on two different tracks (a 100s EDM run, a 90s hip-hop
run). Neither showed anything resembling the dead zone — largest gap between
samples was 309ms and 367ms respectively (against ~30,000ms on the dev
build), 467 and 425 samples collected with none dropped, and both runs
recovered into the ordinary noisy-but-alive fps series matching the original
116→...→240 historical pattern, not a stall. `analyzeLocalFile`'s unoptimized
symphonia decode+DSP pass on a debug binary fully explains the dev-build dead
zone; there is no evidence of job-engine lane contention or an actual
freeze/abort in what ships. **Do not re-run this on a debug build expecting a
different answer** — the dev-build "hang" was real but is a measurement
artifact of `--build dev`, not a user-facing bug.

Still worth doing regardless of this result: `player.js`'s `playAt()` has a
silent `if (!raw) { next(); return; }` fallback on a slow/failed read, with
no visible failure state — low priority now that there's nothing here to
actually trigger it, but still a gap if some other future codepath does.

**Risk:** none remaining — measured, not guessed. **Impact:** the first
impression, still disproportionate to fix given P1's harness now exists, but
no longer urgent: the dip recovers on its own within the same window the
original 0.21.0 measurement showed, on a real release build, on two
different tracks.

---

### P4 — Memory and process footprint

**Not measured post-Tauri in a release build.** The only figures on record are
debug-build (~40MB main + ~113MB webview) from migration week, which are not
meaningful.

Known structural costs: WebView2's own processes, the Butterchurn iframe's
separate WebGL2 context and render targets (compact-mode teardown proves this
was already understood as non-trivial), and the sidecar — which is already
per-job and returns everything to the OS on exit, so it is likely *not* the
problem.

**First move:** baseline it with P1's harness across the three modes and both
engines. **Then** decide whether there is anything here at all. There may not
be — Tauri took the installer from 116MB to ~6MB, and the runtime story may
already be fine.

**Risk:** low. Explicitly a *measure-then-decide*, not a *fix*.

**Measured (release build, 2026-08-23).** The harness's `sampleProcessTree`
already recorded memory; it was extended (`scripts/perf/harness.mjs`,
`classifyProcess`) to break the tree down by *what* each process is, not just
sum it, since `--type=` on WebView2's own command line is exactly what
Chromium itself uses to tell a browser process from a renderer from a GPU
process. Full run: `scripts/perf/runs/run-2026-08-23T19-04-24-143Z.json`.

Total working set across scenarios ran **625–824MB** — the old debug-build
figure (~153MB combined) undercounted by an order of magnitude because it only
ever looked at one or two processes, not the real eight-process tree. Per
role, `full/liquid`:

| role | processes | private | working set |
|---|---|---|---|
| app (main, the Rust/wry host) | 1 | 20.6MB | 49.9MB |
| webview2 (browser) | 1 | 45.7MB | 136.3MB |
| webview2 (utility ×3) | 3 | 30.9MB | 81.9MB |
| webview2 (renderer — the page) | 1 | 170.1MB | 227.2MB |
| webview2 (gpu-process) | 1 | 170.7MB | 118.5MB |
| webview2 (crashpad-handler) | 1 | 3.0MB | 13.3MB |

**The app's own process is not the story — it never exceeded ~21MB private
across any scenario.** The cost is structural WebView2 overhead: browser +
utility + GPU + crashpad alone run **250–370MB** before the page's own
renderer is counted at all, in every scenario including `bar`/`strip` where
the backdrop is deliberately parked and drawing nothing. `full/milkdrop` was
the heaviest overall (823.6MB working set) — Butterchurn's own WebGL2 surface
adds real weight on top of the swirl engine's baseline, as the compact-mode
teardown already implied.

**Decision: no code fix.** This is Chromium's own multi-process model, owned
by WebView2 and the OS, not an app-side leak — there is no lever here the app
controls the way it controls its own draw cost. One real methodology caveat
for any future re-run: all eight scenarios shared a single app launch (as the
harness always does), and the `gpu-process` number did not track scene
complexity monotonically — `bar`/`strip`, drawing nothing, still carried
250–288MB, higher than several drawing `full` scenarios earlier in the same
run. That reads as GPU-process allocations from an earlier scenario not being
released on teardown, which means per-mode comparisons from this run are not
independent; a mode-by-mode memory *comparison* (not just a total baseline)
would need one fresh launch per scenario to be trustworthy.

---

## 3. UX track

### U1 — The control surface is nineteen unlabeled icons

Counted: `btn-` audio, backdrop, import-lyrics, key, library, lyrics,
lyrics-search, milkdrop, mode, perf, poster, preset, presync, script, sprites,
sync-earlier, sync-later, translate, wallpaper.

Every one is icon-only — `अ`, `EN`, `◈`, `◐`, `☻`, `♫`, `▣`, `✳`. Tooltips
exist and are well written, but **a tooltip requires already hovering the
thing you have not yet identified**. The first-run card names them once, then
never again. There is no grouping, no overflow, no way to hide the ones a
given user never touches.

This is the single biggest thing standing between "impressive demo" and
"software people keep open."

**First move:** group before decorating — the nineteen fall naturally into
*sync* (offset ±, source), *look* (preset, backdrop, sprites, lite, milkdrop,
mode, wallpaper), *words* (lyrics, script, translate, import, search), and
*system* (key/settings, library, presync, poster). Then decide what is
always-visible versus behind an overflow. A labelled-on-hover expansion is
cheaper than an icon language nobody learns.

---

### U2 — Settings exists, dressed as a key

`keybox` currently holds: LLM API key, AcoustID key, **launch on startup**,
**vocal isolation**, **Whisper language**, **crash reporting (local)**,
**crash reporting (remote, opt-in)**, **open crash log**, and the local-CLI
option.

That is a Settings panel. Its button is `🔑` and its tooltip still reads
**"Set HuggingFace API key"** — stale on two counts: it is not
HuggingFace-specific (Gemini → Groq → HF → Claude, plus AcoustID now), and it
is not only keys.

Nobody looks for "launch on startup" under a key icon.

**First move:** rename to Settings, section it (Keys / Transcription /
Startup / Diagnostics), fix the stale tooltip. Cheapest real UX win on this
page.

---

### U3 — Twelve overlays, one dialog

Across `keybox`, `library`, `lyrics-search`, `milkdrop-panel`,
`model-consent`, `poster`, `presync`, `welcome`, `whatsnew`, `update-card`,
`localcli-card`, `mode-menu` and `capture-nudge`, the document contains
exactly **one** `role="dialog"`, **one** `aria-modal`, and **one**
`tabindex="-1"`.

Consequences that are correctness bugs, not just a11y gaps:
- No focus trap — Tab walks out of an open panel into the page behind it.
- No focus restore — dismissing a panel drops focus to `<body>`.
- Keyboard users can Tab **into `hidden` panels** unless every one of them is
  `display:none` (worth verifying panel by panel).
- Escape is handled ad hoc: present on mode-menu, keybox, lyric-search,
  presync; not uniformly.

The `model-consent` modal (0.39.0) is the one that got this right — it is the
template.

**First move:** one panel primitive — open/close, Escape, focus trap, focus
restore, `role`/`aria-modal`/labelling — and retrofit all thirteen onto it.
This also shrinks `renderer.js` (see U5), since each panel currently
re-implements its own open/close.

---

### U4 — Keyboard support is thin

Global hotkeys are good: `Ctrl+Alt+←/→/0` offset, `Ctrl+Alt+H` hide,
`Ctrl+Alt+M` wallpaper, `Ctrl+Alt+D` cycle mode.

In-app is almost nothing: Enter/Escape inside text inputs, Escape for the mode
menu, and a single `(L)` for Library mentioned in a tooltip. The nineteen
chips are not keyboard-reachable in any designed order, and **there is no
surface anywhere that lists the shortcuts that do exist** — they are
discoverable only by reading tooltips one at a time.

**First move:** a real keymap plus a `?` cheat-sheet overlay. The cheat sheet
is worth more than the keymap on its own: it also fixes discovery for the four
global hotkeys that already work and that nobody knows about.

**Shipped.** Six new in-app single-key bindings — `L` Library, `/` Search,
`K` Settings, `P` Scene, `V` MilkDrop presets (only while MilkDrop is the live
engine), `B` Backdrop — plus `?` for a cheat-sheet overlay listing both these
and all five global Ctrl+Alt hotkeys, so the ones nobody knew about are now
spelled out in one place. The keydown listener is guarded against firing while
a text input has focus or a blocking modal (welcome/whatsnew/model-consent/the
cheat sheet itself) is open. `?` also got a chip inside More
(`btn-shortcuts`), since a keyboard-only affordance is invisible to a
first-time mouse user. Deliberately not all nineteen chips — the doc's own
framing above holds: the cheat sheet is what makes discovery work, exhaustive
per-chip binding was not the point.

---

### U6 — The visual-preset system is two systems wearing the same clothes

Raised from real use: *"MilkDrop UX is bad."* Four separate complaints, all of
which check out against the code.

**U6a — MilkDrop always opens on the same preset.** Not a perception problem, a
one-line bug: `milkdropDefault()` (milkdrop-panel.js) returns `pool[0]`, the
first entry of the favourites-or-curated pool, every time. Every session that
does not have a pin or a session choice starts on the identical look. The
request — *"start MilkDrop with a random preset"* — is simply the intended
behaviour, and `milkdropCyclePool()` already builds exactly the right pool to
pick from.

**U6b — There is no shuffle, and two things that look like one.** Today:

- `mdp-random` ("Surprise me") — one-shot, and only inside the browser panel.
- An automatic switch on a drop, at most every `MILKDROP_SWITCH_MS` (42s) —
  but **only while nothing is pinned or chosen**, and with nothing on screen
  saying it is happening.

So presets do change by themselves, silently, until the moment you pick one —
at which point they stop, silently. That is almost certainly what reads as
broken. What is wanted is an explicit **Shuffle** toggle with visible state, so
"it changes on drops" is a mode you turn on rather than a behaviour you infer.
The 42s floor and the drop trigger should stay — they are what makes it feel
designed rather than timed — but they belong *under* the toggle.

**U6c — Hearting is real but unreachable from the thing you are looking at.**
`mdpFavourites` already exists, already has a per-card heart, already has a
"favourites" filter, and — importantly — **already drives the shuffle pool**
(`milkdropCyclePool` prefers liked presets when there is more than one). So
hearting is the mechanism that makes shuffle personal. But the only way to
heart the preset currently on screen is to open the browser, find its card and
click it there. The ask — *"heart the drop"* — is to make that one keystroke
away from the visuals.

**U6d — "Preset" means two unrelated things, and neither chip says which.**

| chip | what it actually controls |
|---|---|
| `◈ Liquid` | this app's **own** look — swirl field + 2D layers |
| `✳` | a **MilkDrop/Butterchurn** preset |
| `◐ vivid` | backdrop opacity |

Two different preset systems, two similar-looking chips, one of them
unlabelled, and the word "preset" used for both. "MilkDrop 2" is internal
vocabulary (Butterchurn is a MilkDrop 2 reimplementation) and should never
reach the UI at all. Needs one vocabulary, applied everywhere:

- **Scene** — this app's signature looks (today's `◈`). The thing that times
  itself to lyric density and is the product's identity.
- **MilkDrop preset** — the imported community catalogue (today's `✳`).
- Say which engine is live on the chip, so switching between them is a visible
  act rather than a guess.

**The open design question, and it is a real one:** U1 just cut the bar from
nineteen chips to five. Shuffle and heart are exactly the kind of controls
that want to be one click away — and putting them on the bar walks that back.
Three candidates, in preference order:

1. **A preset cluster that only exists while MilkDrop is the live engine.**
   Shuffle + heart + next appear beside the preset chip, and vanish entirely
   on the swirl engine. Contextual, so it costs nothing the rest of the time.
2. **Inside More**, next to the browser. Cheapest, and consistent with U1 —
   but a heart you have to open a menu for is not "at hand", which was the
   whole point.
3. **On the preset chip itself** — click cycles, a small heart sits on its
   corner. Densest, and the least discoverable.

**All four are now done.** U6a (random start) and U6d (Scene vs MilkDrop
preset) shipped first as they needed no decision. U6b/U6c then shipped as
option 1, the contextual cluster: `⇄ Shuffle`, a heart and `▸` next appear
beside the scene chip only while MilkDrop is the live engine and disappear on
the swirl one, so the bar stays at U1's five chips the rest of the time.

The behavioural fix inside U6b is the part that mattered: shuffle was
previously implied by `!milkdropChosen`, so picking a preset silently turned
cycling off forever. It is now a real mode with a visible chip — picking a
preset sets what plays now and shuffle carries on from it; turning shuffle off
is how you keep one. A per-track pin still outranks the mode, and the chip
says so rather than sitting there looking enabled while doing nothing.

### U5 — `renderer.js` is 7,055 lines *(sustaining)*

Half of all renderer JavaScript (14,135 lines total) in one file. Not
user-facing, and not urgent on its own — but it is the tax on every item in
this document, U1–U4 especially.

The precedent is already set and worked: `milkdrop-panel.js` and
`onboarding-cards.js` were split out of it.

**First move:** continue along the existing seams rather than a big-bang
reorganisation — `hud/`, `panels/` (natural once U3's primitive exists),
`backdrop/`. Split *when touching an area for another reason*, not as its own
project.

---

## 4. Sequencing

| # | Item | Track | Impact | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | **P1** Perf harness in-repo | Perf | Unlocks the rest | Medium | — |
| 2 | **U2** Settings stops being a key | UX | Medium | **Low** | — |
| 3 | **P2** Stop rendering when unseen | Perf | **Very high** (battery/thermal) | Medium | P1 to verify |
| 4 | **U1** Group the nineteen chips | UX | **Very high** (adoption) | Medium | — |
| 5 | **U3** One panel primitive — ✅ shipped (0.45.0) | UX | High (+ correctness) | Medium | — |
| 6 | **P3** Stagger the startup burst — ✅ measured, no fix needed (0.45.0) | Perf | High (first impression) | Low–Medium | P1 |
| 7 | **U4** Keymap + `?` cheat sheet — ✅ shipped | UX | Medium | Low–Medium | U3 |
| 8 | **P4** Memory baseline → decide — ✅ measured, no fix needed | Perf | Unknown — that's the point | Low | P1 |
| 9 | **U5** Keep splitting renderer.js | UX/sustaining | Indirect | Ongoing | opportunistic |

**Two things can start today with no dependency:** U2 (an hour, mostly copy)
and U1 (the grouping decision costs thinking, not code).

**P1 gates the honest version of P2/P3/P4.** P2's fix could be written without
it — but then it would ship on reasoning, which is precisely the pattern §0
exists to prevent.

---

## 5. Corrections to existing docs

- **`ROADMAP.md` item 3 — "Compact display modes 🔁 Reversed (0.28.0,
  fullscreen-only)" — is STALE.** All four modes are real and reachable in the
  Tauri build: `full`, `bar` (140px floating), `strip` (96px, click-through
  via `set_ignore_cursor_events`), `wallpaper` — with a proper `role="menu"`
  picker, `Ctrl+Alt+D` cycling, persisted prefs, and a real teardown path.
  That gap closed itself during the rewrite and the roadmap never noticed.
  Worth correcting there, because it was listed as *"the single biggest reason
  someone tries it once and stops."*

---

## 6. Explicitly not doing

- **Re-optimising the render loop without a number.** It has been profiled
  repeatedly and is not where the cost is.
- **Rewriting drawing in a native language.** Measured, twice, as the wrong
  lever. `(program)` compositing dominates; app JavaScript is a rounding
  error beside it.
- **Uncapping the frame rate.** The cap is vsync.
- **A settings *window*.** The in-overlay panel is right for this app; U2 is a
  rename and a re-section, not a new surface.
- **A full a11y certification pass.** U3/U4 fix the parts that are also
  correctness bugs. Screen-reader support for a music visualiser is not the
  next best use of a day.
