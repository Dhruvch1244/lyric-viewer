# Launch posts

Draft copy for posting Lyric Overlay to a few places where the audience
overlaps with what it actually is — a Windows visualizer with synced lyrics,
free, no account. Written in the same spirit as `VIDEO_SCRIPT.md`: every claim
here is something the app verifiably does, not something that sounds good.
Swap in a real screenshot/GIF before posting each one — `web/assets/screenshots/`
has the source images, and `04-wormhole.jpg` or `01-liquid.jpg` are the
strongest single stills.

Nothing here gets posted automatically. Read each one, adjust anything that's
gone stale by the time you post it (version number, install size), and send it
yourself from your own accounts.

---

## Show HN

Timing note: Tuesday–Thursday, roughly 8–10am US Eastern, gets the most
sustained front-page traffic on HN. Avoid Friday/weekend.

**Title** (80 char max, HN strips the "Show HN:" prefix from the count):

```
Show HN: A music visualizer for Windows that also knows the words
```

**Body:**

```
I wanted a MilkDrop-style visualizer that also showed synced lyrics, and
couldn't find one — every lyric app is a text renderer with no visuals, and
every visualizer has no idea what's playing. So I built it.

It reads Windows' System Media Transport Controls, so it works with Spotify,
YouTube, or anything else that registers a media session — no browser
extension, no API keys, no login. If a song has no synced lyrics anywhere, it
transcribes them itself with an offline Whisper model and caches the result,
so that only costs you once per song.

The visual side is Butterchurn (MilkDrop 2 in WebGL2) plus a custom GPU field
that's the actual point of the project: it's the only visual system here that
times itself to lyric density rather than just audio — it opens up on a hook,
calms down behind a dense, wordy line so you can still read it, and
anticipates a drop a few seconds early once it's learned a song's energy arc.

It's a Tauri app — Rust backend, WebView2 frontend, no bundled Chromium — so
the installer is about 18MB. Free, MIT-licensed, source is all here.

Known rough edges: it's Windows-only right now because SMTC is the whole
detection layer (macOS/Linux builds run the visuals and lyrics, just not the
now-playing detection). The installer isn't code-signed yet, so Windows
SmartScreen will warn on first run — that's next on the list, not a
you're-being-scammed thing. Transcription is CPU-bound and takes a few
minutes on a song with no synced lyrics available; after that it's instant
and offline forever.

Happy to answer anything about the SMTC integration, the GPU visual field, or
the on-device Whisper pipeline — all in src-tauri/ and src/renderer/.
```

**First self-comment** (post immediately after, HN rewards the OP engaging
early — use this to pre-empt the SmartScreen question before someone else
raises it as a red flag):

```
Heads up on Windows SmartScreen: the installer isn't Authenticode-signed yet
(the updater has its own signature, which is a different thing), so first run
may show the "Windows protected your PC" screen. That's a signing-cert
problem, not a "this is sketchy" problem — the source is all here if you'd
rather build it yourself, and a signed build is in progress.
```

---

## r/software (or r/opensource)

Both subs lean toward "what is it, what does it cost, is the source open" —
lead with that, skip the origin story.

**Title:**

```
Lyric Overlay — free, open-source music visualizer for Windows with synced lyrics (MilkDrop-class visuals + auto-transcription for songs with none)
```

**Body:**

```
Free and MIT-licensed: https://github.com/Dhruvch1244/lyric-viewer

What it does: detects whatever's playing on Windows (Spotify, YouTube, local
files, anything with a media session) and shows beat-synced lyrics over a
live visualizer — either the built-in GPU field or any of 1754 MilkDrop
presets. If a song has no synced lyrics anywhere, it transcribes them itself
with an offline Whisper model, so that only costs time once.

A few things that might matter if you're comparing it to other lyric/
visualizer apps:

- No account, no API keys, nothing to configure to get it working
- Wallpaper mode — runs behind your desktop icons instead of as a window
- Hindi/Punjabi support with correct native-script shaping, plus on-demand
  translation and transliteration
- ~18MB installer (Tauri, not Electron — no bundled browser runtime)
- Everything's local: lyrics come from LRCLIB (free, keyless), transcription
  runs on-device

Rough edges: Windows-only for the now-playing detection (SMTC), and the
installer isn't code-signed yet so SmartScreen will flag it on first run —
that's a known gap, not a "this is malware" thing. Building from source
avoids it entirely if that's a dealbreaker.

Screenshots and a browser demo (no install) on the site:
https://lyricoverlay.dhruvchoudhary.com
```

---

## r/Windows11 (or r/pcmasterrace for the visualizer angle)

This audience responds to screenshots and "just works" more than technical
depth — lead with the gallery, keep the pitch to two lines.

**Title:**

```
Made a free wallpaper/overlay app that shows synced lyrics over a live music visualizer — reads whatever you're already playing, no setup
```

**Body:**

```
[screenshot of Wormhole or Liquid preset here]

Free, open source, ~18MB installer: https://lyricoverlay.dhruvchoudhary.com

Detects whatever's playing (Spotify, YouTube, anything) automatically —
nothing to connect, no account. Nine visual presets plus 1754 MilkDrop ones
if you want to dig through those. There's a wallpaper mode too, so it can run
behind your icons instead of as a window on top of everything.

Windows only for now (it uses the same API Windows' own now-playing widget
does). Installer isn't signed yet so you'll likely see a SmartScreen warning
on first run — legit gap, working on it, source's all on GitHub if you'd
rather build it yourself.
```

---

## X / Twitter thread

Four posts, meant to be read as a thread. First one has to work as a
standalone — most impressions only see it.

**1/**
```
Every lyric app on Windows is scrolling text. Every visualizer has no idea
what song is playing.

Built the thing that's both. Free, open source, Windows.

[GIF: a drop moment — shockwave + lyric emphasis]
```

**2/**
```
It reads whatever you're already playing — Spotify, YouTube, anything with
a Windows media session. No login, no browser extension, no API keys.

No synced lyrics online for a track? It transcribes them itself, offline,
once, then caches it forever.
```

**3/**
```
The visual field isn't random — it's the one thing here that actually reads
the lyrics: opens up on a hook, calms down behind a dense line so you can
still read it, and leans into a drop a few seconds before it lands once it's
learned the song.
```

**4/**
```
~18MB installer, no bundled browser runtime (it's Tauri, not Electron).
Free, MIT-licensed, source's all here:

github.com/Dhruvch1244/lyric-viewer
lyricoverlay.dhruvchoudhary.com
```

---

## One-line pitches (bios, link-in-bio, README summaries)

Pick based on space:

- **Full:** "A music visualizer for Windows that reacts to whatever you're
  playing — with synced lyrics, in any language, even for songs that don't
  have any."
- **Short:** "MilkDrop-class visuals that know the words."
- **Shortest:** "A visualizer that reads the lyrics."

---

## Before posting, check these haven't gone stale

- Installer size (currently ~18MB as of v0.35.0 — confirm against the latest
  release asset before quoting a number)
- Preset count (currently 1754)
- Whether SmartScreen/signing is still an open gap (see ROADMAP.md §5) — if
  a signed build or Store listing has shipped since this was written, cut the
  SmartScreen caveat entirely rather than needlessly hedging
- The GitHub/site links still resolve
