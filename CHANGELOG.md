# Changelog

All notable changes to Lyric Overlay. Versions follow [semantic versioning](https://semver.org/).

## 0.34.0 — 2026-08-18

- **Floating bar and taskbar strip display modes are back.** A "Display"
  chip opens a menu (Fullscreen / Floating bar / Taskbar strip) instead of
  the old cycle-through-four button, so every mode is one labelled click
  and the current one stays marked — `Ctrl+Alt+D` still cycles the same
  three from the keyboard. Taskbar strip is a 96px edge along the bottom
  with no interactive chrome (nothing fits at that height), so it's real
  OS-level click-through (`set_ignore_cursor_events`) rather than a
  CSS trick — clicks pass straight through to whatever's underneath,
  taskbar included. Verified live: `Ctrl+Alt+D` correctly cycles and
  persists full → bar → strip → full, window geometry matches exactly
  (strip pinned to the last 96px of the monitor), and a click inside the
  strip's bounds hits the taskbar underneath, not the overlay.
- **Real per-word sync now reaches LRCLIB/NetEase/Kugou lyrics, not just
  Whisper-only tracks.** A song with correct synced lyrics but no per-word
  timing used to be silently skipped by the transcription pass entirely —
  `finalize_transcription` treated "already has real synced lyrics" as a
  reason to do nothing further, so those lines were stuck on the
  syllable-weighted timing estimate forever, and the app kept quietly
  listening on every play for no benefit. Now it attaches real per-word
  timing to the *existing, trusted* line text and timing wherever a line
  cleanly anchors to what Whisper heard — the synced text/timing a real
  source already got right never gets touched or replaced, only enriched.
- **Wallpaper mode now pauses itself on battery, at the lock screen, or
  behind a fullscreen app** — the same three triggers Wallpaper Engine and
  Lively Wallpaper use to avoid being the reason a laptop drains fast or a
  game drops frames. A window reparented behind the desktop icons has no way
  to notice any of this on its own, so a background watcher polls
  `GetSystemPowerStatus`, `OpenInputDesktop`, and the foreground window's
  monitor coverage every 2 seconds and parks the render loop the instant one
  of them applies, resuming automatically the moment none do. Live-verified
  against real OS state (matched the taskbar's actual AC/battery status
  exactly) rather than just compiled.

## 0.33.0 — 2026-08-18

- **In-browser Whisper transcription actually works now.** It had been
  completely broken since the Tauri migration without anyone noticing —
  five distinct packaging/CSP bugs, each only visible once the previous one
  was fixed (a missing import map for two bare module specifiers, a wrongly
  vendored `onnxruntime-common` copy that failed with an unrelated-looking
  quantization error, a missing WASM variant, and HuggingFace's newer "Xet"
  CDN falling outside the old CSP allowlist). Confirmed live end-to-end:
  model download, WASM session creation, and inference all work.
- **Redesigned the app's UI chrome** — HUD chips, the key/pre-sync panels,
  the library/cover-art/preset pickers, first-run and update cards — in a
  flat, warm-dark monochrome style with crisp borders and minimal shadow.
  Every emoji glyph in the chrome (🔑📋♪🖥🎲📌 and the transport controls)
  is now a plain monochrome icon. The lyric display, swirl backdrop, and
  band meters are unchanged — that's the product's own visual identity,
  not chrome.
- **Corrected the record on Genius as a lyrics source**: it's blocked by a
  Cloudflare JS challenge and was never actually working, despite being
  listed as shipped. Left in place (it fails closed, at the cost of one
  bounded-timeout network call on a miss) but no longer claimed as a real
  source until something changes on Genius's end.

## 0.32.0 — 2026-08-17

- **Fixed: importing local media appeared to freeze the app.** The native
  file/folder picker was opening *behind* the always-on-top overlay window —
  invisible and unclickable, not actually hung. This was the exact bug that
  failed Microsoft Store certification's media-import check; fixed by
  dropping always-on-top for the picker's duration, the same fix already
  applied to the Spotify sign-in browser window.
- **Fixed: Spotify "Connect" never completed.** The OAuth redirect listener
  bound a random port on every attempt, which Spotify's exact-match
  redirect-URI check always rejects. Now binds one of three fixed,
  registerable ports.
- **Real per-word lyric sync**, where a Whisper transcription anchors a line
  cleanly enough to trust: measured timing on individual words instead of
  the syllable-weighted estimate every line used before.
- **An LLM can now clean up Whisper's mishearings** on songs with no real
  lyrics available to check the transcript against, reusing whichever
  provider is already configured — the ear/brain split behind LyricWhiz.
- Spotify playlist imports now **auto-refresh** every few minutes instead of
  needing a manual re-import.
- **A song's mood now nudges which visual preset it's handed** — energetic
  songs lean toward busier looks, calm ones toward sparser ones — on top of
  the motion character mood already shaped.
- **A crash/error log**, always kept locally and openable from the 🔑 panel,
  plus an opt-in (off by default) toggle to also send it to the developer
  automatically — no track, artist, title, or lyric text ever leaves the
  machine through that path.
- Three new artist sprites: Emiway Bantai, Naezy, Brodha V.
- The website now states the signed installer's real size (~6MB).

## 0.31.2 — 2026-08-16

- **Removed the emoji reaction burst entirely.** The 0.31.1 fix cut its
  per-frame font cost, but it was still reported as a heavy slowdown in
  practice — pulled the effect rather than tuning it further. Confetti and
  the rest of the drop celebration (ripples, dancer troupe burst, hue jump)
  are unaffected.
- **Backdrop perf sweep**: several small hot-path fixes in the animated
  backdrop — skipped redundant canvas colour-state writes in the galaxy
  field, replaced four per-frame particle/clone-list rebuilds with in-place
  compaction, hoisted a couple of frame-constant colour computations out of
  per-object loops, and memoised a repeated 96-bin scan in the song heatmap.
  No visual change; less CPU spent reproducing the same frame.

## 0.31.1 — 2026-08-15

- **Fixed: Spotify sign-in was invisible.** The overlay's always-on-top
  setting was hiding the browser window Spotify's login opened in — not
  broken, not laggy, just unclickable behind the overlay the whole time.
- **Fixed a real perf bug in the emoji reaction burst** (shipped in 0.31.0):
  setting the emoji font per particle per frame was drastically expensive —
  measured 58ms for 120 particles, blowing the frame budget 3.5x. Down to
  under 2ms for the same load.

## 0.31.0 — 2026-08-15

- **Import a playlist straight from Spotify** into the pre-sync panel — register
  a free Spotify Developer app, paste the Client ID into the 🔑 panel, connect,
  pick a playlist, and its tracks land in the pre-sync box ready to fetch. Uses
  a local loopback redirect rather than a custom URI scheme (the alternative
  has a known bug on NSIS installs — the one most people are running).
- **Desktop notifications for background work that's actually worth
  interrupting for** — just transcription today, silent, not an alarm.
- **A local-CLI fallback offer, for real this time.** If every configured
  provider (cloud or local) fails and you have Claude/Gemini/Ollama/`gh
  models`/Antigravity installed but haven't picked one, the app now actually
  offers it once per session instead of staying silent about the option.
- **Emoji reaction burst** on drops and hype lines — 🔥⚡💥✨🎉 on a drop,
  🔥🎤💯🙌🚀 on an energetic line, physics-matched to the existing confetti.
- **Wallpaper mode now targets the monitor you're actually using**, not
  always the primary display, on multi-monitor setups.
- **Vocal isolation respects Lite mode** — skipped outright when Lite mode is
  on, rather than spending the CPU regardless.
- **Groq's default model upgraded** to `openai/gpt-oss-120b` — cheaper, faster,
  same context as the old default, verified against Groq's own docs.
- **Whisper and Demucs models pre-warm in the background** a few seconds
  after startup (only for features you actually have on), so the first real
  transcription or vocal-isolation pass doesn't pay for the download.
- Fixed: the 🔑 panel's "saved" confirmation was silently broken (a backend
  return-type mismatch) — keys were saving correctly the whole time, only the
  confirmation message was wrong.

