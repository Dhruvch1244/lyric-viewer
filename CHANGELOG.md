# Changelog

All notable changes to Lyric Overlay. Versions follow [semantic versioning](https://semver.org/).

## 0.17.0 — 2026-08-11

### Added

- **Wormhole — a tunnel flying toward you.** Rings travel out of a vanishing
  point behind the lyric, each rotated a little further than the last so the
  whole thing twists as it comes. The perspective is what sells it: radius goes
  as z², so rings bunch at the throat and accelerate toward the edge — spaced
  linearly they read as circles getting bigger, not as travel.

  It is the look where **anticipation** is the headline. The tunnel constricts
  and winds up in the seconds *before* a drop the stored heat map already knows
  about, so the acceleration leads the music instead of reacting to it. A drop
  then punches it forward.

  Cheap: 0.56 ms of CPU per second, less than the bokeh layer it sits with.

- **The Vinyl platter is half again as large**, and the label is a bigger share
  of it — a 288px disc with a 109px label becomes a 374px disc with a 157px
  label at 1280×720. The cover art is the entire point of that mode and it was
  rendering as a coaster in a lot of black.

  A long lyric line can now cross the platter's top-right corner. That is
  accepted rather than designed around: the artwork matters more, and the lyric
  carries its own shadow. The comment claiming the deck "never sits behind the
  lyric" was already optimistic and has been corrected.

### Performance

- **The galaxy was the most expensive thing in the app, and it was invisible.**
  0.16.0's audit measured Concert at 300 `fill` + 300 `arc` per frame and left
  it alone. That measurement understated it badly: the dominant cost was not a
  canvas call at all. `drawGalaxy` called `shiftHex` **once per particle per
  frame** — a full RGB→HSL→hex round trip ending in a string build — plus a
  `hexA` each. At 260 particles that is roughly 31,000 string-building colour
  operations a second, in a layer three presets use.

  Measured with the DevTools profiler, self time per function:

  | | before | after |
  | --- | --- | --- |
  | `drawGalaxy` | 17.62 ms/s | **2.44 ms/s** |
  | `drawConstellation` | 2.94 ms/s | **0.85 ms/s** |
  | `hexA` | 1.63 ms/s | *off the profile* |

  About 17 ms of CPU returned per second of playback in Concert. The hue is
  bucketed into 12 steps across the 90° the particles span, alpha rides
  `globalAlpha` instead of a fresh colour string, and the dots use `fillRect` —
  the trade this file already documents for the stars layer.

  The constellation's links were one string build and one `stroke` each, up to
  378 of them; they are now batched into 8 opacity buckets and stroked 8 times.

  Dots are sized by **equal area**, not equal width: a square of side 2r covers
  27% more than the circle it replaces, and at first pass the galaxy visibly
  read heavier than it used to.

## 0.16.0 — 2026-08-10

### Performance

- **0.15.0's new modes cost about what Liquid does again.** They shipped
  against this codebase's own idiom — it already caches the vignette on resize
  and pre-renders glow sprites by colour — and the new draw paths did neither.
  Measured by call count rather than frame rate, because repeated identical runs
  vary 3–4× in fps here and cannot rank two presets:

  | preset | fillRect | arc | stroke | gradients |
  | --- | --- | --- | --- | --- |
  | Heatmap | 164 → **72** | 16 | 6 | 0.2 |
  | Vinyl | 166 → **72** | 31 → **21** | 18 → **10** | 1 → **0** |
  | Stage | 72 | 17 | 6 | 4 → **0.1** |

  The timeline and the vinyl platter are pre-rendered bitmaps now; the platter's
  sheen is baked flat and *rotated* at blit time rather than rebuilding a
  gradient every frame. The stage beams and floor keep cached colour stops and
  vary their brightness through `globalAlpha`. `HeatMap.cells()` is memoised
  against the revision counter `sections()` already used — it had been
  allocating 96 objects and an array sixty times a second to return identical
  values.

  The first attempt at this cached nothing: the keys used `accentLive`, which is
  the accent shifted by a hue that drifts every frame. Anything cached by colour
  now keys on a snapped hue.

### Added

- **The app asks about `♫`, once.** Almost everything it learns needs loopback
  capture — the energy arc behind the timelines, the measured tempo the platter
  and the dancers run on, and the anticipation that reads a stored map forwards.
  With capture off none of that happens, and nothing on screen said so, so
  anyone who never found one chip in a row that stays hidden until the cursor
  moves silently got none of it.

  After twenty seconds of playback, a dismissible prompt offers to turn it on.
  Asked once per install and never raised again, whichever way it is answered —
  including when the `♫` chip is found unprompted. It is deliberately not
  enabled by default: starting a recording of system audio without being asked
  is not the app's call to make.

## 0.15.0 — 2026-08-10

### Fixed

- **The heatmap was never saved or written back — so it knew nothing.** 0.14.0
  described a visualiser that learns the shape of a song and is "remembered
  afterwards". It was not. `load()` and `takeForSave()` were written and
  exported, and nothing ever called either one; `heatmap` was missing from the
  cache's persisted fields, and every track change allocated a fresh empty map.

  The mode could therefore only ever show the play you were in the middle of.
  Its entire premise — *play it again and the whole arc is already known* —
  silently did not hold, on any song, ever. The claim in the 0.14.0 notes below
  was wrong; this release makes it true.

- **A song's first listen could not learn anything.** Found while testing the
  fix above, in the fix itself: the main process sends `heatmap: null` when it
  has nothing stored, and treating that as "clear the map" wiped the empty map
  the track had just been given. "Nothing stored yet" and "forget this" are not
  the same instruction, and only the second one clears now.

### Changed

- **Heatmap is an ordinary visual preset again.** It had been built on Ghost's
  `bare` flag — the switch that removes the 2D canvas from the page — and then
  had to undo it mid-frame to draw anything at all. That made it the one preset
  whose flags did not describe what it drew, and it silently cost the mode
  everything the bare branch returns before: the dancers, ripples, drop flash,
  confetti, colour glows and cover art.

  It is now a layer like `aurora` or `galaxy`, so it composes with the rest and
  is available inside other looks. **Ghost is unchanged** and remains the only
  structurally different mode, which is the right shape for it: taking the
  canvas out of the page is the whole point of Ghost.

- **The song is drawn along the bottom edge, not as a ring around the lyrics.**
  A ring puts the loudest moment of a track at whatever angle the clock happens
  to point at, which is a poor way to compare two moments, and it competes with
  the text for the middle of the screen. Left to right is how everyone already
  reads a song. The dancers stand in front of it, so the skyline reads as the
  floor they are on.

### Added

- **Anticipation — the first thing here that knows what has not happened yet.**
  Every other input describes the sample being held. A stored heat map has
  already heard the rest of the song, so a rise can be played *into* rather than
  discovered a frame late: the field tightens, and the troupe gathers to the
  middle of the stage and coils, while the build-up is still climbing.

  Measured end to end on a learned track: standing at 76s, the app reports a
  rise of 0.79 with the peak **4 seconds away** — before it arrives.

  It feeds the existing build-up channel rather than adding a parallel one, so
  the strongest source wins: a remembered map never talks over a real build the
  app can currently hear. Songs that have not been heard get nothing rather than
  a guess.

- **Song structure, named.** The bins are clustered into sections — intro,
  verse, build, drop, break, outro — and the current one is labelled under the
  timeline, with a countdown replacing the label when a drop is within eight
  seconds. Derived from the same bins rather than stored separately, so it costs
  nothing extra to learn and cannot drift out of step with the heatmap. Nothing
  is claimed until half the track has actually been heard: a section list built
  from a quarter of a song is fiction.

- **Vinyl — the cover art as a record on a deck.** It turns the whole time the
  song plays, at a rate the music sets: one revolution every four beats once the
  tempo has locked, which at ordinary tempos lands near a real platter's 33⅓
  rpm. That is the difference between a record and a progress dial — it moves
  because the music does. The tonearm creeps inward as the song plays, and a
  drop nudges the platter forward. Parked to the left, so crisp artwork never
  sits behind the lyric it would compete with.

- **Stage — the dancers as the subject.** A lit floor, three spotlights that
  punch on the kick, and the troupe enlarged and brought down onto the floor
  line. Everywhere else the dancers are decoration at the bottom of a backdrop;
  here they are what you are watching.

- **The dancers are on the beat, not near it.** Every move ran on a private
  free-running oscillator of roughly one cycle a second, so the element people
  watch most closely was the one least connected to the music. All twenty-two
  moves now run on musical time and cycle a whole number of times per beat,
  driven by the same measured beat clock as everything else. The free-running
  clock survives only as the fallback for when no tempo has been measured.

  Each dancer carries a fraction of a beat of personal lateness, so a troupe
  reads as several people feeling one beat rather than one sprite drawn eight
  times.

- **A safeguard against the wrong recording.** A stored map is refused when the
  track length disagrees with what is playing by more than two seconds. Same
  title, same artist, different arrangement is a real case — radio edit, extended
  mix, live cut — and replaying a stored arc over the wrong recording would put
  the drop confidently in the wrong place. The song relearns itself instead.

- **The now-playing corner is one row.** A small animated indicator, then the
  title and artist side by side on the same line, instead of two stacked lines
  with nothing to say whether anything was playing. The bars animate only while
  playback is actually running.

## 0.14.0 — 2026-08-10

### Fixed

- **Songs were re-transcribed on every single replay.** When word alignment came
  out below its coverage floor, nothing was recorded — so the song still had no
  word timings, and the next play recorded the audio again, ran Whisper again,
  and failed again. Minutes of CPU burned on every replay of a song already
  known to be unalignable. Introduced in 0.13.0; the failure is now remembered,
  and since transcription is deterministic a retry could only have reached the
  same answer.

### Added

- **The measured tempo is now visible.** 0.13.0 measured it and never showed it,
  so there was no way to tell whether the beat clock had locked. A `♩` chip
  shows the BPM, and hides itself when nothing is locked rather than leaving a
  stale number on screen.

- **Background work is visible.** Finding lyrics, listening, downloading a speech
  model, transcribing, aligning, translating — all of it reported through one
  status line where each message overwrote the last, so work taking minutes
  looked like nothing happening. Jobs are now tracked separately and shown
  together:

  ```
  ⟳ finding lyrics · transcribing 40% · translating
  ```

- **Bass / mid / air meters at the top edge**, replacing the equalizer bars that
  ran across the backdrop — the same information in a fraction of the screen and
  none of the fill rate. Vertical columns in the display face, tinted from the
  live palette so they recolour with the song. The decibel scale is real
  (20·log10 of the band envelope), floored at −60 dB.

- **Heatmap — a new visualiser that learns the shape of a song.** Energy is
  binned against *position in the track* rather than wall-clock time, so what is
  recorded belongs to the song: play it again and the whole arc is already
  known. Drawn as a ring around the lyrics, cell length carrying energy and
  brightness carrying how far the playhead has reached — so on a replay the drop
  is on screen while the build-up is still playing.

  Each cell holds its *peak*, not an average: a heatmap of averages washes out
  to flat grey, because the interesting thing about a drop is precisely the peak
  that averaging removes. Cells never heard are drawn faintly rather than
  skipped, so a song heard once reads as "not known yet" instead of broken.

  Needs audio capture (`♫`) to learn, and is remembered afterwards.

  > **Correction (0.15.0).** It was not remembered. Nothing saved the map and
  > nothing loaded one, so the mode only ever showed the play in progress and
  > the replay behaviour described above never happened. Fixed in 0.15.0, where
  > the ring also became a bottom timeline.

## 0.13.0 — 2026-08-10

### Added

- **The tempo is measured now, not guessed.** The beat clock derived its period
  from words-per-line ÷ line duration, so it drifted with how wordy a line
  happened to be and every reactive layer pulsed *near* the music rather than on
  it. Now that kick detection works, the onsets carry the tempo: the beat clock
  locks to the measured BPM, runs in real time and phase-aligns to the beat.

  Verified against synthetic trains at 90/120/128/140/174 BPM (exact recovery,
  including with jitter and every 4th kick missing) and on a real house track,
  where it holds 137.6 BPM with independent windows agreeing at 137.6 / 137.0 /
  138.2. It refuses to lock while evidence is thin rather than guessing.

- **Word-level sync: correct words on measured timing.** No lyric source carries
  word timing — a survey of 153 synced LRCLIB entries found zero using the
  enhanced-LRC word extension. Whisper measures *when* each word was sung to
  within tens of ms but mishears the words over music. Aligning the two gives
  correct text on measured timing.

  Songs are aligned once, in the background, and cached — the same
  learn-on-first-listen shape as the beat map, so every later play is
  word-synced instantly and offline. Alignments below 50% coverage are rejected
  as mostly guesswork.

- **Romanized Hindi translates offline, with no API key.** The offline model
  reads Devanagari only, and most of what LRCLIB carries for Indian songs is
  romanized, so the key-free path previously covered native-script songs and
  little else. A rule-based transliterator converts the script first:

  | input | before | after |
  | --- | --- | --- |
  | "Tera naam mere dil mein hai" | "So this is a negative divisible by the negative." | **"Your name is in my heart"** |

  A quality trade rather than a free win — the transliteration is an
  approximation, and a working LLM provider still translates romanized lyrics
  better. This route is taken when the alternative is no translation at all.

### Changed

- Word highlighting uses measured timings when a song has been aligned, and
  falls back to the syllable estimate otherwise.

### Performance

- The lyric column styles only the five lines that can be seen. It previously
  walked every line in the song on each change — on a 90-line track, ~85
  elements written four properties each, to values they already held, with the
  resulting style recalculation landing on the exact frame the lyric advances.

### Fixed

- **The active lyric line could fail to render.** Lines start hidden and only
  the *neighbour* branch cleared that, so a line reached without first being a
  neighbour went active while still hidden — the first line of a song, or any
  line landed on by a seek.

## 0.12.1 — 2026-08-10

### Fixed

- **One dead API key could silently disable every LLM feature.** The provider
  list (Gemini → Groq → HuggingFace → Claude) was treated as a *selection*
  rather than a *chain*: the highest-precedence configured provider was picked,
  and if it failed the request failed with it.

  Found on a real setup where a Gemini key had exhausted its free quota. It
  returned `429` on every call, so translation, transliteration and mood were
  all dead — even though a HuggingFace token was configured and next in line.
  It was never tried. Nothing surfaced the reason; the features simply did
  nothing.

  Every configured provider is now tried in order and the first success wins.
  Failures are logged instead of swallowed, and when all of them fail the error
  names each provider and its reason, so a dead key is diagnosable instead of
  invisible:

  ```
  gemini: 429 You exceeded your current quota
  huggingface: 403 This authentication method does not have sufficient
               permissions to call Inference Providers
  ```

  Note for HuggingFace tokens: calling Inference Providers needs a
  **fine-grained** token with the *"Make calls to Inference Providers"*
  permission. A plain read token returns 403.

## 0.12.0 — 2026-08-10

### Fixed

- **Audio-reactive mode did nothing on loud music — and made things worse.**
  Kick detection used a *ratio* test (`bass > bassEMA * 1.35`). A ratio has no
  headroom once the signal saturates, and modern masters blow straight through
  the analyser's default −100..−30 dB window: measured on a commercial house
  track, the bass bins sat pegged between 0.94 and 1.00 for the entire song, so
  the running floor sat at ~0.96 and the test became *"is 0.98 > 1.30"*.
  Unreachable. The detector was structurally dead on exactly the genres with the
  strongest kicks, and because live audio *suppresses* the synthetic beat clock,
  switching audio-reactive mode on left the visuals less reactive than leaving
  it off.

  Fixed by opening the analyser window to −95..−12 dB, lowering smoothing
  (0.72 → 0.55 — it was blunting the transients being looked for), and testing
  onsets by **difference** rather than ratio, which means the same thing at any
  level. Measured after, counting rising edges on the same track:

  | position | kicks/sec | |
  | --- | --- | --- |
  | t=30s | **2.2** | ~130 BPM four-on-the-floor is ~2.2 Hz |
  | t=50s | 0.8 | breakdown — arrangement thins, as expected |

  Before the fix, the measured kick value was `0.00` for the whole song.

### Added

- **Ghost carries the drums.** Every punchy element — ripples, confetti, the
  strobe flicker, the dancers — draws on the 2D canvas that Ghost removes, so
  the beat fired with nowhere to show. A per-preset kick gain amplifies the
  cloud's own beat response, so the field punches in and blooms on each hit.
  Other looks are unchanged.

- **Offline Hindi → English translation, no API key.** Devanagari lyrics are now
  translated on-device by a small Marian model (~75 MB, downloaded once on first
  use). The `EN` chip works on those songs with no key configured at all.

  Gated deliberately: the model reads Devanagari only. On romanized Hindi or on
  English it returns confident nonsense rather than failing, so anything that is
  not predominantly Devanagari still goes to the configured LLM provider. This
  does **not** yet cover romanized lyrics, which is most of what LRCLIB carries
  for Indian songs.

### Changed

- **Word highlighting is weighted by syllables, not characters.** Splitting a
  line by character count gave "strength" (8 characters, 1 syllable) eight times
  the time of "a". Sung duration tracks syllables. On a real line with a 3s
  budget: `strength` 774ms → 333ms, `through` 677ms → 333ms, and `I` rose from
  97ms — too brief to see — to 333ms.

  Devanagari and Gurmukhi are counted exactly, since a syllable *is* an akshara.
  The English silent-'e' rule is deliberately omitted: romanized Hindi and
  Punjabi pronounce that trailing 'e' ("jale", "dukhe", "bane" are all two
  syllables), and weights are relative within a line.

- Word highlighting no longer touches the DOM every frame. It ran
  `querySelectorAll` and re-parsed two attributes per word per frame — for a
  10-word line, 600 queries and 1200 string parses a second to produce about ten
  actual changes.

## 0.11.1 — 2026-08-10

### Changed

- **The lowest backdrop-opacity level is now called *faint*, not *ghost*.**
  0.11.0 introduced a visual preset also called Ghost, leaving two chips
  offering the same word for unrelated things — `◐` for how see-through the
  overlay is, `◈` for a lyrics-only look.

  The opacity label is the one that moved because it is the one that is safe to
  move: that choice persists as an index, so renaming it changes nothing on
  disk. The preset id persists as a string, in `localStorage` and in the
  per-track look overrides, so renaming *that* would have silently discarded
  every look pinned to a song — and it would have contradicted the 0.11.0
  release notes and the installer already in the wild.

- README now documents all nine control chips (it listed four) and describes
  each visual preset.

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
