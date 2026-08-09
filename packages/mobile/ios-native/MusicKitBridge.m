#import <React/RCTBridgeModule.h>

// Legacy RN bridge declaration exposing the Swift MusicKitBridge class's
// @objc methods to JS as NativeModules.MusicKitBridge.
@interface RCT_EXTERN_MODULE(MusicKitBridge, NSObject)

RCT_EXTERN_METHOD(isAuthorized:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(startObserving)
RCT_EXTERN_METHOD(stopObserving)

@end
