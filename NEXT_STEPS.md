# Next steps

**Read this section first — everything below "Current as of v0.22.0" predates
the Electron→Tauri rewrite (0.25.0–0.30.0) and is historical record, not
current state.** Wallpaper mode, MilkDrop, the render loop and most named
bugs below were rewritten or superseded since; kept rather than deleted
because the *lessons* at the top (verify end to end, ask the system what
happened, profile before optimising) are still exactly right, even where the
specific bug they came from is gone. Treat file-and-line references below as
Electron-era unless a section explicitly says otherwise.

## Current as of v0.45.0 — 2026-08-23

The Tauri rewrite, the job engine (0.37.0) and library indexing (0.38.0)
landed long after the v0.22.0 section below was written. `docs/JOB-ENGINE.md`
is the authoritative phase-by-phase status for the backend,
`docs/PERF-UX.md` for the performance/UX axis, and `ROADMAP.md` for
competitive positioning. This is the cold-start pickup list for what is
genuinely unresolved right now.

### Closed since 0.39.0 — do not re-open these

- **Vocal isolation, and the whole class of song it unlocks (0.41.0).** Silero
  is a *speech* detector and scores sung vocals over dense production flat
  zero — measured p50 0.000 across a 180s track with an audible hook, so that
  music could not be auto-transcribed at all. Demucs ahead of the VAD takes
  the same track from **0% voiced to 72%** and from no lyrics to a correct
  transcription. Runs as a *retry*, only when the normal pass finds nothing.
- **Background process priority was costing 11.5x (0.41.0).** Measured on one
  identical unit of work: 4.46s normal, 5.39s BELOW_NORMAL, **51.39s** under
  `PROCESS_MODE_BACKGROUND_BEGIN`. Every transcription the app had ever run
  was paying it; Whisper is ~4x faster now.
- **Phrase-level decoder loops (0.41.0).** The guard only looked for periods of
  1–4 tokens; a real track looped a ~12-token line 20 times and that one
  window took 119s. Now caught, while still letting a chorus repeat.
- **AcoustID verified live (0.40.0)**, and the speech-model download is
  consent-gated on *both* the native and WebView paths (0.40.0/0.41.0), with
  consent now recorded per purpose.
- **The control surface (0.42.0/0.43.0).** The bar went from nineteen
  unlabelled chips to five plus a More popover; the 🔑 panel became a real
  Settings screen; MilkDrop gained a visible shuffle, a reachable heart and a
  random start; "preset" stopped naming two different systems.
- **`docs/PERF-UX.md` P1/P2, and P3's premise corrected (0.44.0).** A perf
  harness now lives in the repo (`npm run perf`, `scripts/perf/`), asserting
  draw cost against a committed baseline instead of every claim costing a
  from-scratch rig. The render loop now pauses in overlay mode too — lock,
  exclusive-fullscreen, occlusion/minimise — and throttles to Lite rather
  than blanking on battery; previously all of that only fired in wallpaper
  mode. P3's "update check and library rescan compete with first paint" was
  checked against the code and found wrong on every specific item; a real
  measurement tool (`npm run perf:startup`) replaces the assumption, but
  wants a real track run against it to produce an actual number.
- **`docs/PERF-UX.md` P3's real-track run, closed for real (0.45.0).**
  `npm run perf:startup --track <path>` now drives real local playback
  itself via `LocalPlayer.enqueue()`. First pass against a debug build found
  something alarming — a ~30s dead zone where the renderer stopped
  responding and the track aborted — but a follow-up against
  `npm run perf:build-release` on two different tracks (EDM, hip-hop) found
  no dead zone at all: largest gap between samples 309ms/367ms, both
  recovering into the same noisy-but-alive fps series the original 0.21.0
  measurement showed. The debug-build freeze was `analyzeLocalFile`'s
  unoptimized symphonia decode, not a shipped bug. Do not re-open this
  expecting a different answer on a debug build — that was the artifact.