## 0.30.1 — 2026-08-15

- **Fixed: wallpaper mode had no way out.** If pointer forwarding to a window
  reparented behind the desktop icons ever stalled, the only click target
  that could get you back (the wallpaper toggle chip) was itself unreachable
  — no keyboard fallback existed either. Added `Ctrl+Alt+M` as a global
  hotkey that toggles wallpaper mode regardless of pointer/click state, and
  fixed the underlying state reset so leaving wallpaper mode always lands in
  a clean, interactive fullscreen window even from mid-interaction edge cases.

## 0.30.0 — 2026-08-15

- **Wallpaper mode is back, for real this time.** Fullscreen-only (0.28.0)
  quietly left it completely dead — the pointer-forwarding loop that makes a
  reparented window clickable was never actually started, and there was no
  way to turn it on even before that. New `🖥 Wallpaper` toggle chip.
- **Fixed a bug re-transcribing every song, every play.** With ♫ on, a track
  that already had correct synced lyrics was silently re-transcribed via
  Whisper and overwritten with a lower-accuracy guess on every single replay.
- **MilkDrop now respects Lite mode** instead of always rendering at full
  internal resolution regardless of the ⚡ chip.
- **Whisper transcription moved off the render thread** (WASM proxy mode) so
  a transcription pass no longer freezes the visuals while it runs.
- **Whisper transcription-language picker** — a real UI control for the
  setting that already existed but was only reachable by hand-editing config.
- **Experimental: isolate vocals before transcribing.** Off by default; tries
  to separate vocals from the mix before Whisper runs, aimed at fast rap and
  dense EDM mixes where Whisper's accuracy drops the most.
