# Lyric Player — iOS

Cross-platform (iOS-first) port of the Windows Lyric Player, built with
Expo/React Native + `@shopify/react-native-skia`, reusing
`@lyric-viewer/core` for lyric matching, sync/interpolation, word-timing, and
LLM-prompt logic.

See `/root/.claude/plans/foamy-prancing-karp.md` (or ask for the plan again)
for the full phased plan. This package currently covers **Phase 1's
scaffold**: the detection-source architecture and a minimal text player
shell, not yet the full visual system (Phase 2) or on-device AI (Phase 3).

## Current state — what's real vs. stubbed

- **Real, shared, and parity-tested**: everything imported from
  `@lyric-viewer/core` — lyric matching against LRCLIB, LRC parsing, Indic
  script detection, position-estimation math, word-timing distribution, and
  the palette/sentiment math. These have automated parity checks against the
  original Windows app's behavior (see the repo's Phase 0 work).
- **Written, but not compiled or run yet**: the native Swift bridges,
  `ios-native/MusicKitBridge.swift` (reads Apple Music's now-playing state
  via `MPMusicPlayerController.systemMusicPlayer`) and
  `ios-native/SpotifyAppRemoteBridge.swift` (wraps Spotify's App Remote SDK).
  An Expo config plugin (`plugins/withNativeSources.js`) copies them into the
  generated Xcode project and registers Info.plist entries automatically
  during `expo prebuild` / EAS Build. This was all written and reasoned about
  from Apple's/Spotify's documented APIs in a Linux container with no Xcode
  — there has been **no compiler feedback on any of it yet**. Expect to fix
  real build errors on the first EAS Build; each file's header comment flags
  what's riskiest (Spotify's SDK method signatures shift between versions,
  in particular).
- **Not started**: the Skia-based visual system (starfield, glow, drop
  flash, word-focus gradient, pixel-art dancers — see
  `src/renderer/renderer.js` and `sprites.js` in the repo root for what
  Phase 2 needs to match) and the on-device AI integration (Phase 3).

## Getting a build onto your iPhone (no Mac required)

Building doesn't need a local Mac — [EAS Build](https://docs.expo.dev/build/introduction/)
compiles iOS apps on Expo's hosted macOS infrastructure. Installing the
result on your iPhone without a Mac uses a free Apple ID + a sideloading
tool run from a Windows PC. Every step below is something *you* need to do
— none of it can be done from this session.

### 1. One-time account setup

- **Expo account** (free): sign up at [expo.dev](https://expo.dev), then on
  your Windows PC (or any machine): `npm install -g eas-cli && eas login`.
- **Spotify Developer app** (free, only needed for the Spotify source): register
  one at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
  Set the redirect URI to `lyricplayer://spotify-callback` (matches
  `app.json`'s `scheme` + what `SpotifyAppRemoteBridge.swift` expects). Copy
  the **Client ID** — you'll paste it into
  `plugins/withNativeSources.js` (replace `REPLACE_WITH_SPOTIFY_CLIENT_ID`)
  before building, or wire it through an EAS secret if you'd rather not
  commit it.
- **Apple ID**: any normal iCloud account works — no paid Apple Developer
  Program enrollment needed for this path.

### 2. One manual Xcode-only step — actually, skip it for now

Normally you'd need to manually embed `SpotifyiOS.xcframework` in Xcode —
`SpotifyAppRemoteBridge.swift` won't compile without it. Since there's no
Mac in this path, **build Apple-Music-only first**:

```sh
SKIP_SPOTIFY_NATIVE=1 eas build --platform ios --profile preview
```

This excludes the Spotify native files from the build entirely (see
`plugins/withNativeSources.js`); the JS side already handles a missing
Spotify module gracefully (`SpotifySource.isAvailable()` just returns
`false`, so the app falls back to Apple Music only). Come back to Spotify
once you have Mac access for that one embedding step, or ask someone with a
Mac to do it and commit the resulting Xcode project changes — then drop
`SKIP_SPOTIFY_NATIVE`.

### 3. Build a real-device .ipa with EAS

From `packages/mobile`, after setting a unique `bundleIdentifier` in
`app.json` (the placeholder `com.example.lyricplayer` needs to be something
only you use):

```sh
eas device:create        # registers your iPhone's UDID with Apple — follow the prompts
eas build --platform ios --profile preview
```

EAS will prompt to log in with your Apple ID and can generate a **free
development signing certificate** automatically — no paid account needed.
This is the same "free Apple ID" signing path Xcode itself uses, just
without a local Xcode. When the build finishes, EAS gives you a download
link for the `.ipa`.

### 4. Sideload the .ipa with Sideloadly (Windows)

1. Install [Sideloadly](https://sideloadly.io/) and Apple's "Apple Devices"
   app (or iTunes) on your Windows PC, and connect your iPhone via USB.
2. Open Sideloadly, drag in the `.ipa` you downloaded from EAS, sign in with
   your Apple ID when prompted, and sideload.
3. On the iPhone: **Settings → General → VPN & Device Management** → trust
   your Apple ID's developer profile the first time you launch the app.

**This install expires in ~7 days** — a free Apple ID limitation, not
specific to this app. Re-run Sideloadly (or use AltStore's background
Wi-Fi refresh) to renew it. This is the tradeoff of the no-Mac, no-$99/year
path; switching to a paid Apple Developer Program + TestFlight later removes
the expiry entirely.

## Security note on LLM credentials

Do not embed a Gemini/Claude API key directly in the mobile app the way the
Electron app reads one from an environment variable — a key shipped inside
an app binary is extractable. Phase 3's on-device-first design sidesteps
this for the common case (Apple's on-device models need no key at all); the
cloud fallback should go through a small backend proxy that holds the real
key, not a key embedded in the client.
