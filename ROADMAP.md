# Roadmap — the best music visualiser that also knows the words

Strategy document, written after a competitive review in August 2026. This is a
plan to argue with, not a backlog to grind.

**Status note (2026-08-16):** most of this was written as "nothing here is
built yet," but the app shipped fast enough that a lot of it is no longer
true a few weeks later. Rather than let the doc quietly rot again, each item
below is marked ✅ **shipped**, 🔁 **reversed** (tried, then deliberately
undone — a real decision, not neglect), or left unmarked if it's still open.
The competitive analysis in sections 1-2 holds up fine; it's the plan and gap
list in sections 3-5 that needed the pass.

---

## 1. The positioning decision

The goal is **both**: the best music visualiser on Windows *and* a lyric
display good enough to compete head-on — in a style that is recognisably ours.
That is defensible, because the two markets are separate today and **nothing
sits in the overlap**.

**Against lyric apps**, the visuals are the moat.
[Sonar](https://github.com/EchoVial/Sonar) chains three lyric sources with
word-by-word rendering, [Lyrictified](https://github.com/ios7jbpro/lyrictified)
does the same SMTC + LRCLIB job in a fraction of the download, and Musixmatch
and Spotify have catalogues nobody can match. But every one of them is a *text
renderer* — a bar, a taskbar strip, a floating line. None has a reactive visual
system.

**Against visualisers**, the lyrics are the moat.
[projectM/MilkDrop](https://github.com/projectM-visualizer/projectm) has
thousands of community presets, [Plane9](https://plane9.com) ships 250+ scenes
with 39 transitions, and Wallpaper Engine has a Steam Workshop. All of them are
far ahead of us on visual variety — and **not one of them shows lyrics.**

> The empty space is: *MilkDrop-class visuals with synced lyrics on top.*
> Nobody occupies it. That is the product.

Being honest about the gap: on visuals alone we currently have **one look**
(the swirl field plus some 2D layers on a random shuffle) against projectM's
thousands and Plane9's 250. Winning the visualiser half needs a real answer to
that, not incremental polish — see Phase 1.

---

## 2. What to take from each competitor

Competitors are free R&D. Each has solved something worth copying outright.

### Visualisers

| Source | Their strength | What we take |
|---|---|---|
| **[Butterchurn](https://github.com/jberg/butterchurn)** | MilkDrop 2 reimplemented in **WebGL2**, **MIT licensed**, driven by a Web Audio node | **The headline move — adopt it wholesale.** See Phase 1. |
| **projectM / MilkDrop** | Thousands of community presets; a preset *format* with an ecosystem | The preset concept: named, curated, cycleable looks instead of a random shuffle. |
| **Plane9** | 250+ scenes, 39 **transitions**, scene *playlists* | Transitions and playlists. Cutting between looks on a beat is a big part of why it feels designed. |
| **Wallpaper Engine** | Runs as the desktop wallpaper; Workshop distribution | A wallpaper/screensaver mode — the app becomes ambient rather than something you launch. |

### Lyric apps

| Source | Their strength | What we take |
|---|---|---|
| **Sonar** | LRCLIB → NetEase → Genius chain, keyless | The multi-source chain. Proven, and needs no API keys. |
| **Sonar** | Word-by-word reveal | The polish bar. Ours is interpolated from line timing; theirs reads tighter. |
| **Sonar / Lyrictified** | Taskbar strip / compact floating / click-through modes | A fullscreen overlay is a commitment; a taskbar strip is something you leave on all day. |
| **Lyrictified** | Album artwork in the bar | Already have the artwork pipeline — reuse it in compact modes. |
| **python-lyrics-transcriber** | Anchor-sequence alignment + **LLM auto-correction** of the transcript | The LLM correction pass. Gemini/Groq/HF/Claude are already wired up. |
| **LyricWhiz** (paper) | Whisper as the "ear", an LLM as the "brain" | Validates the above as state of the art, not a hack. |
| **Musixmatch / Spotify** | Catalogue | Nothing — cannot be matched. Do not try. |

---

## 3. Gap analysis

Honest list of what is actually weak, worst first.

### Against visualisers

0. **We have one look; they have hundreds.** The swirl field plus a random
   shuffle of 2D layers is a single aesthetic. projectM has thousands of
   presets, Plane9 has 250 scenes and 39 transitions. Variety is the entire
   basis on which visualisers are judged, and it is our weakest axis by far.
0b. **The shuffle reads as arbitrary, not designed.** Layers switch on a random
   timer. There is no named look to choose, return to, or recommend to someone.
0c. **Audio analysis is shallow.** Three bands (bass/mid/treble) plus onset
   detection. MilkDrop presets run per-frame equations over the full spectrum.
   Richer analysis is a prerequisite for richer visuals.
0d. ✅ **Wallpaper mode — shipped (0.30.0), for real this time.** A first pass
   (0.28.0) removed it by accident while going fullscreen-only; brought back
   deliberately as a real feature with pointer-forwarding so the HUD stays
   clickable behind the desktop icons, plus a `Ctrl+Alt+M` escape hatch.

### Blocking adoption

1. 🔁 **One display mode, and it is fullscreen — REVERSED, not solved.** This
   gap's own reasoning (below) argued for adding a compact/taskbar mode.
   0.28.0 went the opposite way instead: it removed Bar/Strip and the
   Fullscreen/Bar/Strip menu entirely, coercing any persisted compact-mode
   pref to Fullscreen on launch ("gone for good," per the commit). The code
   paths were left dormant rather than deleted, but there's no menu, chip, or
   persisted state that can reach them anymore. If this bounce problem is
   still real, it needs a fresh decision, not a revival of the old menu.
   ~~The app takes over the screen or it does nothing. Every competitor offers
   a small, always-on mode. This is the single biggest reason someone tries
   it once and stops.~~
2. ✅ **124 MB installer — solved, differently than planned.** The plan here
   was to split transcription into an optional download pack. What actually
   fixed it: the Electron→Tauri rewrite. Signed installer is ~6MB now (vs the
   124MB this gap was written about) — Tauri has no bundled browser runtime,
   and Whisper's ONNX runtime/model download on first use regardless, so the
   "optional pack" problem this was solving no longer exists as a problem.
3. ~~**Audio reactivity needs a screen-capture permission prompt.**~~
   **Measured false, 0.21.0.** The loopback path does go through
   `getDisplayMedia`, but `main.js` installs a `setDisplayMediaRequestHandler`
   that answers it with the primary screen and `audio: 'loopback'`, so Chromium
   never raises a picker. Verified by clicking the `♫` chip with a real cursor
   through SendInput and photographing the screen 1.2s later: no dialog
   anywhere, and capture was already running. This gap was written before that
   handler existed and has been closed ever since.
4. ✅ **No first-run experience — shipped.** A first-run welcome card exists,
   separate from the what's-new-after-update card (renderer.js, "first run"
   section).
5. ✅ **No auto-update — shipped.** `tauri-plugin-updater` (signed) on the
   GitHub/NSIS channel; the Microsoft Store channel (once actually live —
   see Phase 5) updates itself instead, which is why the `store` Cargo
   feature compiles the updater plugin out for that build.

### Quality gaps

6. ✅ **Lyric coverage — mostly shipped; Genius pulled from the hot path.**
   NetEase and Kugou shipped as second/third synced sources, confirmed live.
   Genius as a second plain source was ALSO shipped, but a live verification
   pass (2026-08-17) found it Cloudflare-blocked with a JS challenge
   (`Cf-Mitigated: challenge`) on every request — not a bug in the scraping
   logic, a real anti-bot wall a plain HTTP client cannot pass, and not
   something this project will build tooling to defeat. Originally left in
   the fallback chain because it failed closed (silently `None`, same as a
   song this app doesn't have) — but that closed failure was still costing a
   bounded-timeout network round trip on every LRCLIB-plain miss for zero
   chance of success, so `fetch_plain_any` (lib.rs) no longer calls it
   (2026-08-19). The module and its tests stay in the tree — see genius.rs's
   module doc for the full finding; wiring it back in is a one-line change if
   Genius's posture or a legitimate access path ever changes.
7. 🔶 **Word timing was fully interpolated — now partially real, but blocked
   on a model limitation.** Real per-word timing lands for any lyric line
   where a Whisper transcription anchors directly AND the real line's word
   count matches the transcribed one exactly. A live verification pass
   (2026-08-17) confirmed the WASM pipeline itself works end-to-end, but
   found `return_timestamps: 'word'` specifically fails on the default model
   (`onnx-community/whisper-base`) — it wasn't exported with
   `output_attentions=True`, so the DTW alignment this mode needs has no
   cross-attentions to work with. Chunk-level timestamps work fine on the
   same model. Needs either a different model export or a graceful fallback
   when word-level extraction isn't supported. See align.rs / whisper.js.
8. ✅ **Transcription accuracy on dense music — both halves shipped.** Optional
   Demucs vocal isolation before transcription (0.29.0-ish), plus LLM
   correction of the raw transcript (correct.rs — a straight port of the old
   Electron-era `src/main/correct.js`, which existed before the Tauri
   migration and was never carried over). Runs only when nothing anchored
   real lyrics onto the transcription (source == "whisper"); a model that
   merged/split a line rejects that whole batch rather than desyncing the
   rest of the song. Whisper is still a speech model on sung vocals over a
   dense mix, so this raises the floor rather than solving mishearing outright.
9. **Transcription costs ~12 min of CPU per song** and is CPU-only — DirectML
   fails to allocate on this hardware. Also now runs via WASM in the webview
   (Tauri has no Node/onnxruntime-node), proxied to a Worker so it doesn't
   freeze the visuals — **confirmed live (2026-08-17)** end-to-end (model
   download, WASM session creation, inference) after fixing five separate
   packaging/CSP bugs the migration had left unnoticed. See
   scripts/vendor-whisper.js for the full list.

### Structural

10. **Windows-only.** Correct for now; SMTC is the whole detection layer.
11. ✅ **Single maintainer, no crash reporting — shipped.** An always-on
   local crash/error log (crashlog.rs): Rust panics and renderer JS errors
   both land in one file, discoverable via a button in the 🔑 panel,
   attachable to a bug report by hand. Plus the "in the wild" half: opt-in
   (off by default) automatic reporting to the maintainer's own Cloudflare
   Worker — not a third-party service — with a deliberately minimal payload
   (no track/artist/title/lyric text, ever).

---

## 4. The plan

Five phases. Each is independently shippable — no phase is a prerequisite for
the app staying useful.

### Phase 1 — Win the visualiser half ✅ shipped

The visual-variety gap is the one thing that cannot be closed incrementally,
and it is the axis the whole category is judged on. All four bullets below
shipped: Butterchurn/MilkDrop as a second engine with a preset catalogue and
thumbnails, a real named-preset system (since 0.10.0 — each song remembers
its own look instead of a random shuffle), beat-synced preset transitions
(`MILKDROP_SWITCH_MS` gates how often a drop can cut the look), and deeper
native audio analysis (`analysis.rs`, symphonia-based per-song DSP). Kept
below for the reasoning, which still holds.

- **Adopt Butterchurn as a second visual engine.**
  [Butterchurn](https://github.com/jberg/butterchurn) is MilkDrop 2
  reimplemented in WebGL2, MIT licensed, and driven by a Web Audio node. Every
  prerequisite already exists in this app: `swirl.js` proves WebGL2 works here,
  and `audio.js` already holds a live loopback `AudioContext` with an analyser
  — which is precisely what `connectAudio()` wants. A few MB of dependency buys
  the entire MilkDrop preset ecosystem, and makes us instantly competitive with
  projectM and Plane9 on variety.

  > **The signature look stays the default.** Butterchurn is *added* variety,
  > not a replacement. The swirl field is this app's identity — the thing that
  > times itself to lyric density, which no MilkDrop preset does and none can,
  > because they know nothing about lyrics. Ship the swirl as the default
  > engine, with Butterchurn presets as an alternate mode the user opts into.
  > If we ever look like "Butterchurn with subtitles" we have lost the thing
  > that makes this ours.

- **A real preset system.** Named, curated looks the user can cycle, pin and
  return to — covering both engines. This is what turns a random shuffle into
  something that feels designed, and it is the single biggest perceived-quality
  win available.
- **Beat-synced transitions between looks**, borrowed from Plane9. Cutting on a
  drop rather than a timer is most of why a visualiser feels alive.
- **Deeper audio analysis** to feed both engines: more bands, spectral centroid,
  per-band onsets. Prerequisite for richer reactivity, and Butterchurn benefits
  automatically.

### Phase 2 — Stop losing users

The app's problem is not capability, it is that people bounce before seeing the
good part.

- 🔁 **Compact display modes — tried, then reversed.** Three: fullscreen
  (today), a compact floating bar, and a click-through taskbar strip. Cycle
  with a hotkey and a chip; persist the choice. The visualiser stays in
  fullscreen mode; compact modes show line + artwork + a thin reactive accent.
  ~~What actually happened: 0.28.0 removed Bar/Strip entirely and went
  fullscreen-only, "for good" per the commit. The bounce-rate reasoning below
  was never disproven — it was just outweighed by something at the time. If
  this is revisited, it's a new decision, not a resurrection of dormant code.~~
- ✅ **Wallpaper / screensaver mode — shipped (0.30.0).** Render to the desktop
  background rather than an overlay. This is Wallpaper Engine's entire
  proposition and it turns the app from something you launch into something
  that is simply on.
- ✅ **Installer size — solved differently.** Not via an optional feature pack;
  via the Tauri migration (~6MB installer, no bundled browser runtime). See
  gap #2 above.
- ✅ **First-run overlay — shipped.** One dismissible card naming the chips,
  separate from the what's-new-after-update card.
- ✅ **Auto-update — shipped.** `tauri-plugin-updater` (GitHub/NSIS channel);
  the Store channel updates itself once actually live (see Phase 5).

*Everything in this phase shipped except the compact-mode reversal — which
argues the "stop losing users" rationale below was right about priority, even
where the specific solution changed.*

### Phase 3 — Absorb the competitors' lyric strengths 🔶 mostly shipped

- ✅ **NetEase as a second synced source — shipped**, plus **Kugou** (not
  originally planned, added alongside it — same keyless deal), both
  confirmed live.
- 🔶 **Genius as a second PLAIN source — built, not actually reachable.**
  genius.rs implements the same keyless HTML-scrape technique
  Sonar/lyricsgenius are documented as using, but a live check
  (2026-08-17) found genius.com's search endpoint behind a Cloudflare JS
  challenge on every request — a real anti-bot wall, not a fixable bug.
  Left in the fallback chain since it fails harmlessly closed; see
  genius.rs's module doc for the finding.
- ✅ **LLM correction of transcriptions — shipped (correct.rs).** Feeds
  Whisper's raw transcript plus the track's title/artist to whichever
  provider is configured and asks it to fix mishearings — exactly LyricWhiz's
  ear/brain split. Guarded to only run when nothing anchored real lyrics onto
  the transcription (a real source correcting itself could only make it
  wrong), and rejects a whole batch on a line-count mismatch rather than
  risk desyncing the rest of the song. Existed in the old Electron app
  (`src/main/correct.js`) and was never carried over in the Tauri
  migration — this was a migration gap as much as a new feature.
- ✅ **Real word-level timing — shipped, and now actually verified.** Lands
  for a lyric line only when a Whisper transcription anchors it directly and
  the real line's word count matches the transcribed one exactly; every other
  line keeps the syllable-weighted interpolation as the honest fallback. See
  align.rs / whisper.js.

  The "needs one real run to confirm it" note that sat here was right, and the
  run found a real bug. Word timing is computed from the decoder's
  cross-attention weights, and `onnx-community/whisper-base` — the model this
  pointed at — has no ONNX export that emits them. transformers.js does not
  degrade in that case, it throws, and `transcribe` had no catch. So the
  failure was not "word timing falls back to interpolation"; it was **every
  transcription failing outright**. Fixed two ways: the model id now names the
  `_timestamped` export (same weights, re-exported with `output_attentions`),
  and the call falls back to segment timestamps instead of propagating. Both
  measured against 8 s of synthesised speech — the old id threw, the new one
  returned 11 word-level chunks, and the text was identical at segment level.

### Phase 4 — Deepen our own signature look

This is the differentiator, so it deserves real investment once Phase 1 stops
the leak.

- ❌ **More GPU layers — investigated, not doing it.** Galaxy is already on
  the GPU (instanced quads inside the swirl shader, since 0.23.0) with a CPU
  `drawGalaxy` fallback only for when that path is unavailable — this line
  was stale about galaxy specifically. That leaves parametric curves
  (drawMathCurves) and the constellation web (drawConstellation), and
  swirl.js's own header comment argues AGAINST moving them: "the 2D-canvas
  layers... are great at *discrete* things (stars, confetti, ripples,
  parametric curves)... the GPU owns the soft, continuous 'liquid' look."
  That's a real design rationale, not an oversight — the GPU wins on this
  app so far have all been either full-screen per-pixel field work (the
  swirl) or large instanced particle counts (260-star galaxy); a ~100-point
  line strip and a ~28-node link graph are a different shape of cheap.
  Checked live: both already carry adaptive-quality throttling (coarser
  sampling / fewer nodes under load, same as everything else), and
  constellation was already specifically optimised once (378 individual
  strokes batched down to 8 via Path2D bucketing). Extended the perf
  guardrail to track both anyway (`mathCurves`/`constellation` budgets) so
  if either genuinely becomes a hot path later, there's already a number to
  point at instead of another investigation from scratch.
- ✅ **Visual presets — shipped**, since 0.10.0: a named set the user can
  cycle, not a random shuffle. Each song remembers its own look.
- ✅ **Per-mood visual profiles — shipped.** Correcting the framing first:
  mood.js already drove more than palette (motion/turbulence/flicker/warmth
  since an earlier session) — what was actually untouched by mood was WHICH
  PRESET a song gets, chosen by `presets.js`'s `forTrack()` via a pure hash
  of the track identity, mood-blind. Extended `forTrack(trackKey, moodKey)`
  to bias that hash toward a curated subset per mood character (energetic →
  concert/starfield/stage/geometry; dark → wormhole/geometry/concert; calm →
  liquid/heatmap/vinyl; bright → vinyl/liquid/starfield) while keeping the
  determinism the existing design explicitly relies on — same (track, mood)
  always resolves to the same look, no persisted state to grow stale. Falls
  through to the exact old unbiased behaviour for `neutral` or an unknown
  mood, which covers the common case of mood not having resolved yet
  (asynchronous, after lyrics) and the case of no LLM key configured at all
  — nobody's existing experience changes unless mood data actually exists.
  Re-applied once mood actually arrives (`onMood`, guarded to the current
  track); the per-frame preset reconciliation already crossfades a changed
  `presetId` smoothly (it's the same path the FPS governor's cost-based
  substitution uses), so this needed no new transition logic. 4 new tests in
  `test/presets.test.js` (determinism, subset containment, the
  no-mood-data-changes-nothing guarantee, divergence across moods).
- ✅ **Artist sprite coverage — ongoing, purely additive.** Registry has grown
  well past the original set (Seedhe Maut, DIVINE, KR$NA, Prabh Deep, Raftaar,
  MC STΔN, Emiway Bantai, Naezy, Brodha V as of this writing) and reliable
  since artist names are cleaned at the SMTC boundary. More artists is always
  a safe, low-risk addition here.

### Phase 5 — Reach

- ~~**Fix the audio-permission friction.**~~ **Dropped, 0.21.0.** There is no
  prompt to remove — see gap 3 above, which was measured rather than reasoned
  about. A WASAPI addon would have replaced a working path with a native one to
  solve a problem that stopped existing when the display-media handler was
  added.
- ✅ **Vocal isolation (Demucs) before transcription — shipped**, as an
  optional toggle (skipped outright in Lite mode) rather than gated behind
  the "optional pack" machinery this item originally assumed — that
  machinery turned out unnecessary once the Tauri migration solved installer
  size a different way (see gap #2, Phase 2).
- ✅ **Crash/error reporting — both halves shipped.** Local: an always-on
  crash/error log (crashlog.rs) — Rust panics and renderer JS errors land in
  one file, openable from the 🔑 panel, meant to be attached to a bug report
  by hand. Remote: opt-in, off by default ("Send crash reports automatically"
  in the same panel) — when on, each entry is ALSO best-effort POSTed to the
  maintainer's own Cloudflare Worker (web/worker/src/worker.js's new
  `/api/crash-report`/`/api/crash-reports` endpoints, KV-backed, admin-token-
  gated for reading them back), not a third-party telemetry service. Payload
  is deliberately minimal — kind, message, app version, OS — no track,
  artist, title, or lyric text ever leaves the machine through this path.
  Requires the maintainer to run the one-time KV/secret setup documented in
  that file; without it the endpoint 503s and the app silently keeps working
  exactly as if reporting were off.
- **Microsoft Store listing isn't actually live yet.** The MSIX build +
  Partner Center submission pipeline is automated (`ci/msix-auto-submit`,
  `.github/workflows/store.yml`), but its `publish` job needs five repo
  secrets (`AZURE_AD_TENANT_ID` etc.) that aren't configured, so it silently
  no-ops on every run — and even with them, the very first submission has to
  be done by hand (the Store API can only update an app that's already live,
  see docs/MICROSOFT-STORE.md). So "Microsoft Store — Coming soon" on the
  website is accurate, not stale copy — worth flagging since it's easy to
  assume automation this thorough means it's already done.

---

## 5. Sequencing

| # | Item | Impact | Effort | Status |
|---|---|---|---|---|
| 1 | Butterchurn as a second engine (preset ecosystem) | Very high | Medium | ✅ Shipped |
| 2 | Preset system + beat-synced transitions | Very high | Medium | ✅ Shipped |
| 3 | Compact display modes | Very high | Medium | 🔁 Reversed (0.28.0, fullscreen-only) |
| 4 | Optional transcription pack (124 -> ~60 MB) | High | Medium | ✅ Solved differently (Tauri, ~6MB) |
| 5 | Auto-update | High | Low | ✅ Shipped |
| 6 | Deeper audio analysis | High | Medium | ✅ Shipped (native symphonia DSP) |
| 7 | NetEase + Genius lyric sources | High | Medium | 🔶 NetEase + Kugou work; Genius Cloudflare-blocked |
| 8 | LLM transcript correction | High | Low-Medium | ✅ Shipped |
| 9 | First-run card | Medium | Low | ✅ Shipped |
| 10 | Wallpaper / screensaver mode | High | Medium-High | ✅ Shipped (0.30.0) |
| 11 | More 2D layers moved onto the GPU | Medium | Medium | ❌ Investigated — not doing it (see Phase 4) |
| ~~12~~ | ~~WASAPI native loopback~~ — no prompt exists; measured in 0.21.0 | — | — | Dropped |
| 13 | Vocal isolation (Demucs) | High (quality) | Very high | ✅ Shipped, as an opt-in toggle |
| 14 | Real word-level timing | High | Medium | ✅ Shipped — and the verification run found it had never worked; fixed |
| 15 | Crash/error reporting (local capture) | Medium | Low | ✅ Shipped, local-only |
| 16 | Crash/error reporting (remote, opt-in) | Medium | Medium | ✅ Shipped — self-hosted Worker, opt-in |
| 17 | Per-mood visual profile bias in preset selection | Medium | Low | ✅ Shipped |

Everything queueable from this list is now shipped, explicitly decided
against, or (item 7's Genius half) confirmed built-but-blocked by a third
party's anti-bot wall this project won't engineer around. Item 16's
decision — remote crash reporting went to the maintainer's own Cloudflare
Worker, opt-in, off by default, not a third-party service — is also
resolved.

---

## 6. Explicitly not doing

- **Chasing catalogue.** Musixmatch and Spotify win; more free sources is the
  answer, not a licensing deal.
- **Rewriting in C++/Rust.** The bottleneck is GPU/Skia. That left exactly two
  places native code earned its keep, and one of them turned out not to be a
  problem at all: WASAPI loopback was dropped in 0.21.0 after measurement, so
  ML inference is the only one left.
- **macOS/Linux ports.** SMTC is the entire detection layer. Revisit only if the
  Windows app has an audience worth extending.
- **Uncapping the frame rate.** The cap is vsync, not our code.
- **The iOS port.** Dead on Apple signing; see NEXT_STEPS.md.

---

## 7. The one-line pitch to aim at

> A music visualiser for Windows that reacts to whatever you're playing — with
> synced lyrics, in any language, even for songs that don't have any.

If a change does not make that sentence more true, it is not on this roadmap.
