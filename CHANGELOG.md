# Changelog

All notable changes to Lyric Overlay. Versions follow [semantic versioning](https://semver.org/).

## 0.11.0 — 2026-08-10

### Added

- **Ghost preset — lyrics and the cloud, nothing else.** A lyrics-only look:
  the GPU cloud field plus the scrolling lyric and title flow, with every
  visualizer gone. Pick it from the preset chip.

  Turning off the layer flags was not enough on its own. The 2D canvas carries
  always-on work no flag covers — stars, colour glows, the vignette, ripples,
  confetti, shooting stars, the dancers — and even with all of it skipped it is
  still a full-screen compositor layer being cleared and blended every frame.
  Ghost takes the canvas out of the page entirely.

  Measured cost of one backdrop frame at 1920×1080, stable across runs:

  | preset | JavaScript per frame |
  | --- | --- |
  | Concert | 2.8 ms |
  | Liquid | 1.4 – 2.1 ms |
  | **Ghost** | **0.07 – 0.11 ms** |

  Ghost is excluded from the random per-song look, because it is a mode you
  choose rather than one you should be handed.

- **Dynamic cloud resolution.** A four-rung ladder (0.30 / 0.40 / 0.55 / 0.70)
  sheds pixels when frames run long and earns them back when there is headroom.
  Fill cost falls with the square of the scale and the field is soft enough that
  the upscale is invisible, so a heavy moment keeps the full effect at fewer
  pixels instead of having layers switched off.

### Fixed

- **The frame-rate governor could latch, and stay latched.** Frame timing was
  measured between *drawn* frames, so once the throttle engaged the app only
  ever measured its own throttled output: dropping below 30fps set a 32ms
  throttle, which produced ~31fps, which held the average under 45 indefinitely.
  The app could not discover it had headroom again, so it stayed frame-skipped
  with visual quality pinned at its lowest setting long after whatever caused
  the dip had passed.

  Timing is now split in two — the cost of drawing a frame, and the rate frames
  are actually presented at — and neither feeds back into itself, so recovery is
  immediate.

### Notes on performance

Removing ~95% of the CPU rendering work (Ghost) did **not** reliably improve the
presented frame rate in testing: repeated interleaved runs disagreed by more
than the difference between presets. Frame rate here is dominated by something
downstream of the app's drawing — GPU raster and compositing a full-screen
transparent always-on-top window. Total CPU rendering cost is roughly 3ms of a
16.7ms frame budget, so rewriting the drawing in a native language would
optimise something that is already not the constraint.

## 0.10.1 — 2026-08-10

A bug-fix release. The headline fix affects every synced song.

### Fixed

- **Blank lines took over the screen mid-song.** LRC files mark the end of a sung
  line with a timestamped line that has no text:

  ```lrc
  [00:14.15] Yeah
  [00:17.73]                        <- "Yeah" stops here; music until the next line
  [00:27.85] I've been tryna call
  ```

  Those markers were parsed as ordinary cues, so they became *active lyric lines
  with no text*. That blanked the lyric column and simultaneously suppressed the
  song-title hero — which only appears when no line is active — leaving the
  screen showing nothing at all for the length of the gap. All ten LRCLIB entries
  sampled while fixing this carried between one and eight of these markers, so
  every song was affected, several times per song.

  Markers now become an `endMs` on the line they close. The song-title hero takes
  the centre the moment singing stops, instead of a blank.

- **Word highlighting smeared across instrumental gaps.** With no end time, a
  line's words were spread over the whole distance to the next line, so the last
  word of a verse stayed "being sung" for several seconds of instrumental. Word
  timing now uses the real end of the line.

- **False drops fired during ordinary verses.** The instrumental gap that
  triggers a drop was measured from where the previous line *started* rather than
  where it *ended*, counting the line's own length as silence. Long lines could
  trip the 5-second threshold on their own.

- **Line energy was measured against the wrong duration.** A short line followed
  by a long instrumental read as slow and low-energy, damping the visuals right
  where a track usually gets bigger. It is now measured against the sung length.

- **The English translation line could caption the wrong lyric.** Translations
  are looked up by index, and a Devanagari track fetched as its own LRCLIB entry
  can have a different line count from the Latin one. Mismatched lists are now
  hidden rather than shown against the wrong lines.

- **Devanagari mode lost gap handling.** The transliterated cue list dropped the
  timing fields it did not use, so switching script disabled the fixes above.

- **Stale data could land on the wrong track.** Async payloads (lyrics, artwork,
  mood, beat maps) were matched to the current track by title alone, so two
  consecutive tracks sharing a title — covers, remixes, the `Intro` /
  `Interlude` tracks on most rap albums — could cross over. Artist is now
  compared too.

### Notes

- Songs already in the on-disk cache are repaired on read, so an existing library
  is fixed in place with no re-fetch and no loss of cached translation,
  transliteration or mood work.

## 0.10.0

- Named visual presets replace the random layer shuffle; each song remembers its
  own look.
- Frame-rate work: the per-line blur is applied only to visible lines instead of
  every line in the song.

## 0.9.0

- Second lyric source: LRCLIB *plain* (unsynced) lyrics force-aligned to Whisper
  timings, giving correct words on songs that have no synced entry.
- Transcription quality: better model, vocal gating, no phrase loops.

## 0.8.x

- GPU swirl backdrop (WebGL2), artist pixel-sprite dancers, on-disk lyric cache.

## 0.7.0 and earlier

- Initial releases: SMTC media detection, LRCLIB synced lyrics, the scrolling
  lyric column, beat-aware visuals, Devanagari transliteration and English
  translation.