- **Playlist pre-sync, beat maps, and the local-CLI AI fallback (Claude /
  Gemini / Ollama / `gh models` / Antigravity) all actually work now** — each
  had shipped as an empty stub on the Tauri port.
- **Native per-song audio analysis** (symphonia) — local-file playback
  decodes and analyses off the UI thread instead of through the renderer's
  Web Audio pass.

## 0.29.0 — 2026-08-14

- **Auto-gained native audio.** The WASAPI loopback spectrum now self-calibrates
  to whatever the system's actual loudness is instead of assuming a fixed
  volume range, and capture logs a diagnostic heartbeat to help track down any
  remaining "not reacting" reports. (Waveform/MilkDrop feed was unaffected —
  only the frequency spectrum used the fixed range.)
- **Launch on Windows startup.** A toggle in the settings panel starts Lyric
  Overlay automatically when you log in. Not available on the Microsoft Store
  build, which uses its own startup mechanism.
- **Stop rendering the instant the overlay is hidden.** Ctrl+Alt+H (or the tray
  icon) now fully stops the render loop rather than idling it — no more waking
  up every frame just to do nothing while the overlay is out of the way.

## 0.28.0 — 2026-08-14

- **Fullscreen only, for now.** The Floating bar, Taskbar strip, and Desktop
  display modes are removed — the overlay runs fullscreen, and you hide or show
  it with the tray icon or Ctrl+Alt+H. Any saved mode opens as fullscreen.
- **Native system-audio capture — no share-picker.** Turning on ♫ now taps your
  system output directly via WASAPI loopback instead of the "choose what to
  share" prompt. It falls back to the old capture if the native path is
  unavailable.

## 0.27.5 — 2026-08-14

- **Removed the "Desktop" display mode.** It sent the overlay behind the desktop
  icons, where its buttons became unclickable with no obvious way back. Any saved
  "Desktop" preference now opens as Fullscreen. (Fixes a Microsoft Store
  certification block.)
- **Report AI content.** The AI-settings panel now has a "Report content" control
  for flagging inappropriate translation / transliteration / mood output.

## 0.27.4 — 2026-08-13

- **Signed Windows installers.** Windows builds are now Authenticode-signed via
  SignPath, so the installer carries a publisher identity ("Dhruv Choudhary")
  instead of being unsigned. The signature is applied before the updater
  signature, so auto-update stays valid. (The certificate is self-signed for
  now, so Windows SmartScreen may still warn on first download.)

## 0.27.3 — 2026-08-13

- **Fixed audio capture failing to start.** The picker-bypass experiment in
  0.27.2 made the capture request reject outright ("audio capture unavailable");
  reverted to the working request. Enabling `♫` shows the source picker and then
  captures — a native, picker-free path is in progress.

## 0.27.2 — 2026-08-13

- **macOS and Linux builds.** The release pipeline now produces installers for
  all three platforms (the bundle target was Windows-only before). On macOS/Linux
  the now-playing detection and wallpaper mode are not wired yet; the visuals,
  lyrics, artwork and translation work.
- **Audio-capture picker.** Further work to skip the "Choose what to share"
  dialog when enabling `♫` capture.

## 0.27.0 — 2026-08-12

Punchier reactivity, a smoother capture flow, and cross-platform groundwork.

### Added

- **The backdrop hits harder on the beat.** Each kick now thumps the whole
  field inward and fires a shockwave ring from the centre, with a brighter
  per-kick flash and bigger build-up/drop swings — the visuals lean into the
  drops instead of just shimmering through them.
- **No more "Choose what to share" pop-up.** Enabling audio capture (♫) used to
  show the browser's screen-share picker every time; it now selects the source
  automatically, so capture just starts.
- **Cross-platform build pipeline.** A CI workflow builds and signs the app for
  Windows, macOS and Linux on a release tag. The Windows-only features (now-
  playing detection, wallpaper mode) don't have their macOS/Linux equivalents
  yet — the visuals, lyrics, artwork and translation work everywhere.

### Changed

- **Faster, tighter build.** The release binary is compiled with link-time
  optimisation and stripped symbols.

## 0.26.0 — 2026-08-12 — Tauri rebuild

The whole app moved off Electron onto **Tauri**. Same overlay, same visuals — a
fraction of the size.

### Changed

- **The installer is ~30 MB instead of ~116 MB.** The app now uses the Windows
  system WebView2 runtime instead of bundling a full copy of Chromium. The
  visual layer (the WebGL swirl, the galaxy, MilkDrop, the lyric column) is
  unchanged — it is the same web renderer, just hosted by Tauri.
- **The backend is now Rust.** SMTC "now playing" detection, the three synced
  lyric sources (LRCLIB, NetEase, Kugou), cover art, the LLM features
  (translation, per-line attribution, mood, transliteration), wallpaper mode,
  the tray, global hotkeys, local-file playback, the MilkDrop catalogue, the
  updater and key storage were all reimplemented natively.

