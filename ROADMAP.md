# Roadmap — becoming the best-in-class lyric visualiser

Strategy document, written after a competitive review in August 2026. This is a
plan to argue with, not a backlog to grind. Nothing here is built yet.

---

## 1. The positioning decision

**Do not compete as "a lyrics overlay."** That fight is lost on arrival:
[Sonar](https://github.com/EchoVial/Sonar) already chains three lyric sources
with word-by-word rendering, [Lyrictified](https://github.com/ios7jbpro/lyrictified)
does the same SMTC + LRCLIB job in a fraction of the download, and Musixmatch
and Spotify have catalogues nobody can match. On lyrics alone this app is
behind, and it asks for 124 MB to be behind.

**Compete as a music visualiser that happens to know the words.** Nothing in
the competitive set has a GPU-reactive visual system — they are text renderers:
a bar, a taskbar strip, a floating line. This app has a WebGL domain-warp field
that reacts to real audio, drops, build-ups and lyric density at 72–85 fps.
That is the product. The lyrics are a feature of it.

Everything below is ordered by that decision. Work that strengthens the
visualiser or removes a reason to bounce off it ranks above work that closes a
lyrics-feature gap.

---

## 2. What to take from each competitor

Competitors are free R&D. Each has solved something worth copying outright.

| Source | Their strength | What we take |
|---|---|---|
| **Sonar** | LRCLIB → NetEase → Genius chain, keyless | The multi-source chain. Their choice of sources is proven and needs no API keys. |
| **Sonar** | Word-by-word reveal | The polish bar. Ours is interpolated from line timing; theirs reads as tighter. |
| **Sonar / Lyrictified** | Taskbar strip / compact floating / click-through modes | **The most important steal.** A fullscreen overlay is a commitment; a taskbar strip is something you leave on all day. |
| **Lyrictified** | Album artwork in the bar | Already have the artwork pipeline — reuse it in compact modes. |
| **python-lyrics-transcriber** | Anchor-sequence alignment + **LLM auto-correction** of the transcript | The LLM correction pass. We already have Gemini/Groq/HF/Claude wired up. |
| **LyricWhiz** (paper) | Whisper as the "ear", an LLM as the "brain" | Validates the above as state of the art, not a hack. |
| **Musixmatch / Spotify** | Catalogue | Nothing — cannot be matched. Do not try. |

---

## 3. Gap analysis

Honest list of what is actually weak, worst first.

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

Four phases. Each is independently shippable — no phase is a prerequisite for
the app staying useful.

### Phase 1 — Stop losing users (highest impact)

The app's problem is not capability, it is that people bounce before seeing the
good part.

- **Compact display modes.** Three: fullscreen (today), a compact floating bar,
  and a click-through taskbar strip. Cycle with a hotkey and a chip; persist the
  choice. The visualiser stays in fullscreen mode; compact modes show line +
  artwork + a thin reactive accent.
- **Split transcription into an optional feature pack.** Ship a ~60 MB core
  installer; download the ONNX runtime and model on first use of transcription,
  into `userData`. Kills the size objection for everyone who never uses it.
- **First-run overlay.** One dismissible card naming the chips and the two
  hotkeys. Costs an hour, removes the "what is this" bounce.
- **Auto-update** via `electron-updater` against GitHub Releases. Necessary
  before any real distribution, and cheap while the audience is small.

*Rationale: none of this is glamorous, and all of it converts more installs into
daily users than any feature below.*

### Phase 2 — Absorb the competitors' lyric strengths

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

### Phase 3 — Make the visualiser undeniable

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

### Phase 4 — Reach

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
| 1 | Compact display modes | Very high | Medium |
| 2 | Optional transcription pack (installer 124 → ~60 MB) | High | Medium |
| 3 | Auto-update | High | Low |
| 4 | First-run card | Medium | Low |
| 5 | NetEase + Genius sources | High | Medium |
| 6 | LLM transcript correction | High | Low–Medium |
| 7 | Visual presets | Medium | Low |
| 8 | More layers on GPU | Medium | Medium |
| 9 | WASAPI native loopback | Medium | High |
| 10 | Vocal isolation | High (quality) | Very high |

Items 3, 4, 6 and 7 are small and high-leverage — do them opportunistically
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
