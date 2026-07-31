// Screen capture via ScreenCaptureKit.
//
// Why ScreenCaptureKit and not CoreGraphics: CGDisplayCreateImage and
// CGWindowListCreateImage are marked SCREEN_CAPTURE_OBSOLETE(…,14.4,15.0) in the
// current SDK — they are not merely deprecated, they stop returning real content
// on macOS 15+. ScreenCaptureKit is the only supported path.
//
// Why a long-lived SCStream and not SCScreenshotManager: this feeds a video
// stream. A per-frame SCScreenshotManager.captureImage call re-negotiates with
// WindowServer every time and costs on the order of 100 ms, which caps the frame
// rate near 8 fps before any encoding. A running SCStream hands us frames as
// they change, so `capture` is just "take the newest surface and encode it".
// The tradeoff is that the first capture after start must wait for the first
// frame to arrive, and that a stream holds a small amount of GPU memory per
// display for as long as the server runs.
//
// Cursor compositing is done by ScreenCaptureKit itself (`showsCursor`), which
// is more correct than drawing it ourselves — it gets the right cursor image,
// hotspot and Retina scale for free.

import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// One running capture stream for one display, holding only the newest frame.
/// Older frames are dropped on the floor: a remote viewer only ever wants the
/// latest picture, never a backlog.
final class DisplayStream: NSObject, SCStreamOutput, SCStreamDelegate {
    private static let queueDepth = 5
    private static let maxFramesPerSecond: Int32 = 30

    let displayID: CGDirectDisplayID

    private let lock = NSLock()
    private let sampleQueue: DispatchQueue
    private var stream: SCStream?
    private var latest: CMSampleBuffer?
    private var pixelSize: (width: Int, height: Int) = (0, 0)
    private var stopReason: String?
    private var frameArrived = DispatchSemaphore(value: 0)
    private var sawFirstFrame = false

    init(displayID: CGDirectDisplayID) {
        self.displayID = displayID
        self.sampleQueue = DispatchQueue(label: "tether.capture.\(displayID)", qos: .userInitiated)
        super.init()
    }

    var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return stream != nil
    }

    /// True when the stream is configured for a different resolution than the
    /// display currently reports (the user changed resolution or scaling).
    func isStale(for geometry: DisplayGeometry) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return pixelSize.width != geometry.pixelWidth || pixelSize.height != geometry.pixelHeight
    }

    func start(display: SCDisplay, geometry: DisplayGeometry, timeout: TimeInterval) throws {
        let config = SCStreamConfiguration()
        config.width = max(1, geometry.pixelWidth)
        config.height = max(1, geometry.pixelHeight)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.scalesToFit = false
        config.queueDepth = DisplayStream.queueDepth
        config.minimumFrameInterval = CMTime(value: 1, timescale: DisplayStream.maxFramesPerSecond)
        if #available(macOS 14.0, *) { config.captureResolution = .best }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            throw HostError(.capture, "could not attach capture output: \(error.localizedDescription)")
        }

        lock.lock()
        self.stream = stream
        self.pixelSize = (config.width, config.height)
        self.stopReason = nil
        self.sawFirstFrame = false
        self.latest = nil
        self.frameArrived = DispatchSemaphore(value: 0)
        lock.unlock()

        try runBlocking(timeout: timeout, label: "start capture") { done in
            stream.startCapture { error in done(error) }
        }
    }

    func stop() {
        lock.lock()
        let running = stream
        stream = nil
        latest = nil
        pixelSize = (0, 0)
        lock.unlock()
        running?.stopCapture(completionHandler: { _ in })
    }

    /// Newest complete frame as a CGImage, waiting up to `timeout` for the very
    /// first one. Subsequent calls return immediately from the cache.
    func latestImage(timeout: TimeInterval) throws -> CGImage {
        if let existing = copyLatest() { return try Self.image(from: existing) }
        if let reason = currentStopReason() {
            throw HostError(.capture, "capture stream stopped: \(reason)")
        }
        guard frameArrived.wait(timeout: .now() + timeout) == .success else {
            if let reason = currentStopReason() {
                throw HostError(.capture, "capture stream stopped: \(reason)")
            }
            throw HostError(.capture, "timed out after \(Int(timeout * 1000)) ms waiting for the first frame from display \(displayID)")
        }
        guard let buffer = copyLatest() else {
            throw HostError(.capture, "capture stream signalled a frame but produced none")
        }
        return try Self.image(from: buffer)
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), Self.isComplete(sampleBuffer) else { return }
        lock.lock()
        latest = sampleBuffer
        let first = !sawFirstFrame
        sawFirstFrame = true
        lock.unlock()
        if first { frameArrived.signal() }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopReason = error.localizedDescription
        self.stream = nil
        lock.unlock()
        frameArrived.signal()
    }

    // MARK: - Internals

    private func copyLatest() -> CMSampleBuffer? {
        lock.lock(); defer { lock.unlock() }
        return latest
    }

    private func currentStopReason() -> String? {
        lock.lock(); defer { lock.unlock() }
        return stopReason
    }

    private static func isComplete(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw)
        else { return false }
        return status == .complete
    }

    private static func image(from sampleBuffer: CMSampleBuffer) throws -> CGImage {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            throw HostError(.capture, "capture frame had no image buffer")
        }
        return try ImageOutput.cgImage(from: pixelBuffer)
    }
}

