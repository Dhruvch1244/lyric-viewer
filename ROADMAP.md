# Roadmap — the best music visualiser that also knows the words

Strategy document, written after a competitive review in August 2026. This is a
plan to argue with, not a backlog to grind. Nothing here is built yet.

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
0d. **No wallpaper or screensaver mode.** Wallpaper Engine's whole proposition
   is that it is always there. Ours must be launched and takes over the screen.

### Blocking adoption

1. **One display mode, and it is fullscreen.** The app takes over the screen or
   it does nothing. Every competitor offers a small, always-on mode. This is the
   single biggest reason someone tries it once and stops.
2. **124 MB installer.** Competitors are a few MB. About 60 MB of ours is the
   ONNX runtime, needed only by transcription — a feature most users will never
   trigger.
3. **Audio reactivity needs a screen-capture permission prompt.** The loopback
   path goes through `getDisplayMedia`, so the user sees a scary share dialog to
   enable what is arguably the app's best feature. Many will decline.
4. **No first-run experience.** New users get a transparent overlay and a row of
   single-glyph chips with no explanation of what `अ`, `◐`, `♫` or `⚡` do.
5. **No auto-update.** Every fix requires a manual re-download. At scale this
   means most users stay on whatever version they first installed.

### Quality gaps

6. **Lyric coverage is one and a half sources** (LRCLIB synced, LRCLIB plain).
   Sonar has three.
7. **Word timing is interpolated**, not real. Fine most of the time, visibly
   wrong on lines with long held notes or rapid-fire delivery.
8. **Transcription accuracy on dense music.** Whisper is a speech model; the
   vocal gate helps with hallucinations over gaps but not with mishearing.
9. **Transcription costs ~12 min of CPU per song** and is CPU-only — DirectML
   fails to allocate on this hardware.

### Structural

10. **Windows-only.** Correct for now; SMTC is the whole detection layer.
11. **Single maintainer, no crash reporting.** No idea what breaks in the wild.

---

## 4. The plan

Five phases. Each is independently shippable — no phase is a prerequisite for
the app staying useful.

### Phase 1 — Win the visualiser half

The visual-variety gap is the one thing that cannot be closed incrementally,
and it is the axis the whole category is judged on.

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

- **Compact display modes.** Three: fullscreen (today), a compact floating bar,
  and a click-through taskbar strip. Cycle with a hotkey and a chip; persist the
  choice. The visualiser stays in fullscreen mode; compact modes show line +
  artwork + a thin reactive accent.
- **Wallpaper / screensaver mode.** Render to the desktop background rather than
  an overlay. This is Wallpaper Engine's entire proposition and it turns the app
  from something you launch into something that is simply on.
- **Split transcription into an optional feature pack.** Ship a ~60 MB core
  installer; download the ONNX runtime and model on first use of transcription,
  into `userData`. Kills the size objection for everyone who never uses it.
- **First-run overlay.** One dismissible card naming the chips and the two
  hotkeys. Costs an hour, removes the "what is this" bounce.
- **Auto-update** via `electron-updater` against GitHub Releases. Necessary
  before any real distribution, and cheap while the audience is small.

*Rationale: none of this is glamorous, and all of it converts more installs into
daily users than any feature below.*

### Phase 3 — Absorb the competitors' lyric strengths

- **NetEase as a second synced source**, then **Genius as a second plain
  source.** Sonar proves both work keyless. Ordered chain: LRCLIB synced →
  NetEase synced → LRCLIB plain + align → Genius plain + align → Whisper alone.
  The aligner already exists, so every plain source added multiplies in value.
- **LLM correction of transcriptions.** Reuse the existing provider stack: feed
  Whisper's raw transcript plus the track's title/artist to Gemini/Groq and ask
  it to fix mishearings. This is exactly LyricWhiz's ear/brain split, and the
  plumbing, caching and key panel are already built. Likely the biggest single
  jump in transcription quality available without vocal isolation.
- **Real word-level timing** where a source provides it; keep interpolation as
  the fallback.

### Phase 4 — Deepen our own signature look

This is the differentiator, so it deserves real investment once Phase 1 stops
the leak.

- **More GPU layers.** Several 2D-canvas layers (galaxy, parametric curves,
  constellation) are the remaining per-frame CPU cost. Moving them into the
  existing shader would cut CPU and allow far higher particle counts.
- **Visual presets.** A named set the user can cycle — "liquid", "starfield",
  "minimal", "poster". Currently the look shuffles randomly, which makes it feel
  arbitrary rather than designed.
- **Per-genre visual profiles** driven by the sentiment/mood data already being
  computed but currently used only for palette.
- **Artist sprite coverage.** Purely additive, and now reliable because artist
  names are cleaned at the SMTC boundary.

### Phase 5 — Reach

- **Fix the audio-permission friction.** Investigate a native WASAPI loopback
  addon to replace `getDisplayMedia`, removing the share prompt entirely. This
  is the one place a native module genuinely earns its keep.
- **Vocal isolation (Demucs)** before transcription — the real accuracy ceiling.
  Large model, large download; only worth it as an optional pack once Phase 1's
  optional-pack machinery exists.
- **Crash/error reporting**, opt-in.

---

## 5. Sequencing

| # | Item | Impact | Effort |
|---|---|---|---|
| 1 | Butterchurn as a second engine (preset ecosystem) | Very high | Medium |
| 2 | Preset system + beat-synced transitions | Very high | Medium |
| 3 | Compact display modes | Very high | Medium |
| 4 | Optional transcription pack (124 -> ~60 MB) | High | Medium |
| 5 | Auto-update | High | Low |
| 6 | Deeper audio analysis | High | Medium |
| 7 | NetEase + Genius lyric sources | High | Medium |
| 8 | LLM transcript correction | High | Low-Medium |
| 9 | First-run card | Medium | Low |
| 10 | Wallpaper / screensaver mode | High | Medium-High |
| 11 | More 2D layers moved onto the GPU | Medium | Medium |
| 12 | WASAPI native loopback (kills the permission prompt) | Medium | High |
| 13 | Vocal isolation (Demucs) | High (quality) | Very high |

Items 5, 8 and 9 are small and high-leverage — do them opportunistically
between the larger pieces.

---

## 6. Explicitly not doing

- **Chasing catalogue.** Musixmatch and Spotify win; more free sources is the
  answer, not a licensing deal.
- **Rewriting in C++/Rust.** The bottleneck is GPU/Skia. Native code earns its
  place in exactly two spots, both named above: WASAPI loopback and ML
  inference.
- **macOS/Linux ports.** SMTC is the entire detection layer. Revisit only if the
  Windows app has an audience worth extending.
- **Uncapping the frame rate.** The cap is vsync, not our code.
- **The iOS port.** Dead on Apple signing; see NEXT_STEPS.md.

---

## 7. The one-line pitch to aim at

> A music visualiser for Windows that reacts to whatever you're playing — with
> synced lyrics, in any language, even for songs that don't have any.

If a change does not make that sentence more true, it is not on this roadmap.
