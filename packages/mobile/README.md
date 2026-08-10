# Lyric Player — iOS

Cross-platform (iOS-first) port of the Windows Lyric Player, built with
Expo/React Native + `@shopify/react-native-skia`, reusing
`@lyric-viewer/core` for lyric matching, sync/interpolation, word-timing, and
LLM-prompt logic.

See `/root/.claude/plans/foamy-prancing-karp.md` (or ask for the plan again)
for the full phased plan.

## Current state — what's real vs. stubbed vs. simplified

- **Real, shared, and parity-tested**: everything imported from
  `@lyric-viewer/core` — lyric matching against LRCLIB, LRC parsing, Indic
  script detection, position-estimation math, word-timing distribution, and
  the palette/sentiment math. These have automated parity checks against the
  original Windows app's behavior (see the repo's Phase 0 work).
- **Written, but not compiled or run yet**: the native Swift bridge
  `ios-native/MusicKitBridge.swift`, which reads Apple Music's now-playing
  state via `MPMusicPlayerController.systemMusicPlayer`. An Expo config plugin
  (`plugins/withNativeSources.js`) copies it into the generated Xcode project
  and registers it on the app target automatically during `expo prebuild` /
  EAS Build. This was written and reasoned about from Apple's documented
  MediaPlayer APIs in a Linux container with no Xcode — there has been **no
  compiler feedback on it yet**, so expect to fix real build errors on the
  first EAS Build. **Apple Music is the only supported source.** The Spotify
  bridge (`ios-native/SpotifyAppRemoteBridge.*`, `src/sources/SpotifySource.ts`)
  remains in the tree but is dormant: the config plugin no longer compiles it
  and `useLyricEngine` no longer registers it, because it needs the manually
  embedded `SpotifyiOS.xcframework` (a Mac-only step). Revive it by re-adding
  those files to `NATIVE_FILES` in the plugin and to the arbiter's source list.
- **Written and type-checked, but not visually run**: the Phase 2 visual
  system — `src/visuals/Starfield.tsx` (Skia canvas: per-track colour wash,
  drifting glow orbs, twinkling starfield, vignette, build-up bloom, drop
  flash + shockwave ring) and `src/visuals/LyricColumn.tsx` (active-line
  centering, distance-based fade, cadence-adaptive scroll speed, per-word
  highlight), tied together by `src/useLyricEngine.ts`. `tsc --noEmit` passes
  clean against the real `@shopify/react-native-skia` /
  `react-native-reanimated` type declarations, which is a real signal (it
  means every API call used actually exists with the shape this code
  expects) — but nothing has been rendered on a device or simulator, so
  visual bugs (timing feel, layout, colour) are expected on first run.
  **Deliberately simplified or not ported** from
  `src/renderer/renderer.js`/`sprites.js` (documented in each file's header,
  not silently dropped): aurora bands, bokeh, the equalizer, light rays,
  ripples, confetti, shooting stars, the pixel-art artist dancers, the pool
  of 24 per-word entrance animations (down to one), and true gradient-fill
  word text (down to a colour+scale highlight). These are lower-priority
  per the original phased plan ("scrolling column + word focus" and
  "starfield/glow + drop flash" were called out as priorities 1-2; dancers
  as priority 3, decorative particle layers weren't prioritized at all).
- **Not started**: on-device AI (Phase 3) — sentiment-driven palette,
  on-device transliteration/translation. Every track currently uses the
  instant hash palette only, same as the Windows app before an LLM key is
  configured.

## Quick preview with Expo Go (no build required)

For the fastest way to see the visuals (not real Apple Music detection —
Expo Go can't load the custom native Swift module for that; see below):
install the free **Expo Go** app from the App Store, then from
`packages/mobile` run `npm run start:go` and scan the QR code **using Expo
Go's own in-app scanner**, not the regular Camera/Photos app — scanning with
the plain Camera app can open the URL in Safari instead of handing off to
Expo Go, which fails with a `CommandError: Must specify "expo-platform"
header` error.

In Expo Go, `MockSource` (`src/sources/MockSource.ts`) automatically stands
in for the absent native bridge and plays a fixed demo track (edit
`DEMO_TRACK` to change it), so you see the full pipeline — LRCLIB lyric
lookup, palette, scrolling lyrics, drops/build-ups — with a `· demo` tag in
the header. It reports available only when the native bridge is missing, so
it disappears automatically in the real build below.

**Expo Go only ever supports the single latest SDK version** (there's no way
to install an older Expo Go build for iOS) — this project tracks that SDK
version for exactly this reason (currently SDK 54, React Native 0.81,
React 19). If you ever see "Project is incompatible with this version of
Expo Go," it means Expo Go itself has moved to a newer SDK than this project
targets — re-run `npx expo install expo@latest && npx expo install --fix`
from `packages/mobile` to catch up (this is exactly what fixed it going from
SDK 52 → 54; `react-native-reanimated` jumped a major version in the process
and pulled in a new required peer, `react-native-worklets` — watch for
`npm error ERESOLVE` during that fix and add whatever peer it's asking for).

For the full app with real Apple Music detection, you need the custom
standalone build below — Expo Go's fixed set of bundled native modules
doesn't include `MusicKitBridge`.

## Getting a build onto your iPhone (no Mac required)

Building doesn't need a local Mac — [EAS Build](https://docs.expo.dev/build/introduction/)
compiles iOS apps on Expo's hosted macOS infrastructure. Installing the
result on your iPhone without a Mac uses a free Apple ID + a sideloading
tool run from a Windows PC. Every step below is something *you* need to do
— none of it can be done from this session.

### 1. One-time account setup

- **Expo account** (free): sign up at [expo.dev](https://expo.dev), then on
  your Windows PC (or any machine): `npm install -g eas-cli && eas login`.
- **Apple ID**: any normal iCloud account works — no paid Apple Developer
  Program enrollment needed for this path.

No Spotify Developer app and no `SpotifyiOS.xcframework` embedding are
needed — this build is Apple Music only, and `MusicKitBridge` uses just the
system MediaPlayer framework (already part of iOS). The one required Info.plist
key, `NSAppleMusicUsageDescription`, is already set in `app.json`.

### 2. Build a real-device .ipa with EAS

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

### 3. Sideload the .ipa with Sideloadly (Windows)

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