### Notes

- **Auto-transcription (Whisper) now runs in the app itself** via WebAssembly,
  so there is no separate 22 MB native runtime in the installer — the speech
  model downloads on first use and is cached.
- Existing 0.25.0 installs do not auto-migrate (the two builds use different
  update mechanisms); install 0.26.0 fresh to move to the Tauri build.

## 0.25.0 — 2026-08-12

Smoother transitions, a faster track start, and wider synced-lyric coverage.

### Added

- **Wider synced-lyric coverage from plain lyrics.** When no source has *synced*
  lyrics but the real words exist as plain text — LRCLIB's plain catalogue is
  far larger than its synced one — the app now finds and caches them instead of
  reporting a flat miss. With `♫` capture on, a Whisper pass times those correct
  words to the music (see `align.js`), so the song scrolls the right lyrics
  rather than a best-effort transcription. The status says so: "lyrics found —
  timing them to the music" instead of "no synced lyrics".

- **Live-play confirmation for the model-driven features.** Per-line singer
  attribution and measured word-level sync used to land invisibly. They now
  announce themselves briefly ("singers identified — …", "word-sync active") so
  a single play confirms they fired.

### Changed

- **Beat-synced preset transitions cross-fade over a musical phrase.** A
  drop-triggered MilkDrop switch now fades across four beats, scaled to the
  measured tempo, so the new preset arrives on a bar boundary with the music
  rather than at a fixed 2.7s wall-clock offset.

### Fixed

- **Smoother track starts.** Deriving a cover's palette ends in a `getImageData`
  call, which forces a GPU→CPU readback and stalls the frame. It ran on the same
  frame that blurred the new cover, while the main process was mid decode /
  analysis / lyric fetch — part of the measured first-few-seconds frame dip. The
  palette pass now waits for an idle slot; the visible backdrop still appears
  immediately.

## 0.24.0 — 2026-08-12

Bug fixes and UX, from real-use feedback on 0.23.0.

### Fixed

- **Coloured rectangles across the screen.** The GPU galaxy added in 0.23.0
  drew as `GL_POINTS`, and point-sprites render as untextured squares under
  ANGLE (the Direct3D backend Electron uses on Windows) on many drivers. It is
  reimplemented as **instanced quads** — ordinary two-triangle geometry, which
  every driver renders correctly, so the square bug cannot occur. Same
  golden-angle spiral, still on the GPU. (If a compile ever fails, it still
  falls back to the CPU galaxy.)

- **The Gemini CLI fallback failed with "not enough arguments".** Its `-p` flag
  needs the prompt as its value, but the app's prompts are multi-line JSON that
  cannot be passed as a Windows command-line argument. Gemini is now fed the
  prompt on stdin like the others. Claude remains the verified one.

- **Updates apply silently now.** The installer is one-click, so auto-update no
  longer runs a wizard you had to click through — it downloads and installs on
  restart without interaction.

- **Switching to desktop mode was slow.** Entering it asked the Windows shell to
  spawn the wallpaper surface with a one-second timeout, three times — up to
  three seconds of frozen UI whenever the shell was momentarily busy. It now
  aborts immediately if the shell isn't answering and caps the wait at 250ms;
  measured, the switch dropped to 7–36ms.

### Changed

- **Language toggles moved to the top-right, always visible.** Script (अ) and
  English translation (EN) were in the bottom HUD, which hides until you move
  the mouse — the two most-used controls were the hardest to reach. They now sit
  in the top-right corner, always on, one click away.

- **Display size is a menu, not a cycle.** The size chip opens a menu —
  Fullscreen, Floating bar, Taskbar strip, Desktop — each a labelled click with
  the current one marked, instead of cycling through four modes and hoping.
  Compact modes are reachable again. `Ctrl+Alt+M` still quick-toggles the
  desktop.

- **The local-AI picker is clearer, and reachable on demand.** When it offers a
  CLI, the verified one (Claude) is listed first and marked ✓; the others are
  labelled best-effort or experimental. And it no longer only appears after a
  failure — the 🔑 key panel now has a "Local AI" row to pick (or turn off) a
  CLI any time.

## 0.23.0 — 2026-08-12

### Added

- **Karaoke-grade word fill.** The word being sung now wipes left→right across
  itself over its own duration — bright where it has been sung, dim where it
  has not, with a glowing edge at the front — instead of the old all-at-once
  highlight. Driven per frame from the word's timing (real where a source
  provided it, syllable-weighted estimate otherwise), quantised so it costs one
  style write on one element per frame. Verified on a real synced track.

- **Per-mood visual profiles.** The song's mood and energy now shape *how* the
  visuals move, not just their colour: a calm song churns and strobes less, a
  driving or dark one more, at the same energy. The mood is classified into a
  character (calm / energetic / dark / bright / neutral) and folded into the
  motion the field already computes; drops still hit hard regardless. Unblockable
  end to end now via the local-CLI sentiment path.

