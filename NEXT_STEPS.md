# Next steps

Working notes for where this project goes after **v0.8.1**. Written to be picked
up cold — every item says *why* it matters and *where* the code lives, not just
what to do.

---

## 0. Do this first — rotate the HuggingFace key

Installers up to and including v0.8.0 embedded `src/main/secrets.js` verbatim,
and because the build sets `asar: false` the token was readable in a text
editor. Those assets have been deleted from the GitHub releases, and v0.8.1 no
longer bundles any key.

**Deleting the assets does not undo exposure that already happened.** The
v0.6.0/v0.7.0 installers were publicly downloadable, and release assets get
scraped and mirrored. Treat the old token as compromised:

1. Revoke it at <https://huggingface.co/settings/tokens>.
2. Create a new one.
3. Paste it into the app's 🔑 panel (it persists to `userData/settings.json`).

Your local `src/main/secrets.js` is untouched and still gitignored, so the dev
setup keeps working either way.

---

## 1. Honest gaps in what just shipped

Things that are done *enough to use* but not done *well*. Worth knowing before
building on top of them.

### Transcription only works from live loopback

The plan was local files first, loopback second. Only loopback shipped.

That means transcription needs the ♫ chip on, costs a full play before it
learns anything, and inherits whatever the speaker mix sounds like. A local
file would transcribe in one pass, offline, with cleaner audio and no waiting.

The hard part is not decoding — `src/renderer/capture.js` already proves the
renderer can hand main clean 16 kHz mono PCM, and Chromium's `decodeAudioData`
handles mp3/flac/m4a for free. The hard part is **knowing which file is
playing**: SMTC reports title/artist, not a path. Realistic options:

- Let the user point at a music folder and match on tags/filename.
- Accept drag-and-drop of a file onto the overlay for a one-off transcription.

Start at `src/renderer/capture.js` and the `transcribe-audio` IPC handler in
`src/main/main.js`; the main-process side needs no changes at all.

### Language detection is a heuristic, and it can be wrong

Whisper does not auto-detect language here — omitting `language` silently
decodes as English. The workaround (see the auto-language block in the
`transcribe-audio` handler) transcribes as English, runs `detectIndic()` on the
result, and redoes the pass as Hindi if the output looks Indic. It leans on the
fact that Whisper forced to English writes phonetic Hindi full of the exact
function words that detector already knows.

It works, but it is inference, not detection. It will miss Punjabi-heavy tracks
that romanize differently, and it costs a second full pass when it fires.

There is a `whisperLanguage` setting already plumbed through
`get/set-transcribe-config` — **it has no UI**. Wiring a small chip to it is
maybe an hour and gives a manual override for the cases the heuristic misses.

### Whisper accuracy on music is the real ceiling

Whisper is a speech model. Measured behaviour on sung vocals over a dense mix is
well below its speech accuracy, and it is weakest on exactly this library: fast
rap and heavy EDM. `chunksToCues()` filters the worst artefacts (`[Music]`,
`♪♪`, the "thanks for watching" family, and the phrase loops it falls into over
instrumentals) but it cannot fix mishearing.

**The single biggest quality win available is vocal isolation** — running
Demucs (or similar) to extract the vocal stem before transcribing. Separating
vocals from the backing track lifts ASR accuracy on music substantially. It is
also a second large model and a real project: another few hundred MB, another
inference pass, and a meaningful jump in installer size. Worth scoping
deliberately rather than bolting on.

### Model speed, measured

CPU, q8 quantisation, 11-second clip:

| model | time | ratio | notes |
|---|---|---|---|
| `Xenova/whisper-tiny.en` | 8.0 s | 0.73× realtime | English only |
| `Xenova/whisper-base` | 11.9 s | 1.08× realtime | **current default** |
| `Xenova/whisper-small` | 37.5 s | 3.40× realtime | best accuracy, ~12 min/song |

