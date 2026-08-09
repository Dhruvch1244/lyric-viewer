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
- **Stubbed, needs native implementation**: `src/sources/AppleMusicSource.ts`
  and `src/sources/SpotifySource.ts` define the JS-side contract for reading
  now-playing state from Apple Music (MusicKit) and Spotify (App Remote),
  but the native Swift bridge modules they call
  (`NativeModules.MusicKitBridge`, `NativeModules.SpotifyAppRemoteBridge`)
  don't exist yet. Each file's header comment describes exactly what that
  native module needs to expose.
- **Not started**: the Skia-based visual system (starfield, glow, drop
  flash, word-focus gradient, pixel-art dancers — see
  `src/renderer/renderer.js` and `sprites.js` in the repo root for what
  Phase 2 needs to match) and the on-device AI integration (Phase 3).

## Why this needs a Mac

This scaffold was built in a Linux container with no Xcode, no iOS
Simulator, and no physical iPhone — none of which exist for Linux. To go
further:

```sh
npm install                 # from the repo root (npm workspaces)
cd packages/mobile
npx expo prebuild -p ios    # generates the ios/ Xcode project
```

Then, in Xcode on a Mac:

1. Implement `MusicKitBridge.swift` per the contract in
   `src/sources/AppleMusicSource.ts`.
2. Register a Spotify Developer app and implement
   `SpotifyAppRemoteBridge.swift` per the contract in
   `src/sources/SpotifySource.ts`, linking `SpotifyiOS.xcframework`.
3. `npm run ios` (or open `ios/*.xcworkspace` directly) to build and run on
   a simulator or device.

## Security note on LLM credentials

Do not embed a Gemini/Claude API key directly in the mobile app the way the
Electron app reads one from an environment variable — a key shipped inside
an app binary is extractable. Phase 3's on-device-first design sidesteps
this for the common case (Apple's on-device models need no key at all); the
cloud fallback should go through a small backend proxy that holds the real
key, not a key embedded in the client.