- **A GPU starfield.** A deep-space layer of sparse, twinkling stars now drifts
  behind the swirl field — rendered inside the shader, so it costs the CPU
  nothing where the old star layers cost a draw per point. A shader that fails
  to compile degrades to the 2D wash rather than breaking anything.

- **The phyllotaxis galaxy runs on the GPU.** The 260-point Fibonacci spiral —
  the heaviest always-on 2D layer, one draw per point — is now a GL_POINTS pass
  inside the swirl's WebGL context, its positions in a VBO and its motion
  computed in the shader. Same golden-angle look, the CPU freed of it. It falls
  back to the old CPU version if the GPU pass cannot build, and the two never
  draw at once. Together these are the "2D layers onto the GPU" work landing.

### Notes

- This is the first half of the "karaoke-grade sync" and "visual depth" work.
  The heavier pieces — real word-level timing from a source, vocal isolation for
  cleaner transcription, and more of the 2D layers moved onto the GPU — are
  scoped in NEXT_STEPS.md and land across the next releases.

## 0.22.0 — 2026-08-12

The release that made desktop mode actually usable, and made switching modes
stop throwing your song away.

### Fixed

- **Switching modes lost everything.** Entering desktop/wallpaper mode rebuilt
  the whole window — because the code believed a transparent window could not be
  a wallpaper. It can (it composites over your real Windows wallpaper), so the
  window is now created once and never rebuilt. The playing song, its position,
  the lyrics, audio capture and any open panel all survive a switch now; before,
  each toggle was effectively a restart to a blank state.

- **Coming back to the overlay showed nothing.** Leaving desktop mode left the
  window at the bottom of the z-order, so the overlay returned behind every
  other window. It is now raised back to the front in the same native step that
  detaches it from the desktop.

- **Desktop mode was half-unusable.** Panels like the library and the 1754-preset
  browser could be opened but not scrolled, because forwarded mouse input
  covered clicks but not the wheel. Opening a panel now briefly brings the whole
  window to the front so everything works — scroll, drag, clicks — and it
  settles back behind your icons when you close it.

- **A picked MilkDrop preset reverted to the original.** You'd choose a preset,
  it would show, then a second or two later snap back. The FPS governor swaps
  MilkDrop for a cheap fallback whenever the frame rate dips below 24 — and
  MilkDrop dips often — and swapping back was wiping your choice and reloading
  the look's default. Your pick now survives that bounce; only changing the look
  itself clears it.

### Changed

- **One mode, plus a desktop toggle.** The size chip and `Ctrl+Alt+M` now simply
  flip between the fullscreen overlay and living on your desktop, instead of
  cycling four modes. The floating bar and taskbar strip are still in the code
  but off the main path, so you can't land on a half-finished one by clicking
  once too many.

- **MilkDrop opens on a good preset.** The catalogue is 1754 presets and a large
  share of them are dim, broken here, or ugly, so opening on a random one landed
  on a dud more often than not. A curated shortlist of ten reliably-good presets
  is now what the dice, the beat-synced cycle and the opening look draw from —
  until you like some of your own, after which yours take over. The browser
  still offers all 1754.

### Added

- **A friendly "what's new" card after an update.** A returning user sees a
  short, warm summary of what changed — separate from the first-run welcome,
  shown once per new version.

- **Local AI fallback when the cloud fails.** When every configured cloud
  provider is unavailable — a spent quota, a bad key, no network — and you have
  a developer CLI installed, the app offers to use it instead of letting the AI
  features (translation, transcript correction, per-line artist attribution) go
  dark. It supports Claude, Gemini, Ollama, GitHub Models (`gh`) and Antigravity,
  tries them only after the cloud, and never runs one without you picking it
  first. Verified end to end with `claude`. This is also the first path that
  makes per-line attribution work on a machine with no working cloud key.

## 0.21.0 — 2026-08-11

The release where three things everyone believed turned out to be wrong, and
finding that out was worth more than the features.

### Fixed

- **Updates never arrived, and would not have said so.** Three defects, one
  missing surface. The **`.exe.blockmap` was never published** — electron-updater
  fetches it to transfer only the chunks that changed, so that request has 404'd
  on every client since auto-update shipped, and every update re-downloaded all
  114MB. `allowToChangeInstallationDirectory` let the update installer ask for a
  directory again, which is how an update lands *beside* the app rather than
  over it and leaves you uninstalling by hand. And it checked exactly once, at
  startup, on an app people leave running for days that ships most days.

  None of it was ever on screen either: the state lived inside the tray's
  right-click menu, on an app whose entire surface is a full-screen overlay.
  There is now a pill while an update downloads and a card with **Restart now /
  Later** once it is ready. Later is remembered per version, so it asks about
  each build once.