`small` is selectable via the `whisperModel` setting and is genuinely more
accurate on Hindi/Punjabi — it is just a background-job-only proposition. If GPU
execution ever gets wired up (onnxruntime-node ships DirectML on Windows, and
the DLL is already in the build), `small` becomes viable and this whole table
shifts. That is probably the highest-leverage performance experiment left.

### ScriptProcessorNode is deprecated

`src/renderer/capture.js` uses `ScriptProcessorNode` deliberately: an
`AudioWorklet` must load its module over the page origin, which is fragile under
this app's `file://` + strict-CSP setup. It works and the deprecation warning is
expected, but if Chromium ever removes it, capture breaks. The fix is a worklet
plus a CSP/loading strategy that tolerates `file://`.

---

## 2. Not started

### Emoji and expression reactions

The last item from the original feature list, untouched. The idea: react to
lyric sentiment and musical moments with emoji/expression overlays, and give the
pixel dancers facial expressions that track the mood.

Useful groundwork already exists:

- `src/main/sentiment.js` produces a mood per track.
- `src/renderer/sprites.js` draws the dancers and already caches per-look body
  canvases, so an expression layer is an extra cached sprite, not a redraw.
- The beat/drop engine in `renderer.js` gives natural trigger points.

Note that the lyric font (Bebas Neue) has no emoji glyphs — emoji in lyric text
already fall back to Segoe UI Emoji via the font stack, but anything drawn on
the canvas needs its own handling.

### Artist sprite coverage

`splitArtists`/`actorsFor` in `sprites.js` generate a procedural dancer for
unknown artists and use branded looks for known ones. The branded registry is
small. Expanding it is low-risk, purely additive work — and now that artist
names are cleaned at the SMTC boundary (`cleanArtist`), registry lookups
actually receive tidy names, so entries added now will match reliably.

---

## 3. Deliberately not doing

Recorded so these do not get re-proposed.

- **Rewriting the renderer in C++/Rust.** The bottleneck is GPU/Skia, not JS.
  The real win was moving the backdrop to a WebGL2 shader (`src/renderer/swirl.js`),
  which is done.
- **Uncapping the frame rate.** The app is not capped at 60 by its own code —
  the throttle in `drawBackdrop` disengages once FPS is healthy. The cap is
  vsync, i.e. your monitor. `--disable-gpu-vsync` on a transparent always-on-top
  overlay buys tearing and heat, not smoothness.
- **The iOS/React Native port.** Abandoned on Apple's signing rules: a free
  Apple ID has no Apple "team", so EAS ad-hoc builds fail, and the free path
  needs Xcode on a Mac. Code is parked on branch
  `claude/lyric-viewer-ios-crossplatform-7fmjh1` and in `packages/`. Do not
  revive without a paid Apple Developer account or Mac access.

---

## 4. Housekeeping

- **`README.md` "Not built yet" is stale.** It still lists WASAPI loopback
  capture and "ASR fallback for tracks with no LRCLIB entry" as unbuilt. Both
  shipped — `src/renderer/audio.js` and the Whisper pipeline respectively.
- **`v0.8.0` tag has no release.** It was tagged before the key was stripped
  from the build; v0.8.1 is the first clean release. Harmless, but delete the
  tag if you want the history tidy.
- **Merged branches still exist on origin**
  (`feature/reactive-perf-and-sync-suite`, `fix/no-shipped-api-key`). Safe to
  delete now that both PRs are merged.
- **Old installers in `dist-installer/`** still contain the embedded key. They
  are gitignored, so this only matters if you share the files directly.

---

## Suggested order

1. **Rotate the key** — minutes, and the only item with a live risk attached.
2. **Language override chip** — ~1 hour, removes the worst failure mode of the
   transcription heuristic.
3. **Emoji/expressions** — the fun one, and the last unbuilt item from the
   original list.
4. **Local-file transcription** — turns transcription from "wait a full play"
   into "instant and offline".
5. **DirectML/GPU inference** — the experiment that could make `small` the
   default and lift transcription quality for free.
6. **Vocal isolation** — the biggest quality win, and the biggest project.
