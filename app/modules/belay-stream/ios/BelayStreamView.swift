import AVFoundation
import ExpoModulesCore
import Foundation
import UIKit

// The BWP protocol itself, as a C library. Declared by
// ios/include/module.modulemap and built by scripts/build-ios-client.sh; an
// Expo module is a pod, and a pod has no app bridging header to put a plain
// #import in.
import BelayClientFFI

/// The channel the controller module hands its encoded reports to.
///
/// A notification rather than a direct call because the two Expo modules are
/// separate CocoaPods: making BelayGamepad depend on BelayStream would make the
/// controller unbuildable on a machine that has not built
/// `lib/BelayClient.xcframework`, and the controller must keep working when
/// there is no H.264 session at all.
///
/// The poster is `app/modules/belay-gamepad/ios/GamepadSession.swift`, which
/// declares the same string. `app/src/gamepad/bridge.test.mjs` fails if the two
/// ever drift. `object` is the encoded report as `Data`.
extension Notification.Name {
    static let belayInputReport = Notification.Name("belay.input.report")
}

/// The view that shows the host's desktop.
///
/// One thread owns the session and pulls frames; decoded samples are handed to
/// an `AVSampleBufferDisplayLayer`, which does the hardware decode itself — no
/// `VTDecompressionSession` needed, and no intermediate pixel buffer we would
/// only have to hand back to Core Animation anyway.
///
/// The session handle is explicitly not thread-safe (see belay_client.h), which
/// is why exactly one thread ever touches it. Everything that crosses back to
/// the main thread does so through the layer, which is safe to enqueue on from
/// any thread.
public final class BelayStreamView: ExpoView {
    private let displayLayer = AVSampleBufferDisplayLayer()
    private var handle: UnsafeMutableRawPointer?
    private var receiveThread: Thread?
    private var stream = H264Stream()
    /// Guards `handle` against a teardown racing the receive thread.
    private let lock = NSLock()
    private var running = false

    /// The newest input report waiting for the receive thread, and nothing
    /// older. The session handle is not thread-safe and the receive thread is
    /// polling it, so a report cannot be sent from the thread that produced it;
    /// it is parked here and drained by that same thread instead. Newest-only
    /// on purpose: a controller report is the complete state, so a stale one is
    /// worse than none, and the next is 8 ms away.
    private let inputLock = NSLock()
    private var pendingInput: Data?
    private var inputObserver: NSObjectProtocol?
    /// Reports handed to the transport since the last stats line. The only
    /// evidence on a real device that the controller is taking the UDP path.
    private var inputSent = 0

    /// The view a `sendInput` call from JS reaches. Weak: React owns the view's
    /// lifetime, and a stale strong reference here would keep a closed session
    /// alive and swallow reports.
    private static let liveLock = NSLock()
    private static weak var liveView: BelayStreamView?

