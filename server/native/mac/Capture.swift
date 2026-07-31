// Screen capture via ScreenCaptureKit.
//
// Why ScreenCaptureKit and not CoreGraphics: CGDisplayCreateImage and
// CGWindowListCreateImage are marked SCREEN_CAPTURE_OBSOLETE(…,14.4,15.0) in the
// current SDK — they are not merely deprecated, they stop returning real content
// on macOS 15+. ScreenCaptureKit is the only supported path.
//
// Why a long-lived SCStream and not SCScreenshotManager: this feeds a video
// stream. A per-frame SCScreenshotManager.captureImage call re-negotiates with
// WindowServer every time, and that acquisition cost lands on every frame
// before any scaling or encoding has happened. A running SCStream instead hands
// us frames as they change, so `capture` is just "take the newest surface and
// encode it".
//
// Measured on this machine (Apple M3, macOS 26.3, 1710x1107 pt Retina display,
// load average ~17-25 — i.e. a busy machine, not a clean benchmark box), 15
// calls per configuration, times are end-to-end from the command loop:
//
//   SCScreenshotManager acquisition alone: p50 37-42 ms, worst case 135-152 ms
//   full `capture` round trip via SCStream (acquire + scale + JPEG + base64 +
//     JSON), 40 repetitions per point, three separate runs:
//       w=640  q=55  p50 22-38 ms
//       w=1024 q=55  p50 29-33 ms   (~30-34 fps of headroom)
//       w=1024 q=90  p50 29-33 ms
//       w=1280 q=55  p50 33-43 ms
//       w=1920 q=55  p50 34-73 ms
//     with occasional outliers to ~165 ms when the machine is contended.
//
// So the whole SCStream path costs about what a bare SCScreenshotManager
// acquisition costs, encoding included: the rationale holds, but treat these as
// a range on a loaded desktop rather than a guaranteed figure. Numbers move
// with screen content (JPEG cost tracks detail), display size and system load.
//
// The tradeoff is that the first capture after start must wait for the first
// frame to arrive (measured 34-35 ms for the frame itself, 160-310 ms for a
// full cold `capture`, well inside the 3 s timeout below), and that a stream
// holds a small amount of GPU memory per display for as long as it is alive.
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
    /// Monotonic arrival time of the newest frame, 0 when none has arrived yet.
    /// Monotonic (not wall clock) so a clock adjustment cannot fake staleness.
    private var lastFrameUptimeNanos: UInt64 = 0

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
        self.lastFrameUptimeNanos = 0
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
        lastFrameUptimeNanos = 0
        pixelSize = (0, 0)
        lock.unlock()
        running?.stopCapture(completionHandler: { _ in })
    }

    /// How long ago the newest frame arrived, or nil when none has yet.
    /// A large age is ambiguous on its own — see `CaptureEngine.frames`.
    var frameAge: TimeInterval? {
        lock.lock(); defer { lock.unlock() }
        guard lastFrameUptimeNanos != 0 else { return nil }
        return Self.secondsSince(lastFrameUptimeNanos)
    }

    /// Newest complete frame as a CGImage, waiting up to `timeout` for the very
    /// first one. Subsequent calls return immediately from the cache, along with
    /// how old that cached frame is so the caller can judge freshness.
    func latestImage(timeout: TimeInterval) throws -> (image: CGImage, age: TimeInterval) {
        if let existing = copyLatest() {
            return (try Self.image(from: existing.buffer), Self.secondsSince(existing.arrivedAt))
        }
        if let reason = currentStopReason() {
            throw HostError(.capture, "capture stream stopped: \(reason)")
        }
        guard currentSignal().wait(timeout: .now() + timeout) == .success else {
            if let reason = currentStopReason() {
                throw HostError(.capture, "capture stream stopped: \(reason)")
            }
            throw HostError(.capture, "timed out after \(Int(timeout * 1000)) ms waiting for the first frame from display \(displayID)")
        }
        guard let arrived = copyLatest() else {
            throw HostError(.capture, "capture stream signalled a frame but produced none")
        }
        return (try Self.image(from: arrived.buffer), Self.secondsSince(arrived.arrivedAt))
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), Self.isComplete(sampleBuffer) else { return }
        lock.lock()
        latest = sampleBuffer
        lastFrameUptimeNanos = DispatchTime.now().uptimeNanoseconds
        let first = !sawFirstFrame
        sawFirstFrame = true
        let signal = frameArrived
        lock.unlock()
        if first { signal.signal() }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopReason = error.localizedDescription
        self.stream = nil
        let signal = frameArrived
        lock.unlock()
        signal.signal()
    }

    // MARK: - Internals

    private func copyLatest() -> (buffer: CMSampleBuffer, arrivedAt: UInt64)? {
        lock.lock(); defer { lock.unlock() }
        guard let latest else { return nil }
        return (latest, lastFrameUptimeNanos)
    }

    /// The semaphore for the current stream generation. `start()` installs a
    /// fresh one under `lock`, so every read of it must take the lock too —
    /// otherwise a restart racing a wait is a data race.
    private func currentSignal() -> DispatchSemaphore {
        lock.lock(); defer { lock.unlock() }
        return frameArrived
    }

    private static func secondsSince(_ uptimeNanos: UInt64) -> TimeInterval {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now > uptimeNanos else { return 0 }
        return TimeInterval(now - uptimeNanos) / 1_000_000_000
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

    /// Frame age past which the reply is tagged `stale`. Purely advisory.
    /// Measured on an idle desktop (M3, macOS 26.3): ScreenCaptureKit delivers
    /// nothing at all while the screen does not change — 57 frames in 60 s,
    /// with a single gap of 29 s. So an old frame is emphatically *not* by
    /// itself evidence of a fault, and must never be reported as an error.
    static let staleFrameSeconds: TimeInterval = 2
    /// Frame age past which the stream is torn down and started again.
    ///
    /// Because an idle desktop and a wedged stream look identical from here
    /// (both are simply "no frames"), this does not try to tell them apart. It
    /// applies the one remedy that is correct for both: a restart always yields
    /// a frame — measured first-frame latency after start is 34-35 ms, and a
    /// full cold `capture` round trip is 160-310 ms — so a wedged stream is
    /// healed and an idle desktop is re-primed with a genuinely current image.
    /// If even a restarted stream produces nothing, `latestImage` raises an
    /// explicit timeout instead of serving an indefinitely frozen picture.
    ///
    /// 5 s bounds how old a served frame can be. The cost is one restart per
    /// 5 s of a completely motionless screen (~4% overhead while idle, none at
    /// all while anything is moving: the measured median gap between frames on
    /// an active screen is 36-68 ms).
    static let restartFrameSeconds: TimeInterval = 5

    private var streams: [CGDirectDisplayID: DisplayStream] = [:]

    /// Latest frame for each requested display, in the order given, with the age
    /// of each frame. Streams are started lazily, restarted when the display
    /// resolution changes or when delivery has gone quiet for too long, and
    /// evicted when the display disappears.
    func frames(for geometries: [DisplayGeometry]) throws -> [(geometry: DisplayGeometry, image: CGImage, age: TimeInterval)] {
        try Permissions.require(.screenRecording)
        let needsLookup = geometries.contains { geometry in
            guard let stream = streams[geometry.id] else { return true }
            return !stream.isRunning || stream.isStale(for: geometry) || Self.isStalled(stream)
        }
        let available = needsLookup ? try shareableDisplays() : [:]
        evictVanishedDisplays(stillActive: Set(try Displays.active().map(\.id)))

        return try geometries.map { geometry in
            let stream = try ensureStream(for: geometry, available: available)
            let frame = try stream.latestImage(timeout: Self.firstFrameTimeout)
            return (geometry, frame.image, frame.age)
        }
    }

    func stopAll() {
        streams.values.forEach { $0.stop() }
        streams.removeAll()
    }

    private static func isStalled(_ stream: DisplayStream) -> Bool {
        guard let age = stream.frameAge else { return false }
        return age >= restartFrameSeconds
    }

    /// Drops streams for displays that are no longer active — typically a
    /// monitor that was unplugged or put to sleep. Without this the SCStream and
    /// its IOSurface backing stay referenced for the lifetime of the process,
    /// growing with every hotplug cycle. Checked on every `frames` call, not
    /// just when a lookup is needed, because a vanished display never appears in
    /// the requested geometries and so would otherwise never be reconsidered.
    /// A display that is still connected but simply not being requested right
    /// now keeps its stream: it costs one warm stream and saves the restart.
    private func evictVanishedDisplays(stillActive: Set<CGDirectDisplayID>) {
        for (id, stream) in streams where !stillActive.contains(id) {
            stream.stop()
            streams.removeValue(forKey: id)
        }
    }

    private func ensureStream(for geometry: DisplayGeometry, available: [CGDirectDisplayID: SCDisplay]) throws -> DisplayStream {
        if let existing = streams[geometry.id], existing.isRunning, !existing.isStale(for: geometry), !Self.isStalled(existing) {
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
