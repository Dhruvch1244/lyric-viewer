# Next steps

Current as of **v0.14.0**. Written to be picked up cold — each item says what
is missing, why it was left, and what the first move is.

---

## Requested, not built

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
  produces no output at all.

---

## Suggested order

1. **Release hygiene** — nothing outstanding; v0.14.0 is current.
2. **Notification tray** — smaller, and the job data already exists.
3. **Side poster** — decide the candidates API first, then build the panel.
4. **Verify word alignment end to end** — cheap, and it de-risks a headline
   feature that is currently only plausible.
