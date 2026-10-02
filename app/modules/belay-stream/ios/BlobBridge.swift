import Foundation
import ObjectiveC.runtime
import UIKit

/// Reads a WebSocket binary message out of React Native's blob store.
///
/// With `socket.binaryType = 'blob'`, React Native keeps each binary message
/// as `NSData` in `RCTBlobManager` and hands JavaScript only `{blobId, offset,
/// size}`. Resolving that handle here is what keeps a video frame off the JS
/// thread entirely: the bytes go from the socket's native side to the decoder
/// without ever being base64-encoded or copied into a JS ArrayBuffer.
///
/// Finding the blob manager: the prebuilt React.framework that Expo ships is
/// compiled with the legacy bridge removed, so `+[RCTBridge currentBridge]`
/// is a stub returning nil (measured on device). The bridgeless object graph
/// is reached instead from the app delegate — Expo's template keeps the
/// `RCTReactNativeFactory` in a stored property named `reactNativeFactory`,
/// read by reflection — and then through plain Objective-C properties:
/// `rootViewFactory.reactHost.moduleRegistry`, whose `moduleForName:` gives
/// the `RCTBlobManager`. Everything is looked up by name, like
/// BelayPinModule reaches React's HTTP handler: the blob manager lives in a
/// pod this module does not otherwise depend on.
enum BlobBridge {
    private typealias NameSend = @convention(c) (AnyObject, Selector, UnsafePointer<CChar>) -> Unmanaged<AnyObject>?
    private typealias ResolveSend = @convention(c) (AnyObject, Selector, NSString, Int, Int) -> Unmanaged<NSData>?
    private typealias RemoveSend = @convention(c) (AnyObject, Selector, NSString) -> Void

    private static let msgSend = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend")

    private static let lock = NSLock()
    private static var cachedManager: AnyObject?

    /// The live `RCTBlobManager`, or nil when React has not created one yet.
    static func manager() -> AnyObject? {
        lock.lock(); defer { lock.unlock() }
        if let cachedManager { return cachedManager }
        let found = lookUpManager()
        cachedManager = found
        return found
    }

    private static func lookUpManager() -> AnyObject? {
        guard let msgSend else { return nil }
        guard let delegate = onMain({ UIApplication.shared.delegate }) else {
            NSLog("[BelayStream] blob manager: no app delegate")
            return nil
        }
        guard let factory = Mirror(reflecting: delegate).children
            .first(where: { $0.label == "reactNativeFactory" })
            .flatMap({ $0.value as? NSObject }) else {
            NSLog("[BelayStream] blob manager: %@ has no reactNativeFactory", String(describing: type(of: delegate)))
            return nil
        }
        guard let registry = factory.value(forKeyPath: "rootViewFactory.reactHost.moduleRegistry") as AnyObject? else {
            NSLog("[BelayStream] blob manager: no reactHost/moduleRegistry on %@", String(describing: type(of: factory)))
            return nil
        }
        let byName = unsafeBitCast(msgSend, to: NameSend.self)
        let found = "BlobModule".withCString { byName(registry, NSSelectorFromString("moduleForName:"), $0) }?
            .takeUnretainedValue()
        NSLog("[BelayStream] blob manager via %@: %@", String(describing: type(of: registry)), found == nil ? "not found" : "ok")
        return found
    }

    /// `UIApplication.delegate` is main-thread state; feedH264 runs on the JS thread.
    private static func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    /// The bytes behind a handle, released from the store in the same step.
    /// Nil when the store has no such blob (already released, or a handle from
    /// a different React instance).
    static func take(blobId: String, offset: Int, size: Int) -> Data? {
        guard let msgSend, let manager = manager() else { return nil }
        let resolve = unsafeBitCast(msgSend, to: ResolveSend.self)
        let data = resolve(manager, NSSelectorFromString("resolve:offset:size:"), blobId as NSString, offset, size)?
            .takeUnretainedValue()
        let remove = unsafeBitCast(msgSend, to: RemoveSend.self)
        remove(manager, NSSelectorFromString("remove:"), blobId as NSString)
        guard let data, data.length > 0 else { return nil }
        return data as Data
    }
}