- **The visual governor was feeding itself.** Profiling a real song put
  `swirl.js`'s `resize` at 289ms of self time — for a function that reallocates
  a WebGL drawing buffer and should fire a handful of times a session. Its own
  comment claimed it never changed faster than once a second; the code only
  guarded the way *up*. So one long frame dropped a resolution rung, the
  reallocation cost another long frame, and that dropped the next: each round
  trip a visible hitch. Rate-limited both ways now.

- **The wrong artist was on the mic.** 0.20.0 listed this as known: every artist
  had a silhouette, but the dancer singing was picked by line number, so a
  three-artist track was right one line in three by accident.

### Added

- **1754 presets, up from 395.** The four bundles 0.19.0 shipped were not the
  catalogue — `butterchurn-presets` also ships the corpus they were compiled
  from, and **1360 more looks had been sitting in `node_modules` unused**. They
  ship as files read on demand, so the resident cost is a list of names; three
  bundles are deleted in the same change. Measured, this costs the installer
  approximately nothing and removes 2.3MB of startup parsing.

- **A preset browser you choose with your eyes.** Names written by strangers in
  2003 tell you nothing about what a preset looks like, so the browser renders
  previews — by the engine itself, cached to disk, and only for cards you
  actually scroll to. Like the ones you love, hide the ones you never want
  again (hidden ones leave the dice and the beat-synced cycle too), and once
  anything is liked the cycle draws only from those. The arrow keys step through
  and load each one as you reach it, which is the part a list of names could not
  do at all.

- **Wallpaper mode.** `Ctrl+Alt+M` now cycles to a fourth mode that renders
  behind the desktop icons rather than over everything — the app becomes
  something that is simply on. It stays clickable: a window parented into the
  desktop receives no mouse input at all, so the pointer is forwarded and the
  chips, library and preset browser all still work.

- **Per-line artist attribution.** One cached pass works out who sings each
  line, and the named dancer takes the mic. Credited artists and dancers are not
  the same list — a registry duo is one credit and two dancers — so the mapping
  matches on names and declines rather than guessing. **Not yet verified end to
  end:** both configured providers are currently failing here (quota, and a
  token without the Inference Providers scope). It starts working with no code
  change once a key does.

- **Kugou as a third synced lyric source.** After LRCLIB and NetEase, keyless.
  Verified live: 77 correct cues for ALL THE TIME, 45 for Blinding Lights.

### Changed

- **The WASAPI item is dropped, because the problem does not exist.** The
  roadmap called the screen-share prompt adoption blocker #3 and named a native
  loopback addon as one of only two places native code earned its keep. That was
  written before `main.js` grew a display-media handler which auto-approves with
  no picker. Measured rather than argued about: a real cursor click on `♫`
  through SendInput, then a full-screen photograph 1.2s later — no dialog
  anywhere, capture already running.

- **Musixmatch was checked and not adopted.** The API answers, but the free tier
  returns a 30% excerpt of *plain* lyrics and no synced subtitles at all, which
  is useless to an app that shows a whole song in time with it.

### Known

- The optional transcription pack is still not split out; the installer keeps
  the 22.7MB ONNX runtime. It is a module-loading change rather than a packaging
  one and cannot be verified without installing and transcribing a real song —
  see NEXT_STEPS.md.
- Attribution has never made a successful provider call on this machine.

## 0.20.0 — 2026-08-11

The first release verified against a real song playing in the real app, start to
finish. That immediately found a bug five releases of harness testing had not.

### Fixed

- **The tempo was drifting badly, and the visuals ran on it.** The offline
  analysis measures a track in ~100ms and gets it right; the live estimator then
  re-derived a tempo from a rolling 12-second window every second and overwrote
  it. On a 138 BPM track it reported 60, 64, 86, 147, 172 and 179 across one
  play — confident and wrong — dragging the beat clock and the BPM chip from
  138 to 174. The platter and the dancers run on that number.

  `Tempo` now takes the whole-song measurement as a prior, and once the tempo is
  known the renderer tracks only the *phase*, which is the part that genuinely
  has to follow the music. The chip now reads 138 for the entire song. The raw
  live estimate still bounces between 62 and 177 in the same run, which is the
  point — the noise is real and the clock is now insulated from it.

- **Auto-update was doing nothing.** 0.19.0 shipped it and published the release
  with only the installer attached; electron-updater reads `latest.yml`, so
  every check found nothing, silently. The manifest is now published, and
  `npm run release:assets` uploads both together so it cannot recur.

### Added

- **A browser for the 395 MilkDrop presets.** 0.19.0 shipped the catalogue and
  no way into it — two named entry points and everything else reachable only by
  waiting for a drop. Search it, click to switch, roll the dice, and pin one to
  a song so it comes back next play. A pin outranks both the preset's own
  starting point and the beat-synced cycle: a pin overridden by a drop four bars
  later would be worse than not offering pinning.