    let onStatus = EventDispatcher()
    let onCursor = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        displayLayer.videoGravity = .resizeAspect
        // Without this the layer times playback against a clock nothing is
        // driving, and a live stream drifts steadily further behind.
        displayLayer.controlTimebase = nil
        layer.addSublayer(displayLayer)
        backgroundColor = .black
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        displayLayer.frame = bounds
    }

    deinit {
        stop()
    }

    /// Open a session and start receiving.
    ///
    /// `key` and `salt` come from the host's `bwpOffer` over the authenticated
    /// control socket. They are never logged: a key in a log is a key in a
    /// crash report and in every log-aggregation service the app touches.
    func start(host: String, hostPort: Int, key: String, salt: String, preset: String, localPort: Int) {
        stop()

        let bind = "0.0.0.0:\(localPort)"
        let peer = host.contains(":") && !host.hasPrefix("[")
            ? "[\(host)]:\(hostPort)"
            : "\(host):\(hostPort)"

        let opened = bind.withCString { b in
            peer.withCString { p in
                key.withCString { k in
                    salt.withCString { s in
                        preset.withCString { pr in
                            belay_client_open(b, p, k, s, pr)
                        }
                    }
                }
            }
        }
        guard let opened else {
            onStatus(["state": "error", "error": "could not open the stream session"])
            return
        }

        lock.lock()
        handle = opened
        running = true
        lock.unlock()

        BelayStreamView.setLive(self)
        // Only while a session is open: with no observer, posting a report
        // costs the controller module a table lookup and nothing else.
        inputObserver = NotificationCenter.default.addObserver(
            forName: .belayInputReport, object: nil, queue: nil
        ) { [weak self] note in
            guard let data = note.object as? Data else { return }
            self?.enqueueInput(data)
        }

        stream = H264Stream()
        onStatus([
            "state": "opened",
            "localPort": Int(belay_client_local_port(opened)),
        ])

        let thread = Thread { [weak self] in self?.receiveLoop() }
        thread.name = "belay.stream.receive"
        // Above default so a busy UI cannot starve the video thread, but below
        // real-time: dropping a frame is far better than dropping audio or
        // stalling the main thread.
        thread.qualityOfService = .userInteractive
        receiveThread = thread
        thread.start()
    }

    func stop() {
        BelayStreamView.clearLive(self)
        if let observer = inputObserver {
            NotificationCenter.default.removeObserver(observer)
            inputObserver = nil
        }
        inputLock.lock(); pendingInput = nil; inputLock.unlock()

        lock.lock()
        running = false
        let h = handle
        handle = nil
        lock.unlock()

        // The receive thread checks `running` and exits; closing the handle
        // here would free it out from under a poll in flight.
        receiveThread?.cancel()
        receiveThread = nil
        if let h {
            // Give the loop a moment to notice it should stop before the handle
            // goes away. A short bounded wait, not a lock the loop must take on
            // every frame.
            Thread.sleep(forTimeInterval: 0.02)
            belay_client_close(h)
        }
        displayLayer.flushAndRemoveImage()
    }

    // MARK: input

    /// Park one input report for the receive thread to send.
    ///
    /// Callable from any thread — the controller module's send queue posts from
    /// its own 8 ms timer, and `sendInput` arrives on the JS thread. Neither
    /// touches the session handle; they only take this lock.
    ///
    /// Reports outside the transport's length limit are dropped here rather
    /// than rejected one layer down, so a malformed sample never costs a
    /// round trip through the receive thread.
    func enqueueInput(_ data: Data) {
        guard data.count > 0, data.count <= BelayStreamView.maxInputBytes else { return }
        inputLock.lock()
        pendingInput = data
        inputLock.unlock()
    }

    /// `BELAY_INPUT_MAX_LEN` in include/belay_client.h. A gamepad report is 17.
    private static let maxInputBytes = 64

    static func current() -> BelayStreamView? {
        liveLock.lock(); defer { liveLock.unlock() }
        return liveView
    }

    private static func setLive(_ view: BelayStreamView) {
        liveLock.lock(); liveView = view; liveLock.unlock()
    }

    /// Clears the registration only if it is still this view's. A second view
    /// starting before the first stops would otherwise be unregistered by the
    /// old one's teardown.
    private static func clearLive(_ view: BelayStreamView) {
        liveLock.lock(); if liveView === view { liveView = nil }; liveLock.unlock()
    }

    /// Send whatever is parked, from the one thread that owns the handle.
    ///
    /// Returns whether a report went out, so the stats line can say the UDP
    /// path is carrying the controller — on a phone that is the only way to
    /// tell it apart from the WebSocket doing all the work.
    private func drainInput(_ h: UnsafeMutableRawPointer) -> Bool {
        inputLock.lock()
        let report = pendingInput
        pendingInput = nil
        inputLock.unlock()
        guard let report else { return false }
        return report.withUnsafeBytes { raw -> Bool in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return false }
            return belay_client_send_input(h, base, raw.count) == BELAY_OK
        }
    }

    /// How often the receive thread reports decoded frames and latency.
    private static let statsInterval: TimeInterval = 1.0

    private func receiveLoop() {
        var reportedLive = false
        var recovery = StreamRecovery()
        var stats = StreamStats(startedAt: Self.monotonicNow())
        while true {
            lock.lock()
            let alive = running
            let h = handle
            lock.unlock()
            guard alive, let h else { return }

            var frame = BelayFrame()
            let result = belay_client_next_frame(h, &frame)
            // Before the decode, not after: a report parked while the last
            // frame was decoding should not wait for this one as well. Every
            // branch below continues or returns, so this is the only place on
            // the loop that all of them pass through.
            if drainInput(h) { inputSent += 1 }
            switch result {
            case BELAY_FRAME_VIDEO:
                guard let data = frame.data, frame.len > 0 else { break }
                let buffer = UnsafeRawBufferPointer(start: data, count: frame.len)
                let now = Self.monotonicNow()
                // Trust the bytes over the header flag: see H264Stream.containsIDR.
                let keyframe = frame.keyframe != 0 || H264Stream.containsIDR(buffer)
                let layerFailed = displayLayer.status == .failed
                switch recovery.judge(keyframe: keyframe, layerFailed: layerFailed, now: now) {
                case .drop:
                    stats = stats.dropped()
                    continue
                case .dropAndRequest:
                    stats = stats.dropped()
                    belay_client_request_keyframe(h)
                    continue
                case .show:
                    break
                }
                guard let sample = stream.decode(buffer) else {
                    // Parameter sets missing or a corrupt access unit: only a
                    // fresh keyframe (which carries SPS/PPS) can fix either.
                    stats = stats.dropped()
                    if recovery.decodeFailed(now: now) {
                        belay_client_request_keyframe(h)
                    }
                    continue
                }
                // The layer can fail into a state where every subsequent
                // enqueue is silently dropped — a decoder error, or a
                // background transition. Only a keyframe reaches here while it
                // is failed (recovery drops the rest), so flush and restart.
                if layerFailed {
                    displayLayer.flush()
                }
                displayLayer.enqueue(sample)
                stats = stats.decoded()
                if !reportedLive {
                    reportedLive = true
                    DispatchQueue.main.async { [weak self] in
                        self?.onStatus(["state": "live"])
                    }
                }
            case BELAY_FRAME_CURSOR:
                let x = frame.cursor_x
                let y = frame.cursor_y
                let visible = frame.cursor_visible != 0
                // Cursor arrives on its own channel at up to 120 Hz — far above
                // the rate JS can usefully consume. It is dispatched rather
                // than dropped because it is the single most latency-sensitive
                // thing on screen, and the JS side coalesces.
                DispatchQueue.main.async { [weak self] in
                    self?.onCursor(["x": Int(x), "y": Int(y), "visible": visible])
                }
            case BELAY_FRAME_BITRATE:
                let bps = frame.bitrate_bps
                DispatchQueue.main.async { [weak self] in
                    self?.onStatus(["state": "bitrate", "bps": Int(bps)])
                }
            case BELAY_FRAME_NONE:
                // Nothing ready. Sleep briefly rather than spin: at 60fps a
                // frame is 16ms away, and a busy-wait would cost battery for
                // latency no one can perceive.
                Thread.sleep(forTimeInterval: 0.002)
            default:
                DispatchQueue.main.async { [weak self] in
                    self?.onStatus(["state": "error", "error": "the stream session failed"])
                }
                return
            }

            // Once a second: what actually decoded, and how far away the host
            // is. Sent even when nothing decoded — a zero is how JS tells a
            // stalled stream from one that is merely quiet.
            let now = Self.monotonicNow()
            if now - stats.startedAt >= Self.statsInterval {
                let rtt = belay_client_rtt_ms(h)
                let report = stats
                let requests = recovery.requests
                let inputs = inputSent
                inputSent = 0
                stats = StreamStats(startedAt: now)
                DispatchQueue.main.async { [weak self] in
                    self?.onStatus([
                        "state": "stats",
                        "decoded": report.decodedFrames,
                        "dropped": report.droppedFrames,
                        "keyframeRequests": requests,
                        "inputSent": inputs,
                        "rttMs": rtt < 0 ? -1 : Int(rtt.rounded()),
                    ])
                }
            }
        }
    }

    /// A clock that does not jump when the wall clock is adjusted.
    private static func monotonicNow() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }
}

/// Frames decoded and dropped since a point in time. Immutable: each event
/// returns a new value rather than mutating the old one.
private struct StreamStats {
    let startedAt: TimeInterval
    let decodedFrames: Int
    let droppedFrames: Int

    init(startedAt: TimeInterval, decodedFrames: Int = 0, droppedFrames: Int = 0) {
        self.startedAt = startedAt
        self.decodedFrames = decodedFrames
        self.droppedFrames = droppedFrames
    }

    func decoded() -> StreamStats {
        StreamStats(startedAt: startedAt, decodedFrames: decodedFrames + 1, droppedFrames: droppedFrames)
    }

    func dropped() -> StreamStats {
        StreamStats(startedAt: startedAt, decodedFrames: decodedFrames, droppedFrames: droppedFrames + 1)
    }
}
