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

---

### P3 — The startup burst

**Historically measured, never acted on.** Frame rate across the first 73
seconds of a real track ran 116 → 20 → 19 → 29 → 53 → 36 → 87 → 171 → 240 fps
and recovered completely, correlating with startup work (decode, offline
analysis, lyric and artwork fetch) rather than with the visual engine.
`NEXT_STEPS.md` closes that entry with *"Whether the startup burst can be
staggered has not been tried."* It still has not been.

**What changed since:** there is now a job engine with lanes, priorities and an
`Idle` lane — the exact machinery that staging requires and that did not exist
when the note was written.

**What fires at startup today** (`lib.rs` `setup()`, in order): panic hook,
tray, hotkeys, prefs load, stale-recording sweep, journal open + **resume any
stale transcription**, API keys, **update check**, display-mode/wallpaper
apply, SMTC watcher, pointer-forwarding loop, power watcher, library watcher.
Renderer-side: `getPrefs`, `getTranscribeConfig`, then a model-cache warm-up.

Several of those have no business competing with first paint — an update check
and a library rescan in particular.

**First move:** measure it (needs P1), then move the non-essential onto `Idle`
with a delay. Do not reorder anything before there is a number; the profile
that blamed MilkDrop for these dips was wrong.

**Risk:** low. **Impact:** the first impression, which is disproportionate.

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

**First move:** U6a and U6d are unambiguous and cheap — fix the fixed-start
bug and settle the vocabulary. U6b/U6c need the placement decision above
before any of it is worth building.

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
| 5 | **U3** One panel primitive | UX | High (+ correctness) | Medium | — |
| 6 | **P3** Stagger the startup burst | Perf | High (first impression) | Low–Medium | P1 |
| 7 | **U4** Keymap + `?` cheat sheet | UX | Medium | Low–Medium | U3 |
| 8 | **P4** Memory baseline → decide | Perf | Unknown — that's the point | Low | P1 |
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