/// Owns one `DisplayStream` per display and resolves SCDisplay handles.
final class CaptureEngine {
    private static let shareableContentTimeout: TimeInterval = 5
    private static let startTimeout: TimeInterval = 5
    private static let firstFrameTimeout: TimeInterval = 3

    private var streams: [CGDirectDisplayID: DisplayStream] = [:]

    /// Latest frame for each requested display, in the order given. Streams are
    /// started lazily and restarted when the display resolution changes.
    func frames(for geometries: [DisplayGeometry]) throws -> [(geometry: DisplayGeometry, image: CGImage)] {
        try Permissions.require(.screenRecording)
        let needsLookup = geometries.contains { geometry in
            guard let stream = streams[geometry.id] else { return true }
            return !stream.isRunning || stream.isStale(for: geometry)
        }
        let available = needsLookup ? try shareableDisplays() : [:]

        return try geometries.map { geometry in
            let stream = try ensureStream(for: geometry, available: available)
            return (geometry, try stream.latestImage(timeout: Self.firstFrameTimeout))
        }
    }

    func stopAll() {
        streams.values.forEach { $0.stop() }
        streams.removeAll()
    }

    private func ensureStream(for geometry: DisplayGeometry, available: [CGDirectDisplayID: SCDisplay]) throws -> DisplayStream {
        if let existing = streams[geometry.id], existing.isRunning, !existing.isStale(for: geometry) {
            return existing
        }
        streams[geometry.id]?.stop()
        guard let scDisplay = available[geometry.id] else {
            throw HostError(.display, "display \(geometry.id) is no longer shareable")
        }
        let stream = DisplayStream(displayID: geometry.id)
        try stream.start(display: scDisplay, geometry: geometry, timeout: Self.startTimeout)
        streams[geometry.id] = stream
        return stream
    }

    private func shareableDisplays() throws -> [CGDirectDisplayID: SCDisplay] {
        var found: [SCDisplay] = []
        try runBlocking(timeout: Self.shareableContentTimeout, label: "enumerate shareable content") { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
                if let content { found = content.displays }
                done(error)
            }
        }
        guard !found.isEmpty else {
            throw HostError(.screenPermission, Permissions.denied(.screenRecording).message,
                            details: Permissions.denied(.screenRecording).details)
        }
        return Dictionary(uniqueKeysWithValues: found.map { ($0.displayID, $0) })
    }
}

/// Bridges a completion-handler API into the synchronous command loop, mapping
/// both failure and hang into a `HostError` instead of blocking forever.
/// ScreenCaptureKit reports a missing Screen Recording grant as an
/// `SCStreamError` here, which we translate into the actionable permission error.
func runBlocking(timeout: TimeInterval, label: String, _ body: (@escaping (Error?) -> Void) -> Void) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var failure: Error?
    var signalled = false
    let lock = NSLock()
    body { error in
        lock.lock()
        guard !signalled else { lock.unlock(); return }
        signalled = true
        failure = error
        lock.unlock()
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + timeout) == .success else {
        throw HostError(.capture, "timed out after \(Int(timeout * 1000)) ms trying to \(label)")
    }
    lock.lock()
    let error = failure
    lock.unlock()
    guard let error else { return }
    throw translate(error, whileTryingTo: label)
}

private func translate(_ error: Error, whileTryingTo label: String) -> HostError {
    let ns = error as NSError
    if ns.domain == SCStreamErrorDomain, isPermissionFailure(ns.code) {
        let denied = Permissions.denied(.screenRecording)
        return HostError(.screenPermission, denied.message,
                         details: denied.details.merging(["osStatus": ns.code]) { current, _ in current })
    }
    return HostError(.capture, "failed to \(label): \(ns.localizedDescription) (\(ns.domain) \(ns.code))",
                     details: ["domain": ns.domain, "osStatus": ns.code])
}

/// SCStreamErrorUserDeclined / missing-entitlement codes. Compared numerically
/// because the named constants are not exported to Swift as a usable enum.
private func isPermissionFailure(_ code: Int) -> Bool {
    let userDeclined = -3801
    let missingEntitlements = -3802
    return code == userDeclined || code == missingEntitlements
}
