import Foundation
import ObjectiveC.runtime

/// Reads a WebSocket binary message out of React Native's blob store.
///
/// With `socket.binaryType = 'blob'`, React Native keeps each binary message
/// as `NSData` in `RCTBlobManager` and hands JavaScript only `{blobId, offset,
/// size}`. Resolving that handle here is what keeps a video frame off the JS
/// thread entirely: the bytes go from the socket's native side to the decoder
/// without ever being base64-encoded or copied into a JS ArrayBuffer.
///
/// Reached through the Objective-C runtime rather than an import, the same way
/// BelayPinModule reaches React's HTTP handler: the blob manager lives in a pod
/// (React-RCTBlob) this module does not otherwise depend on, and the bridge
/// object in the new architecture is an `NSProxy`, which Swift cannot message
/// through `perform(_:)`. `objc_msgSend` works for both.
enum BlobBridge {
    private typealias ClassSend = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
    private typealias ObjectSend = @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<AnyObject>?
    private typealias ResolveSend = @convention(c) (AnyObject, Selector, NSString, Int, Int) -> Unmanaged<NSData>?
    private typealias RemoveSend = @convention(c) (AnyObject, Selector, NSString) -> Void

    private static let msgSend = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend")

    private static let lock = NSLock()
    private static var cachedManager: AnyObject?

    /// The live `RCTBlobManager`, or nil when React has not created one yet.
    private static func manager() -> AnyObject? {
        lock.lock(); defer { lock.unlock() }
        if let cachedManager { return cachedManager }
        guard let msgSend,
              let bridgeClass = NSClassFromString("RCTBridge"),
              let blobClass = NSClassFromString("RCTBlobManager") else { return nil }
        let classSend = unsafeBitCast(msgSend, to: ClassSend.self)
        guard let bridge = classSend(bridgeClass, NSSelectorFromString("currentBridge"))?.takeUnretainedValue()
        else { return nil }
        let objectSend = unsafeBitCast(msgSend, to: ObjectSend.self)
        let found = objectSend(bridge, NSSelectorFromString("moduleForClass:"), blobClass)?.takeUnretainedValue()
        NSLog("[BelayStream] blob manager via %@: %@", String(describing: type(of: bridge)), found == nil ? "not found" : "ok")
        cachedManager = found
        return found
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
