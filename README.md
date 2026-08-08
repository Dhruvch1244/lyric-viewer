# Lyric Player

A fullscreen synced lyric player for Windows. Detects whatever is playing —
Spotify desktop, YouTube Music in a browser, anything that registers with
Windows — and shows beat-aware lyrics fullscreen, so you never look at the
music video or the Spotify UI.

## Status

The core spine works: detection → lyric lookup → synced fullscreen player, with a
Latin/Devanagari script toggle for Hindi tracks. The audio-reactive visual system
(drop detection, dancing characters, genre themes) is not built yet.

## How it works

```
SMTC (Windows)  ──►  smtc-poll.ps1  ──►  smtc.js  ──►  main.js  ──►  renderer
 any media app        JSON stream        staleness-     lyric        fullscreen
                                         corrected pos   matching     word emphasis
```

- **Detection** uses the Windows System Media Transport Controls (SMTC). One API
  covers every media app and gives title, artist, playback status, and position.
- **Lyrics** come from [LRCLIB](https://lrclib.net) — free, open, no API key.
- **Sync** interpolates locally between SMTC samples, so word emphasis stays fluid.

## Requirements

- Windows 10/11
- Node.js 18+
- **Windows PowerShell 5.1** (`powershell.exe`) must be present. PowerShell 7 (`pwsh`)
  removed the WinRT type projection the SMTC poller depends on, so 7 alone is not enough.
  5.1 ships with Windows by default.

## Run

```sh
npm install
npm start
```

Diagnose detection on its own (prints one SMTC sample as JSON):

```sh
npm run probe
```

## Build a desktop app

```sh
npm run package
```

Produces `dist/LyricPlayer-win32-x64/LyricPlayer.exe`.

> **asar must stay disabled** (`--asar=false` in the package script). The SMTC
> poller is launched as `powershell.exe -File smtc-poll.ps1`, and PowerShell — an
> external process — cannot read a file packed inside `app.asar`. With asar on,
> detection silently fails. `smtc.js` also redirects to `app.asar.unpacked` as a
> defensive fallback if a future build re-enables asar with the `.ps1` unpacked.

## Performance

The backdrop is the main cost, so it's tuned to stay smooth:
- Canvas DPR is capped at 1.25 (a 1:1 canvas on 4K is the biggest lag source).
- Colour glows are **pre-rendered sprites** drawn with `drawImage`, not gradients
  rebuilt every frame.
- The vignette gradient is cached and rebuilt only on resize.
- Star count is bounded; lyric lines don't use `will-change` (fewer GPU layers).

## Controls

| Input | Action |
|---|---|
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Nudge lyric sync 100ms earlier / later |
| `Ctrl+Alt+0` | Reset sync offset |
| `Ctrl+Alt+H` | Show / hide the player |
| Move the mouse | Reveal the bottom control bar (auto-hides after 2.5s) |
| `अ` chip | Toggle Latin / Devanagari script |
| `EN` chip | Toggle English translation line |
| `◐` chip | Cycle backdrop opacity: ghost → tinted → vivid → solid (persisted) |
| `☻` chip | Toggle the pixel-art artist dancers (persisted) |

The window is a **transparent, borderless, fullscreen-sized** surface that floats
over the desktop (always-on-top). Transparency is why it's borderless-fullscreen
rather than true OS fullscreen — transparent + true-fullscreen is unreliable on
Windows.

**Backdrop opacity (`◐` chip).** A fully transparent overlay makes the colour
wash nearly invisible over the desktop, so the backdrop has four levels — *ghost*
(barely there), *tinted*, *vivid* (default), *solid* (opaque). The choice is
saved in `localStorage`. A drop flash punches through at any level, so colour
change always reads.

**Sync offsets are saved per track.** SMTC's reported position drifts from actual
audio by roughly 100–500ms depending on the source app and audio stack. The same
track tends to need the same correction, so once you dial it in, it sticks — stored
in `settings.json` under Electron's `userData` directory.

Timestamp accuracy is also improved at the source: the poller reports how *old* each
position reading is (`stalenessMs`), and the main process projects forward from that
rather than trusting a value that may be seconds stale.

## Hindi / Punjabi

### Devanagari script toggle (`अ` chip)

Most Indian hip-hop on LRCLIB is stored **romanized** — a verified Seedhe Maut
sample came back as `"Itna roliye ab gaane sunke rona bhi ni aata"`. The script
toggle handles this native-first:

1. **Native Devanagari entry** — if LRCLIB has a Devanagari-script version, it's
   used directly. Verified: `नalla Freestyle` (85 lines) and `Mere Gully Mein`
   (86 lines) both have native entries. Instant, offline.
2. **Transliteration fallback** — for tracks with only a romanized entry (e.g.
   Seedhe Maut's `101`), the romanized lyrics are converted to Devanagari on
   demand via the configured LLM. **Transliteration, not translation** — words and
   order preserved exactly, only the script changes.

Devanagari renders with **Nirmala UI**, which ships with Windows.

### English translation line (`EN` chip)

A second, italic line beneath the running lyric shows the **English translation**.
It auto-appears for tracks detected as Hindi or Punjabi (romanized or native
script — see `detectIndic()` in `src/main/lyrics.js`); English songs are correctly
skipped so no API call is wasted. Toggle it on any track with the `EN` chip.

This is **translation** (meaning), distinct from the Devanagari toggle
(transliteration / script).

## LLM provider (for transliteration & translation)

These two features call an LLM. The provider is **pluggable** and chosen by which
credential is present — no code change, no hardcoded keys:

| Env var | Provider | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | Free tier is plenty for this — one call per new song, cached |
| `ANTHROPIC_API_KEY` (or `ant auth login`) | Claude | |
| *(neither set)* | — | Features are simply unavailable; lyrics still work |

Gemini takes precedence when both are set; override with
`LYRIC_OVERLAY_PROVIDER=gemini|claude`. Set the key in your environment before
launching — **never commit a key.** If you have ever pasted a key into a chat or
file, rotate it.

Results are cached per song, so each track costs at most one transliteration and
one translation call for its whole lifetime in the cache.

## Design notes

**Word-level timing is interpolated, not real.** LRCLIB provides line-level
timestamps only. True word-level (A2) timing exists essentially only in Musixmatch's
paid "richsync" data. `buildWordTimings()` in `src/renderer/renderer.js` approximates
it by distributing each line's duration across its words weighted by word length.
It tracks natural delivery closely enough for emphasis, but it is an approximation.

**Titles are noisy and need cleaning on both sides.** Browser sessions report raw
video titles. A verified live sample:

```
"'नalla' Freestyle (Visualizer) | Seedhe Maut x DJ SA"  →  "नalla Freestyle"
```

LRCLIB's own entries are messy too (`"11K - Seedhe Maut"`, `"Hausla - Seedhe Maut"`),
so `scoreCandidate()` compares against both the track name and a combined
track+artist string, then ranks by duration proximity.

**Use LRCLIB's free-text `q=` endpoint.** The structured `track_name`/`artist_name`
endpoint was measured returning zero results for tracks that free-text search
matched successfully.

**Lyrics are never generated.** If no synced match is found, the overlay says so.
Asking an LLM to invent lyrics for an unknown song produces confident, wrong words.
The only legitimate path for uncovered tracks is transcription from actual audio.

## Visual design

- **Apple Music-style scrolling column.** All lines live in a column that slides
  up so the active line stays near center. Lines **fade with distance** (opacity
  falls off ~3 lines out) so they never hard-cut at the screen edge — the earlier
  single-line crossfade looked like it was being clipped.
- **Adaptive scroll timing.** The push-up duration adapts to lyric speed: fast
  lines scroll up quickly (~150ms), slow lines glide (~460ms). Derived from the
  gap to the next cue.
- **Word focus.** The word being sung is coloured with the track accent, scaled
  up, and capitalized (Latin only). Word spacing uses `margin`, not text-node
  spaces, so scaling/uppercasing never jitters the line.
- **Auto font size on intense moments.** The active line scales up (~1.35× →
  ~2.2×) based on **lyric cadence** — words per second. Fast, dense bars
  ("top barks") auto-enlarge; sparse lines shrink.
- **Confined view.** Only ~3 lines show: the active line (bright, centered), one
  clear line above and below, and a faint hint at ±2. Everything else is hidden.
- **Permanent 80% container.** Lyrics live in the middle 80vw (10vw padding each
  side). Long lines wrap inside that box, and the active-line auto-enlarge is
  capped by line length (short punchy lines hit ~2×, long lines stay ~1.3×) so a
  big lyric never spills off screen.
- **Gradient word highlight.** The word being sung is filled with a white→accent
  vertical gradient (via background-clip text) with drop-shadow glow.
- **Sentiment-driven graphics.** When an LLM key is set, the song's lyrics are
  analyzed for **mood** (e.g. melancholic, euphoric, aggressive) which sets the
  hue, saturation, and a baseline **energy** — high-energy songs keep the glows
  and stars moving faster and brighter, mellow songs slow everything down. The
  mood word shows top-right. Falls back to a per-track hash palette with no key.
  Verified: melancholic → blue, calm energy → slower motion.
- **Starfield, always moving.** Twinkling drifting stars + occasional shooting
  stars over the tinted base. The colour glows drift *and* orbit continuously, so
  the scene is never frozen even within one song.
- **Build-up & drop "moments."** A lyric arriving after a long instrumental gap
  (> 5s of silence) is treated as a **drop**: the screen floods with the accent
  colour, a white core spikes at the peak, a shockwave ring expands, the hue
  rotates, and the stage physically shakes. In the final ~3.5s before that lyric
  lands, a **build-up** ramps — an accent bloom swells at centre and the glows
  speed up. This is inferred from lyric timing (no audio capture yet), so it fires
  on the *lyrical* drops that LRCLIB's line timing exposes.
- **Varied text moments.** Each active line picks a different per-word entrance —
  *wave* (cascade up), *pop* (scale-in), *blur* (defocus-in), or *glitch* (skew
  flicker) — cycling so it never feels repetitive; energetic bars bias to the
  punchier styles. Words stagger in with a 45ms step.
- **Pixel-art artist dancers (`☻` chip).** The reported artist is matched against
  a small registry (e.g. **Seedhe Maut** → a two-dancer duo, one warm/gold, one
  cool/teal); anyone unmatched gets a deterministic procedural dancer seeded from
  their name. The chibi characters bob, sway, fist-pump, spin, and **jump on the
  drop**, drawn as pixel art on the backdrop canvas. See `src/renderer/sprites.js`
  — the registry is one array; add a `{ match, label, members }` entry to brand a
  new artist.
- **Never goes static.** `backgroundThrottling: false` on the window keeps the
  render loop at full speed even when the overlay isn't the focused window (e.g.
  while Spotify is in front) — Chromium otherwise throttles background windows to
  near-zero FPS. Both render loops are also wrapped so an error can't freeze them.

## Reactive visuals — today vs. later

The backdrop and font react to the **input we currently have**: per-track colour
palette, per-line pulse, and cadence-driven intensity. This tracks dense rap
delivery well.

It does **not** yet react to the audio itself — an instrumental **EDM drop** has
no lyrics for the cadence heuristic to read, so it can't drive the visuals there.
Real drop/beat detection needs the audio-capture layer (below). When that lands,
the same intensity signal gets a true audio source and the auto-font + starfield
react to actual drops and beats.

## Not built yet

- **Audio capture (WASAPI loopback) + FFT** — prerequisite for true audio-reactive
  visuals. Build-up/drop moments and the dancing characters already exist but are
  driven by *lyric timing*, not audio; this layer would let them react to actual
  instrumental drops and beats (e.g. EDM tracks with no lyrics for the heuristic).
- Genre-aware theming (EDM vs hip-hop) driven by actual audio, not just palette
- Persistent listening library and song history
- ASR fallback for tracks with no LRCLIB entry
