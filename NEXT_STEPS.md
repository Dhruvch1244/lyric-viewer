# Next steps

Current as of **v0.18.0**. Written to be picked up cold — each item says what
is missing, why it was left, and what the first move is.

> **Profile before optimising anything in the render loop.** 0.16.0's draw-call
> audit ranked Concert by canvas calls and concluded the galaxy was 300 arcs.
> The actual cost was `shiftHex` running once per particle per frame — no canvas
> call at all, and 5× the expense. `scratchpad/profile.js` (DevTools profiler,
> self time per function) is the tool that found it; call counts alone will
> mislead you again.

---

## Where 0.18.0 landed

**Shipped in 0.18.0:**

1. **Local playback with instant offline analysis** — open files or a folder and
   the overlay plays them itself. The decoded samples are already in hand, so the
   energy arc, the tempo and drop anticipation are all measured offline on play
   one, with no `♫` capture and no permission prompt. Position comes from the
   audio element, which is exact where SMTC is a 250ms poll.
2. **A library panel worth opening** — card grid, search, badges for what is
   known about each song, click to play.
3. **Notification tray** — closes the old item 2. Only transcription finishing
   raises an OS notification.
4. **Wormhole + `soloLayer`** — a preset that draws its layer and the words and
   suppresses every always-on extra.
5. **Sprite draw 49 ms/s → 0.5 ms/s** — this is what closed the nameplate
   `measureText` item; plates are now cached bitmaps keyed on
   `label|fontPx|colour` (`sprites.js` `namePlate`).

**Still carried forward:** artwork candidates / side poster (item 1 below).

Verification against real audio (item 0) has now been offered four times and
declined each time. It is **four releases deep**: 0.15.0 through 0.18.0 all rest
entirely on harness and unit-test evidence, and all are in published installers.
This is the item most likely to be the source of an embarrassing bug report, and
it costs one song.

---

## Per-frame draw cost

Measured by patching the canvas prototype from the page — call counts, not frame
rate, because repeated identical runs vary 3–4× in fps here and cannot rank two
presets. Reproduce with the perf harness (same rules as the screenshot harness).

| preset | fillRect | arc | stroke | gradients |
| --- | --- | --- | --- | --- |
| Ghost | 0 | 0 | 0 | 0 |
| Liquid | 69.5 | 16.4 | 4.6 | 0.2 |
| Heatmap | 164 → **72** | 16 | 6 | 0.2 |
| Vinyl | 166 → **72** | 31 → **21** | 18 → **10** | 1 → **0** |
| Stage | 72 | 17 | 6 | 4 → **0.1** |
| Concert | 66.6 | **300** | 46 | 0.2 |

0.15.0 shipped three regressions against this file's own idiom (it already
caches the vignette on resize and pre-renders glow sprites by colour). All three
are now fixed: the timeline and the vinyl platter are pre-rendered bitmaps, the
stage gradients are cached, and `HeatMap.cells()` is memoised against the same
revision counter `sections()` already used.

**The trap worth remembering:** the first attempt keyed those caches on
`accentLive`, which is `shiftHex(accent, bgHue)` and therefore changes every
frame — so the caches rebuilt constantly and saved almost nothing (measured:
still 144 fillRect against an expected 72). Anything cached by colour must key
on a **snapped** hue; see `quantisedColours()`.

**Concert was addressed in 0.17.0** — see the changelog. `drawGalaxy` fell from
17.62 to 2.44 ms/s and `drawConstellation` from 2.94 to 0.85 ms/s, measured by
profiler self time.

**Still open:**

- **`(program)` dominates every profile** at ~850 ms/s against ~45 ms/s for all
  app JavaScript combined. That is native compositing of a full-screen
  transparent always-on-top window, and it confirms the standing note that
  rewriting the drawing in a native language would optimise something that is
  already not the constraint. Further JS micro-optimisation has little left to
  win.

  **The corollary is the plan:** the only remaining lever big enough to matter is
  *compositing fewer pixels*. Compact display modes (ROADMAP item 3) are
  therefore the largest performance change available as well as the largest
  adoption one — a taskbar strip composites a few percent of the surface a
  fullscreen overlay does.

- **The lyric loop writes layout-affecting style every frame.** `frame()` sets
  `els.progressFill.style.width` on every vsync, for a bar a few hundred pixels
  wide where sub-pixel changes are invisible. Throttling it to ~10 Hz and
  quantising to 0.1% removes ~50 style invalidations per second on a surface
  whose compositing is already the constraint. Small, but it is on the expensive
  side of the ledger.

---

## Requested, not built

### 0. Verify the new modes against real audio

0.15.0's visuals were built and captured through an Electron screenshot harness
with a *synthetic* heat map (see the recipe in the `gpu-swirl-field` note).
Everything below was proven in that harness or by unit test:

- the persistence round trip (learn → flush on track change → save → reload →
  read forwards), including one save call per track change and the
  duration-mismatch guard;
- `lookahead` reporting a 0.79 rise 4s ahead of a learned drop;
- section naming, and the beat-locked pose maths.

**Not yet seen on real music**: the heat map filling in from live capture over a
whole song, the anticipation coil landing on an actual drop, and whether four
beats per platter revolution reads right at real tempos. All of it needs the `♫`
chip and one full play. Nothing here is suspected broken — it is simply the
difference between measured and watched.

