# Release video — production script

A 60-second cut for the v0.9.0 release. Written to be shot, not admired: every
beat says what is on screen, what to do to make it happen, and what the caption
says.

**Do not fake anything.** Every claim below is something the app actually does,
and the whole point of a lyric visualiser demo is that viewers can tell when
footage is real. Record the app playing real music.

---

## Before you record

| Item | Why |
|---|---|
| Pick a track with a **big instrumental intro and a hard drop** | The drop moment is the single most impressive 2 seconds in the app. EDM or a rap track with a beat switch. |
| Pick a **Hindi or Punjabi** track for the script section | Proves the Indic rendering, which nothing else on the market does well. |
| Turn the **♫ chip on** | Without loopback capture the visuals run on lyric cadence only, and the drops are far weaker. |
| Turn **Lite mode off** (⚡ unpressed) | Lite drops the galaxy and parametric layers — exactly the parts that look best. |
| Set backdrop to **vivid** (◐ chip) | Ghost/tinted are for real use over a desktop; vivid reads best on video. |
| Record at **1920×1080, 60fps** | The visuals are motion-heavy; 30fps loses the beat flicker and shockwaves. |
| Play a song **twice** before recording the transcription section | The whole point is that the second play is instant. |

Use OBS with a Display Capture source. The overlay is a transparent
always-on-top window, so window capture may miss the compositing — capture the
whole display and crop.

---

## Shot list

### 0:00–0:05 — Cold open, no title card

**On screen:** the drop. Start recording a few seconds before it lands, cut in
1 second before impact. Shockwave rings, confetti burst, the swirl unwinding
outward, screen shake.

**Caption:** *(none — let it play)*

> Lead with the best two seconds you have. A title card first loses people.

### 0:05–0:12 — What it is

**On screen:** scrolling lyrics, active line large and centred, words lighting
up in time.

**Caption:** **A lyric player that reacts to your music.**
**Sub:** *Works with Spotify, YouTube, anything — it reads Windows' own media session.*

**Do:** let one full line scroll through so the per-word highlight is visible.

### 0:12–0:22 — The backdrop is the product

**On screen:** hold on a hook — a short lyric line — so the swirl opens fully.
Then cut to a dense, wordy bar and let the field visibly calm down.

**Caption:** **The backdrop swirls into the space the lyrics aren't using.**
**Sub:** *Big spirals on hooks and instrumentals. Calm behind dense lines, so you can still read.*

**Do:** this contrast is the most novel idea in the app. Give it the full 10
seconds and cut on the beat between the two states. Stills `01-hook-swirl.png`
and `02-dense-line.png` show the two ends if you need reference frames.

### 0:22–0:32 — Reacts to real audio

**On screen:** a build-up into a drop. Show the centre bloom ramping, then the
release.

**Caption:** **It listens to what's actually playing.**
**Sub:** *Build-ups tighten the spiral. Drops blow it open.*

**Do:** if the song has a filtered riser, that is the shot. Let the build run at
least 4 seconds so the ramp is legible — cutting in late makes it look like a
flash rather than a build.

### 0:32–0:42 — Languages

**On screen:** the Hindi/Punjabi track, native script, then tap `अ` and `EN` to
show the script toggle and the translation line.

**Caption:** **Hindi, Punjabi, and scripts most players break.**
**Sub:** *Correct shaping — vowel marks stay attached, not scattered.*

**Do:** hold on the native-script line for a beat before toggling. Reference
frames: `04-devanagari.png`, `05-gurmukhi.png`.

> This is a real differentiator: most lyric apps render Devanagari and Gurmukhi
> with Latin letter-spacing, which detaches the matras. Worth the airtime.

### 0:42–0:52 — Lyrics for songs that have none

**On screen:** a track with no synced lyrics. Show the status line
"listening to learn this song…", then hard-cut to the **same track playing
again** with lyrics scrolling.

**Caption:** **No lyrics online? It writes them itself.**
**Sub:** *Listens once, then it's instant and offline forever.*

**Do:** this is the trick shot. Record the first play, stop, replay the song,
and cut the two together at the same moment in the track so the difference is
unmistakable. **Do not speed up the transcription in the edit and imply it is
instant** — the honest framing (learns once, then instant) is a better story
anyway.

### 0:52–1:00 — Close

**On screen:** pull back to a wide shot of the drop again, let it run, fade.

**Caption:** **Lyric Overlay — free, open source, Windows.**
**Sub:** `github.com/Dhruvch1244/lyric-viewer`

---

## Captions — full list for subtitles

```
A lyric player that reacts to your music.
Works with Spotify, YouTube, anything — it reads Windows' own media session.
The backdrop swirls into the space the lyrics aren't using.
Big spirals on hooks and instrumentals. Calm behind dense lines, so you can still read.
It listens to what's actually playing.
Build-ups tighten the spiral. Drops blow it open.
Hindi, Punjabi, and scripts most players break.
Correct shaping — vowel marks stay attached, not scattered.
No lyrics online? It writes them itself.
Listens once, then it's instant and offline forever.
Lyric Overlay — free, open source, Windows.
```

---

## Claims you can make, and how they're backed

| Claim | Backing |
|---|---|
| "Reacts to what's actually playing" | Real loopback capture + FFT (`src/renderer/audio.js`) drives kicks, build-ups and drops. |
| "Swirls into the space lyrics aren't using" | Measured: no active line 0.82, 4-char hook 1.00, 49-char bar 0.50. |
| "Runs smooth" | 72–85fps measured at 1080p with the full visual stack. |
| "Writes lyrics itself" | Whisper transcription, cached to disk after one listen. |
| "Correct Indic shaping" | Verified: Indic lines compute `letter-spacing: normal` and measure 1.00× the reference face. |

**Do not claim** the transcription is accurate on all music. It is a speech
model; it is weakest on fast rap and dense EDM — the honest line is *"for songs
that have no lyrics anywhere"*, which is still a genuinely useful thing.

---

## Stills

Five real 1080p frames are generated into `promo/stills/` (gitignored — they
are regenerated, not authored). To rebuild them, run the promo capture harness
against the renderer; see the release notes in git history for the approach.

| File | Shows |
|---|---|
| `01-hook-swirl.png` | Short hook, swirl fully open |
| `02-dense-line.png` | Dense bar, swirl calmed for legibility |
| `03-drop.png` | Drop moment — best single frame, good thumbnail |
| `04-devanagari.png` | Devanagari shaping |
| `05-gurmukhi.png` | Gurmukhi shaping |

`03-drop.png` is the strongest thumbnail candidate.

---

## Music licensing

If this goes anywhere public, the soundtrack is the risk, not the software.
Demoing with a commercial track will get the video muted or pulled on YouTube
and Instagram. Options, in order of preference:

1. A track you own or made.
2. Genuinely royalty-free EDM with a hard drop.
3. Keep the commercial track for a local/portfolio cut, and produce a separate
   licensed-audio cut for public posting.

The Hindi/Punjabi section is the awkward one, since royalty-free Indic vocal
tracks are scarce. A short clip under fair-use-style commentary is the usual
route for a software demo, but that is a judgement call, not legal advice.
