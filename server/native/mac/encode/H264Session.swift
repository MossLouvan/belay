// H.264 over the screen socket: capture → VideoToolbox → the video pipe.
//
// One session per helper. `h264start` picks a display, has ScreenCaptureKit
// scale it on the GPU to the requested width, and pushes every frame through
// VideoEncoder. Each access unit is written to file descriptor 3 as one record
// (server/src/video-records.ts documents the layout) already in the binary
// screen-frame wire format (server/src/frame-codec.ts), so Node forwards it
// to the phone without touching a byte of video.
//
// Why fd 3 and not stdout: stdout is one JSON line per message. Base64-in-JSON
// for 60 frames a second is the overhead this path exists to remove, and a
// binary record would corrupt the line reader. A fourth pipe costs Node one
// extra stdio entry at spawn and nothing else.

import CoreGraphics
import CoreVideo
import Foundation

final class H264Session {
    /// A frozen desktop produces no capture frames at all, which to the phone
    /// is indistinguishable from a dead host. Re-encoding the last frame this
    /// often keeps the stream (and the phone's stall detector) honest; an
    /// unchanged P-frame is a few hundred bytes.
    private static let idleRefreshSeconds: TimeInterval = 1.0
    private static let videoPipeDescriptor: Int32 = 3

    struct Geometry {
        let width: Int
        let height: Int
        let sourceWidth: Int
        let sourceHeight: Int
    }

    private let capture: CaptureEngine
    private let pointer: PointerWatch
    private let pipe = FileHandle(fileDescriptor: H264Session.videoPipeDescriptor, closeOnDealloc: false)
    private let writeLock = NSLock()
    private let lock = NSLock()
    private var encoder: VideoEncoder?
    private var geometry: Geometry?
    private var fps = 30
    private var quality = 55
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastEncodeUptime: TimeInterval = 0
    private var idleTimer: DispatchSourceTimer?
    private var lastError: String?

    init(capture: CaptureEngine, pointer: PointerWatch) {
        self.capture = capture
        self.pointer = pointer
    }

