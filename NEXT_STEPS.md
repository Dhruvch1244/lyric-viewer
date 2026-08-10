# Next steps

Current as of **v0.17.0**. Written to be picked up cold — each item says what
is missing, why it was left, and what the first move is.

> **Profile before optimising anything in the render loop.** 0.16.0's draw-call
> audit ranked Concert by canvas calls and concluded the galaxy was 300 arcs.
> The actual cost was `shiftHex` running once per particle per frame — no canvas
> call at all, and 5× the expense. `scratchpad/profile.js` (DevTools profiler,
> self time per function) is the tool that found it; call counts alone will
> mislead you again.

---

## Where 0.16.0 landed

Agreed after the 0.15.0 draw-cost audit, then cut as a release before the whole
list was worked through. **Shipped in 0.16.0:**

1. **Draw-cost payback** — see "Per-frame draw cost" below.
2. **The `♫` prompt** — one-time and dismissible, per install.

**Agreed but not built, so these carry into 0.17.0:**

3. **Notification tray** — item 2 below.
4. **Artwork candidates / side poster** — item 3 below.
5. **More visual modes** — the layer system composes cleanly now, so each new
   look is far cheaper than Vinyl and Stage were.

Verification against real audio (item 0) was offered twice and declined both
times. It is now **two releases deep**: 0.15.0 and 0.16.0 both rest entirely on
harness and unit-test evidence, and both are in a published installer. This is
the item most likely to be the source of an embarrassing bug report, and it
costs one song.

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

- **Sprite nameplates call `measureText` per dancer per frame** (~2.4/frame with
  three dancers). The structure label caches its width; the nameplates do not.
  Small, and the same fix.
- **`(program)` dominates every profile** at ~850 ms/s against ~45 ms/s for all
  app JavaScript combined. That is native compositing of a full-screen
  transparent always-on-top window, and it confirms the standing note that
  rewriting the drawing in a native language would optimise something that is
  already not the constraint. Further JS micro-optimisation has little left to
  win.

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

### 2. Notification tray

System tray icon plus native notifications for background work.

The data already exists: the renderer's `jobs` map (added in 0.14.0) is exactly
the set of things worth notifying about. The work is a main-process `Tray`, an
icon asset, and an IPC channel carrying job changes out of the renderer.

**Decide:** which jobs deserve an OS-level notification versus the in-app chip
only. Transcription finishing is genuinely useful; "finding lyrics" fires on
every track and would be noise.

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

1. **Release hygiene** — nothing outstanding; v0.15.0 is current.
2. **Play one song through with `♫` on** — settles item 0 and item "verify word
   alignment" in the same sitting, since both need exactly one full play with
   capture enabled.
3. **Notification tray** — smaller, and the job data already exists.
4. **Side poster** — decide the candidates API first, then build the panel.
   Note that Vinyl already puts the cover art on screen at full crispness, so
   part of the motivation for this may already be met.
