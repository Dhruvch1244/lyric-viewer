#import <React/RCTBridgeModule.h>

// Legacy RN bridge declaration exposing the Swift SpotifyAppRemoteBridge
// class's @objc methods to JS as NativeModules.SpotifyAppRemoteBridge.
@interface RCT_EXTERN_MODULE(SpotifyAppRemoteBridge, NSObject)

RCT_EXTERN_METHOD(isConnected:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(connect:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(disconnect)
RCT_EXTERN_METHOD(startObserving)
RCT_EXTERN_METHOD(stopObserving)
RCT_EXTERN_METHOD(setAccessToken:(NSString *)token)

@end