- **`docs/PERF-UX.md` U3 — one panel primitive, shipped (0.45.0).** A shared
  `panel-focus.js` (Tab-trap, Escape-to-close, focus-restore-to-opener) is
  now wired to all eleven real dialog-style panels via one registration
  point in `onboarding-cards.js`, driven by each panel's existing `hidden`
  attribute rather than rewriting each one's bespoke open()/close(). The
  three ambient toast notifications (capture nudge, update card, local-CLI
  offer) deliberately keep their non-modal `role="status"` behaviour —
  trapping Tab into a passive corner toast would have been a regression, not
  a fix. Verified live: opener-tracking, Tab-wrap both directions, and
  Escape-restore-focus all confirmed against the real app.
- **MilkDrop's curated shortlist grown 10 → 150, machine-vetted (0.45.0).**
  The 10-preset shortlist `milkdropCyclePool()` falls back to (favourites
  aside) was too small to read as "shuffle," but the fix couldn't be "cycle
  all 1754" — that was tried before and explicitly walked back, since a
  large share of the corpus is dim, broken on this renderer, or ugly. All
  1754 were surveyed against the real engine (luminance + texture scoring),
  1171 passed a broken/blank filter, 150 were stratified-sampled from the
  upper score band and spot-checked by eye. Reproducible via
  `scripts/perf/curate-milkdrop-presets.mjs`.
- **HUD/More-menu icon-only chips got visible labels (0.45.0).** Import,
  Search, Sprites, Lite, Pre-sync, Cover, Settings, Lyrics and Audio were
  icon-only with just a tooltip; each now carries a short visible label,
  matching the style already used by "◈ Liquid" and "⇄ Shuffle."

### Actually open

1. **Diarization is parked, not in progress (JOB-ENGINE §5.8).** Everything
   below the model works and is tested — VAD gating, fbank front end,
   embedding, clustering, protocol, host command. The *capability* does not:
   on a duo, forced to exactly two clusters, it returns **320 windows against
   1**, and isolating the vocals first does not help (154 vs 1), so the
   instrumental was never the confound. It is the model or the task. Do not
   pick this up expecting a quick win.
2. **AcoustID's real-recording path has still never run.** The live test
   proves the request/response shape using synthetic audio that matches
   nothing. The full loopback-capture → fingerprint → AcoustID → MusicBrainz
   chain has never been watched complete against a real song in a browser tab
   — and the cache already contains the broken metadata it exists to fix
   (`T-Series`, `…VEVO` as artist names).
3. **`docs/PERF-UX.md` P2 wants real OS-level verification.** The code path
   (lock/fullscreen/occlusion/battery, per mode) is in and structurally
   smoke-tested over CDP, but Win+L / alt-tab-to-fullscreen / minimise /
   virtual-desktop-switch / unplug-AC has not actually been run by a human
   yet, across full/bar/strip.
4. **`player.js`'s `playAt()` has no visible failure state.** A slow or
   failed read silently falls through `if (!raw) { next(); return; }` — low
   priority now that the debug-build dead zone that surfaced it turned out
   to be a measurement artifact (see "Closed since" above), but still a real
   gap if some other codepath hits it.

---

Everything from here down is the **Electron-era** file, current as of
**v0.22.0**. Written to be picked up cold — each item says what
is missing, why it was left, and what the first move is.

> **0.22.0's lesson: a feature can be "verified" and still ship broken if the
> harness never exercised the state that breaks it.** Wallpaper mode passed
> every 0.21.0 check, then in real use lost the song on every switch (the window
> was rebuilt), came back invisible (z-order), couldn't scroll (no wheel
> forwarding), and reverted a picked preset (the FPS governor bounced the engine
> and the re-entry wiped the choice). None of those states — a *switch* with a
> song playing, a *panel* open in wallpaper, an *engine bounce* — were in the
> harness. When something is reported broken that "tests pass" for, the test is
> missing a state, not wrong.

> **0.21.0's lesson, on top of the one below: ask the system what happened,
> don't read it off a return value.** `SetParent` reports failure by returning
> null, and null is also the legitimate previous parent of a top-level window.
> Every call was failing with ERROR_INVALID_WINDOW_HANDLE — `koffi.as(buffer,
> 'void*')` passes the address OF the handle buffer, not the HWND inside it —
> and three z-order theories were built and photographed on top of that before
> one line (`GetParent`) ended it. `GetLastError`, `GetWindowLongPtr` and
> `GetWindowRect` had all been sitting there with the answer, unasked.