    var isActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return encoder != nil
    }

    /// Start (or retune) the stream. Returns the encoded and source sizes.
    /// `drawsPointer`: the phone draws the pointer from PointerWatch's pushes,
    /// so the frames leave it out.
    func start(display: DisplayGeometry, width: Int, fps: Int, quality: Int, drawsPointer: Bool = false) throws -> Geometry {
        let geometry = Self.fit(width: width, into: display)
        let output = DisplayStream.Output(width: geometry.width, height: geometry.height, fps: Int32(fps),
                                          showsCursor: !drawsPointer)
        lock.lock()
        self.fps = fps
        self.quality = quality
        self.geometry = geometry
        lock.unlock()

        try capture.attachEncoderSink(to: display, output: output) { [weak self] pixelBuffer, ptsMs in
            self?.encode(pixelBuffer, ptsMs: ptsMs)
        }
        try rebuildEncoder(for: geometry)
        startIdleTimer()
        if drawsPointer { pointer.start(bounds: display.bounds) } else { pointer.stop() }
        return geometry
    }

    func stop() {
        pointer.stop()
        capture.detachEncoderSinks()
        lock.lock()
        let old = encoder
        encoder = nil
        geometry = nil
        lastPixelBuffer = nil
        idleTimer?.cancel()
        idleTimer = nil
        lock.unlock()
        old?.stop()
    }

    func requestKeyframe() {
        lock.lock()
        let current = encoder
        lock.unlock()
        current?.requestKeyframe()
    }

    func status() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var payload: [String: Any] = ["active": encoder != nil, "fps": fps]
        if let geometry { payload.merge(Self.payload(geometry)) { current, _ in current } }
        if let lastError { payload["lastError"] = lastError }
        return payload
    }

    static func payload(_ geometry: Geometry) -> [String: Any] {
        ["w": geometry.width, "h": geometry.height, "sw": geometry.sourceWidth, "sh": geometry.sourceHeight]
    }

    // MARK: - Internals

    /// Even dimensions (4:2:0 needs them), never upscaled past the source.
    private static func fit(width: Int, into display: DisplayGeometry) -> Geometry {
        let sourceWidth = max(2, display.pixelWidth)
        let sourceHeight = max(2, display.pixelHeight)
        let outWidth = max(16, min(width, sourceWidth)) & ~1
        let outHeight = max(16, Int((Double(outWidth) * Double(sourceHeight) / Double(sourceWidth)).rounded())) & ~1
        return Geometry(width: outWidth, height: outHeight, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
    }

    /// ponytail: a fixed bitrate ladder from the JPEG quality knob (q 20..90 →
    /// ~0.06..0.13 bits per pixel per frame at 1024x662). Upgrade to a
    /// phone-driven ABR setpoint when a congestion signal exists on this socket.
    ///
    /// Bits per pixel fall with the square root of the pixel count past that
    /// reference: desktop content is flat areas and sharp edges, and four
    /// times the pixels of the same windows is nowhere near four times the
    /// information. Linear scaling asked ~11 Mbps of a phone-sized stream
    /// that looks the same at ~4.5.
    static let referencePixels = 1024.0 * 662.0
    static func bitrate(width: Int, height: Int, fps: Int, quality: Int) -> Int {
        let pixels = Double(width * height)
        let bitsPerPixel = 0.04 + Double(min(max(quality, 1), 100)) / 100.0 * 0.10
        let density = pixels > referencePixels ? (referencePixels / pixels).squareRoot() : 1
        return Int(pixels * Double(fps) * bitsPerPixel * density)
    }

    private func rebuildEncoder(for geometry: Geometry) throws {
        let fps = self.fps
        let quality = self.quality
        let encoder = try VideoEncoder(
            width: Int32(geometry.width), height: Int32(geometry.height), codec: .h264, fps: fps,
            onFrame: { [weak self] data, isKeyframe, _ in self?.write(data, keyframe: isKeyframe, geometry: geometry) },
            onError: { [weak self] message in
                guard let self else { return }
                self.lock.lock(); self.lastError = message; self.lock.unlock()
                FileHandle.standardError.write(Data("[h264] \(message)\n".utf8))
            }
        )
        encoder.setBitrate(Self.bitrate(width: geometry.width, height: geometry.height, fps: fps, quality: quality))
        encoder.requestKeyframe()
        lock.lock()
        let old = self.encoder
        self.encoder = encoder
        self.geometry = geometry
        lock.unlock()
        old?.stop()
    }

    /// On the SCStream sample queue. A frame of a different size than the
    /// session (display resolution changed under a running stream) rebuilds
    /// the encoder, whose first output is an IDR with fresh parameter sets.
    private func encode(_ pixelBuffer: CVPixelBuffer, ptsMs: Double) {
        lock.lock()
        guard var geometry, let current = encoder else { lock.unlock(); return }
        lastPixelBuffer = pixelBuffer
        lastEncodeUptime = ProcessInfo.processInfo.systemUptime
        lock.unlock()

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var encoder = current
        if width != geometry.width || height != geometry.height {
            geometry = Geometry(width: width, height: height,
                                sourceWidth: geometry.sourceWidth, sourceHeight: geometry.sourceHeight)
            guard (try? rebuildEncoder(for: geometry)) != nil else { return }
            lock.lock(); encoder = self.encoder ?? current; lock.unlock()
        }
        encoder.encode(pixelBuffer: pixelBuffer, ptsMs: ptsMs)
    }

    private func startIdleTimer() {
        lock.lock()
        defer { lock.unlock() }
        guard idleTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "belay.h264.idle"))
        timer.schedule(deadline: .now() + Self.idleRefreshSeconds, repeating: Self.idleRefreshSeconds)
        timer.setEventHandler { [weak self] in self?.refreshIfIdle() }
        timer.resume()
        idleTimer = timer
    }

    private func refreshIfIdle() {
        lock.lock()
        let now = ProcessInfo.processInfo.systemUptime
        guard let encoder, let buffer = lastPixelBuffer, now - lastEncodeUptime >= Self.idleRefreshSeconds else {
            lock.unlock(); return
        }
        lastEncodeUptime = now
        lock.unlock()
        encoder.encode(pixelBuffer: buffer, ptsMs: now * 1000.0)
    }

    // MARK: - Wire format

    /// One record: [u32 len][u8 flags][binary screen frame]. The frame header
    /// mirrors frame-codec.ts: magic, version, metaLen, w, h, sw, sh,
    /// payloadLen, meta JSON, payload — all big-endian.
    private func write(_ annexB: Data, keyframe: Bool, geometry: Geometry) {
        let meta = Data((keyframe ? "{\"codec\":\"h264\",\"key\":true}" : "{\"codec\":\"h264\"}").utf8)
        var record = Data(capacity: 4 + 1 + 24 + meta.count + annexB.count)
        Self.appendUInt32(&record, UInt32(1 + 24 + meta.count + annexB.count))
        record.append(keyframe ? 0x01 : 0x00)
        record.append(0xBF) // magic
        record.append(0x01) // version
        record.append(UInt8(meta.count >> 8)); record.append(UInt8(meta.count & 0xFF))
        Self.appendUInt32(&record, UInt32(geometry.width))
        Self.appendUInt32(&record, UInt32(geometry.height))
        Self.appendUInt32(&record, UInt32(geometry.sourceWidth))
        Self.appendUInt32(&record, UInt32(geometry.sourceHeight))
        Self.appendUInt32(&record, UInt32(annexB.count))
        record.append(meta)
        record.append(annexB)

        writeLock.lock()
        defer { writeLock.unlock() }
        do {
            try pipe.write(contentsOf: record)
        } catch {
            // No pipe (run by hand) or Node is gone: the session cannot
            // deliver anything, so stop encoding rather than spin on errors.
            lock.lock(); lastError = "video pipe write failed: \(error.localizedDescription)"; lock.unlock()
            DispatchQueue.global().async { [weak self] in self?.stop() }
        }
    }

    private static func appendUInt32(_ data: inout Data, _ value: UInt32) {
        var be = value.bigEndian
        withUnsafeBytes(of: &be) { data.append(contentsOf: $0) }
    }
}