### 1. Side poster panel

A panel showing the current cover art, clickable to choose an alternative.

**Blocker to decide first:** `src/main/artwork.js` returns a *single* winner
(iTunes → Deezer → MusicBrainz/Cover Art Archive, first hit wins). "Options on
click" needs it to return **candidates**, which is a fetch-layer change before
any UI exists. Roughly: `fetchArtwork` → `fetchArtworkCandidates` returning
`[{url, source, width}]`, panel renders them, the pick is persisted per track in
`llmCache` alongside the other per-song state.

**Also decide:** does a chosen cover override the palette? Today artwork drives
`extractArtPalette()`, so changing the poster recolours the whole app — probably
desirable, but it should be a deliberate choice rather than a surprise.

### 2. Notification tray — **shipped in 0.18.0** (`src/main/tray.js`)

---

## Built but not fully verified

### Word-level alignment, end to end

The aligner (`src/main/wordalign.js`) is unit-tested and verified on real audio
in isolation — 91% coverage, correct lyric spelling on Whisper's clock. The
trigger is wired (`transcribe-audio` handler → `attachWordTimings`).

**Never watched run as a whole**: record → align → cache → replay word-synced.
It needs audio capture enabled (`♫`) and a full song. Until someone sees that
cycle complete, treat word-level sync as plausible rather than proven.

### Tempo accuracy

`src/renderer/tempo.js` recovers synthetic tempi exactly, and on a real house
track holds 137.6 BPM with independent windows agreeing (137.6 / 137.0 / 138.2).
**Nobody has confirmed 137.6 is that track's true tempo.** Checking one song
against a known BPM would settle it either way.

---

## Known limits (deliberate, not bugs)

- **Transliteration is approximate.** `src/main/romanize.js` handles schwa
  deletion, conjuncts, coda-r and anusvara, but romanization is lossy: dental vs
  retroflex is simply not written, "mein" renders मेइन rather than मैं, and
  gemination across a digraph ("shradhdha") is imperfect. It is good enough to
  feed the offline translator, **not** good enough to display. `transliterate.js`
  (LLM-backed) remains the better choice for display.

- **Offline translation is Devanagari-first.** `Xenova/opus-mt-hi-en` reads
  Devanagari only; romanized input goes through the transliterator above, which
  costs quality. An LLM provider still translates romanized lyrics better.

- **Frame rate is not measurable on this hardware.** Repeated identical
  configurations vary 3–4×. Optimise against `drawCostMs` (CPU cost, repeatable
  to ~0.1ms) and never against observed fps. See the `perf-measurement` note.

- **Native code is the wrong lever.** Measured: total CPU rendering cost is ~3ms
  of a 16.7ms budget, and removing 95% of it (Ghost mode) does not reliably move
  the frame rate. A C++/Rust rewrite would optimise something that is already not
  the constraint.

---

## Environment gotchas that cost real time

- **`node_modules/@huggingface/transformers/.cache` must stay excluded** from the
  build. Any dev run touching a pipeline drops hundreds of MB there and
  electron-builder will bundle it — caught once at 341MB against a normal 124MB.
  The exclusion is in `package.json`; verify with a marker file if ever in doubt.

- **HuggingFace tokens need the "Inference Providers" scope.** A plain read token
  returns 403. Since 0.12.1 the provider chain falls through and names the reason
  rather than dying silently on the first failure.

- **Harness: one window per process, and `show: true`.** Hidden windows throttle
  `requestAnimationFrame`, which fabricates timing bugs that do not exist;
  creating several transparent/always-on-top windows in one process silently
  produces no output at all. Drive it through the **real** preload and the real
  IPC channel names — most renderer state is module-scoped and unreachable from
  `executeJavaScript`, and going through the channels tests the wiring too.
  Stub every `ipcMain.handle` the renderer invokes at startup (`get-offset`,
  `get-prefs`, `get-transcribe-config`, `get-provider-status`, `list-synced`) or
  boot stalls on a rejected promise.

- **`null` on a load channel is ambiguous — resolve it deliberately.** Main
  sends `heatmap: null` / `beatmap: null` to mean *nothing is stored yet*, which
  is **not** the same as *forget what you have*. Treating the first as the second
  wiped the empty map the track had just been given and left every song unable to
  learn anything at all. This was caught only by running the round trip; unit
  tests passed throughout, because each half was correct on its own.

---

## Suggested order

1. **Release hygiene** — nothing outstanding; v0.18.0 is current and merged to
   `main` (PRs #37, #38).
2. **Play one song through with `♫` on** — settles item 0 and item "verify word
   alignment" in the same sitting, since both need exactly one full play with
   capture enabled. Local playback (0.18.0) makes this cheaper than it was: a
   file needs no capture permission at all.
3. **Butterchurn as a second engine + a preset system** — `ROADMAP.md` items 1–2,
   the visual-variety gap. Guard the second WebGL2 context: `swirl.js` already
   owns one, and both alive at once doubles GPU cost for no benefit. The engines
   must be mutually exclusive, with the idle one torn down.
4. **Compact display modes** — `ROADMAP.md` item 3, and the largest performance
   change available; see "Still open" above.
5. **Side poster** — decide the candidates API first, then build the panel.
   Note that Vinyl already puts the cover art on screen at full crispness, so
   part of the motivation for this may already be met.