> **Profile before optimising anything in the render loop.** 0.16.0's draw-call
> audit ranked Concert by canvas calls and concluded the galaxy was 300 arcs.
> The actual cost was `shiftHex` running once per particle per frame — no canvas
> call at all, and 5× the expense. `scratchpad/profile.js` (DevTools profiler,
> self time per function) is the tool that found it; call counts alone will
> mislead you again.

---

## The "best release" plan — karaoke-grade sync (#3) + visual depth (#4)

The chosen direction for the next few releases. 0.23.0 shipped the first,
verifiable piece (the karaoke word wipe). The rest, in honest cost order:

**Karaoke-grade sync (#3):**
1. **Real word-level timing where a source has it.** The wipe currently runs on
   an estimate (syllable-weighted division of the line). LRCLIB's enhanced-LRC
   extension carries true per-word stamps but a survey found zero entries using
   it; the aligner (`wordalign.js`) produces real stamps from Whisper and IS
   wired, but the record→align→cache→replay cycle has never been watched end to
   end. First move: one full play with `♫` on, watch a word-synced replay.
2. **Vocal isolation (Demucs) before transcription.** The real accuracy ceiling
   for songs with no lyrics. Heavy: a ~150MB+ model, minutes of CPU, and it
   CANNOT be shipped without an install-and-transcribe run to verify — building
   it blind is how transcription dies for everyone. Do it as an optional pack
   (the same machinery the ONNX-runtime split needs), never bundled.

**Visual depth (#4):**
3. **More 2D layers onto the GPU.** The galaxy, parametric curves and
   constellation are the remaining per-frame CPU cost; moving them into the
   swirl shader cuts CPU and allows far higher particle counts. Medium risk,
   all local, verifiable by draw-cost profiling.
4. **Per-mood visual profiles.** The sentiment pass already computes energy and
   a mood; today only the palette uses it. Let energy drive the motion floor and
   mood bias the curated preset pool. Blocked on a working LLM/sentiment
   provider to verify — the local-CLI fallback (0.22.0) now unblocks it.
5. **Polished beat-synced preset transitions.** The MilkDrop cycle cuts on
   drops; a short cross-fade timed to the beat would read as designed rather
   than abrupt. Low risk.

---

## Where 0.22.0 landed

**Shipped in 0.22.0 — the "make desktop mode real" release:**

1. **Switching modes keeps the song playing.** The window is created once and
   never rebuilt; wallpaper is a reparent toggle on it. Everything the renderer
   holds — playback, lyrics, capture, open panels — survives a switch.
2. **Leaving desktop mode is visible again** — the window is raised to topmost
   in the same native step that detaches it (was returning behind everything).
3. **Desktop-mode panels are usable** — opening one surfaces the window to the
   front for real wheel/drag/focus, then settles it back on close.
4. **One overlay + a desktop toggle**, not a four-mode cycle. bar/strip remain
   reachable via `set-display-mode`, off the main path.
5. **MilkDrop opens on a curated preset**, and a picked preset no longer reverts
   when the FPS governor bounces the engine.
6. **Friendly "what's new" card** after an update, once per version.
7. **Local developer-CLI fallback** (Claude/Gemini/Ollama/gh/Antigravity) when
   every cloud provider fails — consent-gated, verified with `claude -p`.

**Still unverified end to end:** per-line attribution against a live model. It
now *can* run via the local CLI — pick Claude in the fallback card and play a
multi-artist track — but no full attribution pass has been watched complete.

---

## Where 0.21.0 landed

**Shipped in 0.21.0:**

1. **Auto-update actually works** — the blockmap is published, the install
   directory is fixed so an update replaces rather than duplicates, it
   re-checks every six hours, and there is a card on screen instead of a tray
   menu nobody opens.
2. **1754 presets** (was 395) as files read on demand, and a browser with
   rendered previews, favourites, hiding and arrow-key stepping.
3. **Wallpaper mode**, clickable via forwarded pointer input.
4. **Per-line artist attribution** — built and unit-tested, never verified
   against a live provider.
5. **Kugou** as a third synced lyric source.
6. **The swirl resolution governor** no longer feeds itself.

**Three beliefs measured out of existence in 0.21.0:**

- The screen-share prompt (roadmap adoption blocker #3) **does not happen**.
  `setDisplayMediaRequestHandler` has been auto-approving loopback for
  releases. The WASAPI item is dropped, not deferred.
- The 30–44fps dips are **not MilkDrop-specific**. They reproduce on the swirl
  engine, correlate with startup work, and recover on their own.
- The progress-bar style write **was already throttled** — this file listed it
  as open when the code had done it for releases.

---

## Older: where 0.18.0 landed

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

- ~~**The lyric loop writes layout-affecting style every frame.**~~ **Already
  done** — `renderer.js` quantises the progress bar to 0.1%, which settles at
  ~5 writes/s. This entry was stale when 0.21.0 went looking for it, which is
  its own small lesson about trusting this file over the code.

---

## Requested, not built

### Per-line artist attribution — **built in 0.21.0, never run**

`src/main/attribute.js` and `ArtistSprites.mapAttribution` are written, wired
and covered by 24 tests. **No successful provider call has ever been made**:
Gemini reports quota exhausted and the HuggingFace token lacks the Inference
Providers scope, so `isAttributionAvailable()` is the only path that has run in
anger. Everything downstream of `convert()` is unproven against a real model —
in particular whether the model returns exactly one index per line often enough
for `normaliseSingers` to accept the batch rather than reject it.

**First move:** get any one provider working and play a multi-artist track. The
answer is cached per song, so it costs one request to find out.

Still not done, and cheap: the dancers know about `sections()`, so a build-up
could crouch them and a drop could launch them, instead of the beat clock being
the only thing they read.

### The frame-rate dips — **partly diagnosed in 0.21.0**

0.20.0 blamed fullscreen MilkDrop and suspected the Butterchurn cross-fade.
Both look wrong. Measured on a real track: the dips reproduce on the **swirl**
engine (Wormhole), running 116 → 20 → 19 → 29 → 53 → 36 → 87 → 171 → 240 fps
across the first 73 seconds and recovering completely. They correlate with
startup work — decode, offline analysis, lyric and artwork fetch — not with the
visual engine.

One real cause was found and fixed: the swirl's resolution governor dropped a
rung with no rate limit, and each rung change reallocates a WebGL drawing
buffer, which costs a long frame, which dropped the next rung. `resize`
measured 289ms of self time.

**Still open:** the profile is dominated by `(program)` at 29,092ms of 48,409ms
sampled, against ~3.5s for all app JavaScript combined. That is native
compositing, and it confirms the standing note — the remaining lever is
compositing fewer pixels, not faster JS. Whether the startup burst can be
staggered has not been tried.

### Genius as a lyric source — deliberately not done

NetEase shipped as a second **synced** source. Genius did not, and it should not
be picked up without a decision, because it cannot be done the way every other
source in this app is done.

Genius has no lyrics API. Their documented API returns metadata — song ids,
titles, artists, album art — and explicitly not the lyric text; the words exist
only in the HTML of the song page. Every "Genius lyrics" library works by
scraping that page.

That collides with a rule this codebase already follows and states in
`artwork.js`: HTML scraping is avoided because it is brittle, breaks silently,
and carries ToS risk. Silent breakage is the worst of the three here — a scraper
that starts returning navigation chrome instead of lyrics produces a song
captioned with garbage rather than an error anybody notices.

If it is wanted anyway, that is a deliberate reversal of the no-scraping rule
and should be recorded as one, not slipped in as a fourth source.

**What to do instead**, in rough order of value:
1. ~~**Musixmatch's community API**~~ — **checked in 0.21.0, not adopted.** The
   API answers (401 on a bad key, so the endpoint is live), but the free tier
   returns a 30% excerpt of *plain* lyrics and no synced subtitles at all. An
   app that shows a whole song in time with it cannot use either.
2. ~~**QQ Music / Kugou**~~ — **Kugou shipped in 0.21.0** (`src/main/kugou.js`),
   third in the chain after LRCLIB and NetEase. QQ Music is still untried and is
   the obvious fourth if coverage is still short.
3. **Deepen what exists** — the aligner already turns a *plain* lyric into a
   synced one, and LRCLIB's plain catalogue is far larger than its synced one.
   This is now the largest coverage win left.

### The rest of the optional transcription pack

0.19.0 took the safe half: `DirectML.dll` and `dxcompiler.dll` (35MB on disk)
are no longer packaged, because `transcribe.js` documents from measurement that
DirectML loads and then fails allocation. Installer 123.3MB → 114.2MB, with
2.5MB of preset packs added in the same build.

**The remaining 22.7MB is `onnxruntime.dll`, and it was not attempted.** Making
it downloadable on first use is not a packaging change, it is a module-loading
change, and every version of it is fragile:

- `onnxruntime-node` loads its binding by a fixed relative path
  (`../bin/napi-v6/win32/x64/onnxruntime_binding.node`), and the `.node` then
  finds `onnxruntime.dll` through the Windows DLL search path — i.e. its own
  directory. So the two must be downloaded together, into one directory, and
  something has to make `@huggingface/transformers` resolve *that* copy instead
  of the packaged one (pre-seeding `require.cache`, or patching `module.paths`).
- Writing into the app directory happens to work today only because
  `perMachine: false` puts the install under `%LOCALAPPDATA%`. A user who takes
  `allowToChangeInstallationDirectory` and picks `Program Files` would need
  elevation, and it would fail after the fact rather than at install time.
- A downloaded, unsigned native DLL is a routine antivirus false positive.

None of that is unworkable, but none of it can be verified without building an
installer, installing it, and transcribing a song — and if it is wrong,
transcription is dead for everyone rather than merely large. It needs one real
end-to-end run before it ships, not a code review.

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

- **An install made before 0.21.0 may be PER-MACHINE, and auto-update cannot
  replace it.** Hit for real on 0.21.0's first update. Up to 0.20.0 the NSIS
  installer allowed a custom directory; choosing `C:\Program Files` makes NSIS
  escalate to an all-users install registered under HKLM with an `/allusers`
  uninstaller. The app itself is configured `perMachine: false`, so a later
  installer runs per-user, finds an all-users install it has to remove, and
  needs elevation to do it — producing *"Failed to uninstall old application
  files. Please try running the installer again"*.

  Two things compound it. The app leaves **five processes** running (overlay
  plus renderers) and a tray icon, so files are locked unless it is fully quit.
  And under auto-update the installer runs **silently on quit**, so for anybody
  who is not watching this fails with no dialog at all and the update simply
  never happens, forever.

  **The fix is one-time and manual:** quit the app completely, uninstall the
  Program Files copy with its own elevated uninstaller, then install normally.
  Afterwards the install is per-user under `%LOCALAPPDATA%\Programs`, needs no
  elevation, and every later update works. 0.21.0 sets
  `allowToChangeInstallationDirectory: false` so a new install cannot end up
  this way, but that does nothing for one that already did.

  **If the audience ever grows, detect it:** on startup, look for this app's
  product GUID under HKLM while running from `%LOCALAPPDATA%`, and say so
  plainly rather than letting updates fail in silence.

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

1. **Get one LLM provider working and play a multi-artist track.** Per-line
   attribution is the only thing 0.21.0 shipped that has never run. One request
   settles it, and the answer is cached per song.
2. **Verify an update in the wild.** 0.21.0 fixes the blockmap and the install
   directory, but the proof is installing it and watching 0.22.0 arrive. Two
   releases have now claimed a working updater; neither claim was tested by an
   actual update.
3. **The optional transcription pack** — the last 22.7MB, and the only
   remaining item that needs an installer built, installed and a song
   transcribed before it can ship. See the section above for why every version
   of it is fragile.
4. **Stagger the startup burst** — the frame dips are startup work, now
   measured. Nothing has been tried yet.
5. **Word-level alignment, end to end** — still never watched run as a whole.