- **A legibility scrim in MilkDrop mode.** The swirl field is soft and
  low-contrast by design. MilkDrop presets are neither, and white text over a
  bright fractal was unreadable in a way this app's own visuals never were.

- **NetEase as a second synced lyric source.** Coverage was the weakest axis:
  one and a half sources against Sonar's three. A second *synced* source is
  worth more than a second plain one — a plain source still has to be aligned by
  Whisper, minutes of CPU and only from the next play, where this scrolls
  immediately and offline. Strongest exactly where LRCLIB is weakest: Mandarin,
  Cantonese, K-pop and the Asian long tail. Runs only after LRCLIB misses.

- **Every artist has a silhouette now, not just a colour.** The registry has six
  hand-authored entries; a real library has far more, and everyone else got the
  same figure recoloured — which at 40 pixels tall reads as one dancer in a
  dozen shirts. Seven head styles, glasses and hair tone, all derived from the
  artist's name, so nothing is stored and an artist looks the same everywhere.

- **Eight bands, a spectral centroid and spectral flux.** The centroid steers
  the global hue: it is the one measure that separates a filtered breakdown from
  a full-range drop when both are equally loud.

- **Compact modes are usable.** The bar carries the translation under the line
  plus sync and translation chips. The strip deliberately gets neither — 54px of
  click-through surface has no room and nothing there could be clicked.

### Changed

- **The wormhole has its background back.** The transparent background shipped
  in 0.19.0 and was reverted on sight: a tunnel floating on the bare desktop
  reads as a widget sitting on the screen, where with the field behind it the
  smoke has something to be smoke *in*. The field is thinned much harder for
  solo looks — 0.42 still left it at 0.35 and swallowed the tunnel whole.

- **Installer stays at 114 MB.** The DirectML provider remains unpackaged.

### Known

- Fullscreen MilkDrop dips to 30–44fps several times per song before recovering.
  The governor only steps in below 24. Not diagnosed; see NEXT_STEPS.md.
- Per-line artist attribution is not done, so on a multi-artist track the dancer
  on the mic is still chosen by line number rather than by who is singing.

## 0.19.0 — 2026-08-11

### Added

- **MilkDrop presets — 395 of them.** On visuals alone this app had one
  aesthetic. projectM ships thousands of presets and Plane9 ships 250 scenes,
  and variety is the entire axis a visualiser is judged on; that gap could not
  be closed by writing more layers by hand. Butterchurn is MilkDrop 2
  reimplemented in WebGL2 and MIT licensed, so a few MB buys the whole
  ecosystem — and nobody else occupies the result, because every lyric app is a
  text renderer and not one visualiser shows the words.

  The swirl field stays the default and stays the identity: it times itself to
  lyric density, which no MilkDrop preset does or can. Tests enforce that it
  remains the default and the majority, and MilkDrop looks are never handed out
  at random.

  The engine runs inside its own frame. MilkDrop presets are equation *sources*
  that get compiled to JavaScript, so they need `unsafe-eval`; granting that to
  the overlay page would extend it to every line handling network-sourced
  lyrics and artwork. `milkdrop.html` relaxes the policy for itself alone, has
  no network access at all, and never sees a string that came off the network —
  audio crosses as raw numbers.

- **Compact display modes.** The app took over the screen or it did nothing.
  `Ctrl+Alt+M` now cycles fullscreen → floating bar → click-through taskbar
  strip. The strip forwards mouse events rather than eating them, because a bar
  pinned along the bottom edge sits exactly where taskbar buttons are.

- **Pick your own cover art.** The artwork search returned one winner; when it
  was wrong there was nothing you could do. The `▣` chip shows what all three
  sources actually found — including the near-misses the automatic pick rejects
  on purpose, which are exactly what you need when it got it wrong. Your choice
  is remembered per song and recolours the app, because the cover drives the
  palette.

- **An LLM fixes what Whisper misheard.** Whisper is a speech model, and on sung
  vocals it mishears *phonetically* — the output rhymes with the truth. A model
  told the song's title and artist can often reconstruct the real line. Runs
  only when there were no real lyrics to match, since correcting known-correct
  words can only make them wrong.

- **Auto-update**, against GitHub Releases, surfaced in the tray. Downloads
  automatically, installs only when you restart.

- **A first-run card**, naming the chips that are not self-evident and the two
  hotkeys.

### Changed

- **Wormhole is a smoky tunnel now, over a transparent background.** Smoke
  cannot be stroked — it has no edge — so the bands are pre-rendered bitmaps
  with real Gaussian blur, and scaling one up to a near ring is itself a blur,
  which is how depth of field behaves and the opposite of what a stroke does.
  Wisps drift between the walls so the tunnel has an inside. `soloLayer` was
  suppressing the wash but not the GPU field, which is not a layer flag and was
  laying a colour film over the desktop regardless; a new `transparentBg` flag
  removes it, so the desktop is the background.

### Performance

