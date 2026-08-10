#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Legacy RN bridge declaration exposing the Swift MusicKitBridge class's
// @objc methods to JS as NativeModules.MusicKitBridge. The superclass is
// RCTEventEmitter (not NSObject) so addListener/removeListeners and the
// startObserving/stopObserving lifecycle are inherited correctly.
//
// Only isAuthorized/requestAuthorization are bridged here; observation is
// driven by RCTEventEmitter's listener lifecycle (see the Swift file's
// startObserving/stopObserving overrides), so there are no explicit
// start/stop methods to declare.
@interface RCT_EXTERN_MODULE(MusicKitBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(isAuthorized:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
