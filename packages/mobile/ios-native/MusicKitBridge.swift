import Foundation
import MediaPlayer
import React

/// Reads the Music app's now-playing state via `MPMusicPlayerController.systemMusicPlayer`
/// — this reflects whatever the Music app is actually playing app-wide, which
/// is the same "read the real system state" idea as Windows' SMTC, just for
/// this one specific app rather than any app (see NowPlayingSource.ts for why
/// there's no universal equivalent on iOS).
///
/// Matches the JS-side contract in
/// packages/mobile/src/sources/AppleMusicSource.ts: isAuthorized,
/// requestAuthorization, startObserving, stopObserving, emitting a
/// "nowPlaying" event shaped like NowPlayingSample (minus sourceApp, which
/// the JS side fills in).
///
/// NOT compiled/tested — written in a Linux environment with no Xcode.
/// Verify against Apple's MediaPlayer framework docs and fix on first build.
@objc(MusicKitBridge)
class MusicKitBridge: RCTEventEmitter {
  private let player = MPMusicPlayerController.systemMusicPlayer
  private var observing = false

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return ["nowPlaying"]
  }

  @objc(isAuthorized:rejecter:)
  func isAuthorized(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(MPMediaLibrary.authorizationStatus() == .authorized)
  }

  @objc(requestAuthorization:rejecter:)
  func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    MPMediaLibrary.requestAuthorization { status in
      DispatchQueue.main.async {
        resolve(status == .authorized)
      }
    }
  }

  @objc
  func startObserving() {
    guard !observing else { return }
    observing = true
    player.beginGeneratingPlaybackNotifications()
    NotificationCenter.default.addObserver(
      self, selector: #selector(emitState),
      name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player)
    NotificationCenter.default.addObserver(
      self, selector: #selector(emitState),
      name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player)
    emitState()
  }

  @objc
  func stopObserving() {
    guard observing else { return }
    observing = false
    NotificationCenter.default.removeObserver(self)
    player.endGeneratingPlaybackNotifications()
  }

  @objc
  private func emitState() {
    guard let item = player.nowPlayingItem else {
      sendEvent(withName: "nowPlaying", body: [
        "title": "", "artist": "", "durationMs": 0, "positionMs": 0, "status": "Stopped",
      ])
      return
    }

    let status: String
    switch player.playbackState {
    case .playing: status = "Playing"
    case .paused: status = "Paused"
    default: status = "Stopped"
    }

    sendEvent(withName: "nowPlaying", body: [
      "title": item.title ?? "",
      "artist": item.artist ?? "",
      "durationMs": Int(item.playbackDuration * 1000),
      "positionMs": Int(player.currentPlaybackTime * 1000),
      "status": status,
    ])
  }

  deinit {
    if observing {
      NotificationCenter.default.removeObserver(self)
      player.endGeneratingPlaybackNotifications()
    }
  }
}