- **The app no longer renders while hidden.** `backgroundThrottling` is
  deliberately off so the visuals keep moving while another app has focus — the
  unnoticed cost being that Chromium will not park us when the window is
  *hidden* either. `Ctrl+Alt+H` left the swirl shader, the galaxy, the sprites
  and the beat clock drawing at full rate into a surface nobody could see, for
  as long as the overlay stayed hidden.

- **Compact modes are the biggest performance change here**, not just a feature.
  Profiling puts native compositing at ~850 ms/s against ~45 ms/s for all app
  JavaScript combined, so the only lever left is compositing fewer pixels. Both
  WebGL contexts and the 2D canvas are removed, not hidden — an untouched
  full-screen canvas is still composited every frame.

- **The progress bar** is quantised to 0.1% instead of written every vsync,
  which settles at ~5 style invalidations a second instead of ~50.

- **Installer 123.3MB → 114.2MB**, while adding 2.5MB of preset packs.
  `DirectML.dll` and its shader compiler are no longer packaged: transcription
  is CPU-only because DirectML loads and then fails allocation, measured.

## 0.18.0 — 2026-08-11

### Added

- **Play your own songs — and the app knows them before they start.** Open files
  or a folder and the overlay plays them itself, rather than only watching what
  another app is doing.

  The reason this matters is not convenience. Everything the app *learns* — the
  energy arc behind the timeline, the measured tempo the platter and the dancers
  run on, and the anticipation that reads a stored map forwards — has until now
  needed `♫` loopback capture and a full listen, so a first play got none of it.
  With a local file the decoded samples are already in hand, so the whole track
  is measured offline in a fraction of a second: **the timeline is full, the
  tempo is locked and a drop can be anticipated on play one**, with no capture
  and no permission prompt.

  Position also comes from the audio element itself, which is exact, where SMTC
  is a 250ms poll.

  The measurement is deliberately plain arithmetic over the samples rather than
  Web Audio filters, so it is unit-tested in Node with no browser: a 120 BPM
  click train recovers at 120 ± 3 through the *same* tempo estimator the live
  beat clock uses.

- **A library worth opening.** The old one was a `<ul>` capped at 30% of the
  window height, inside the pre-sync panel, inside a HUD that stays invisible
  until the cursor moves. Songs are what this app is about.

  It is now a proper panel: a card grid with search, badges showing what is
  known about each song (lyrics cached · beat map · energy arc), and — since the
  app can play files now — click a card to play it. Songs known only from an
  earlier play are shown but not playable, which is honest about what clicking
  would do.

- **A system tray icon.** The overlay has no window chrome and hides on a
  hotkey, so once running nothing on screen said it existed. The tray shows the
  current song and any background work, and only transcription finishing raises
  an OS notification — "finding lyrics" fires on every track and would train you
  to dismiss everything this app ever says.

- **Wormhole is ghost-like now, in both senses.** A new `soloLayer` flag draws
  the named layer and the words and suppresses every always-on extra — no
  dancers, stars, glows, ripples or timeline. It is deliberately weaker than
  `bare`, which removes the 2D canvas entirely and therefore cannot serve a mode
  that has a picture. The rings are also wider, dimmer and softer, and the field
  is thinned in solo looks: at full strength the shader simply swallowed the
  tunnel.

- **The `EN` chip says why a translation is missing.** Translations are matched
  to lyrics by index, so a list of a different length is unusable and gets
  hidden — correct, but silent, which made "do translation and sync work
  together?" unanswerable from the UI. It now reads *"42 lyric lines, 39
  translated — can't line them up"*.

### Performance

- **The dancers were the most expensive thing in the app.** `SpriteActor.draw`
  measured ~49 ms/s — more than every backdrop layer combined. Confirmed by
  profiling Ghost, where it vanishes entirely and idle time rises by 60 ms/s.

  | | before | after |
  | --- | --- | --- |
  | `SpriteActor.draw` | 49.25 ms/s | **0.48 ms/s** |

  Four causes, all doing per-dancer, per-frame work for a picture that barely
  changes: the name plate (a font assignment, a `measureText` text-shaping pass,
  a rect and a fill), the ground shadow (a path build and fill), the drop glow
  (`ctx.shadowBlur` — a real-time Gaussian blur, the most expensive operation
  the 2D context has, applied to every dancer on exactly the frame that is
  already busiest), and a fresh pose object per dancer per frame. All are now
  bitmaps or reused scratch objects.

- **A resolution ladder for the 2D backdrop**, mirroring the one the swirl
  already had. Compositing the two full-screen layers is ~850 ms/s against
  ~50 ms/s for all app JavaScript, and backing-store size is the only lever on
  it. Shallower and slower to engage than the swirl's, because this canvas
  carries pixel-art dancers that soften visibly, and it resizes only the backing
  store — the full resize reseeds every particle layer, which would make a
  frame-rate dip announce itself as the starfield reshuffling.

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
