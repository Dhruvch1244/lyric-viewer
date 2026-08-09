import Foundation
import SpotifyiOS
import React

/// Bridges Spotify's App Remote SDK (SPTAppRemote) to JS.
///
/// The OAuth callback is handled entirely from the JS side (see
/// src/sources/SpotifySource.ts's use of React Native's `Linking` module) —
/// Expo's default AppDelegate already forwards every `openURL` call to JS,
/// so this native module doesn't need any AppDelegate changes. JS extracts
/// the access token from the redirect URL and passes it in via
/// `setAccessToken`, which is the piece this file owns.
///
/// Matches the JS-side contract in
/// packages/mobile/src/sources/SpotifySource.ts: isConnected, connect,
/// disconnect, startObserving, stopObserving, emitting a "nowPlaying" event.
///
/// NOT compiled/tested — written in a Linux environment with no Xcode and no
/// access to the SpotifyiOS.xcframework binary. This is the highest-risk
/// file in the whole port: verify closely against Spotify's iOS SDK sample
/// app (github.com/spotify/ios-sdk) on first real build, especially the
/// SPTAppRemoteDelegate / SPTAppRemotePlayerStateDelegate method signatures,
/// which do shift between SDK versions.
///
/// REQUIRES a manual, one-time Xcode step this file/plugin cannot do:
/// download SpotifyiOS.xcframework from
/// https://github.com/spotify/ios-sdk/releases and embed it in the Xcode
/// project (Frameworks, Libraries, and Embedded Content → Embed & Sign).
/// See packages/mobile/README.md.
@objc(SpotifyAppRemoteBridge)
class SpotifyAppRemoteBridge: RCTEventEmitter {
  private var connectResolve: RCTPromiseResolveBlock?
  private var observing = false

  private lazy var configuration: SPTConfiguration = {
    let clientID = Bundle.main.object(forInfoDictionaryKey: "SpotifyClientID") as? String ?? ""
    let redirectURLString = Bundle.main.object(forInfoDictionaryKey: "SpotifyRedirectURL") as? String
      ?? "lyricplayer://spotify-callback"
    return SPTConfiguration(clientID: clientID, redirectURL: URL(string: redirectURLString)!)
  }()

  private lazy var appRemote: SPTAppRemote = {
    let remote = SPTAppRemote(configuration: configuration, logLevel: .debug)
    remote.delegate = self
    return remote
  }()

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["nowPlaying"] }

  @objc(isConnected:rejecter:)
  func isConnected(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(appRemote.isConnected)
  }

  /// Kicks off the Spotify app-to-app auth flow (opens the Spotify app via
  /// URL scheme). The access token comes back through the redirect URL,
  /// handled JS-side, which then calls `setAccessToken`.
  @objc(connect:rejecter:)
  func connect(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    connectResolve = resolve
    appRemote.authorizeAndPlayURI("")
  }

  @objc
  func disconnect() {
    appRemote.disconnect()
  }

  @objc
  func startObserving() {
    observing = true
  }

  @objc
  func stopObserving() {
    observing = false
  }

  /// Called from JS (SpotifySource.ts) once it has parsed an access token
  /// out of the OAuth redirect URL.
  @objc(setAccessToken:)
  func setAccessToken(_ token: String) {
    appRemote.connectionParameters.accessToken = token
    appRemote.connect()
  }
}

extension SpotifyAppRemoteBridge: SPTAppRemoteDelegate {
  func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
    connectResolve?(true)
    connectResolve = nil
    appRemote.playerAPI?.delegate = self
    appRemote.playerAPI?.subscribe(toPlayerState: { _, error in
      if let error = error {
        print("[SpotifyAppRemoteBridge] subscribe error: \(error)")
      }
    })
  }

  func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
    connectResolve?(false)
    connectResolve = nil
  }

  func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {}
}

extension SpotifyAppRemoteBridge: SPTAppRemotePlayerStateDelegate {
  func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) {
    guard observing else { return }
    sendEvent(withName: "nowPlaying", body: [
      "title": playerState.track.name,
      "artist": playerState.track.artist.name,
      "durationMs": playerState.track.duration,
      "positionMs": playerState.playbackPosition,
      "status": playerState.isPaused ? "Paused" : "Playing",
    ])
  }
}
