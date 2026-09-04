import AVFoundation
import ExpoModulesCore
import UIKit

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

    private func receiveLoop() {
        var reportedLive = false
        while true {
            lock.lock()
            let alive = running
            let h = handle
            lock.unlock()
            guard alive, let h else { return }

            var frame = BelayFrame()
            let result = belay_client_next_frame(h, &frame)
            switch result {
            case BELAY_FRAME_VIDEO:
                guard let data = frame.data, frame.len > 0 else { break }
                let buffer = UnsafeRawBufferPointer(start: data, count: frame.len)
                if let sample = stream.decode(buffer) {
                    // The layer can fail into a state where every subsequent
                    // enqueue is silently dropped — a decoder error, or a
                    // background transition. Flushing and asking for a fresh
                    // keyframe is the only way back.
                    if displayLayer.status == .failed {
                        displayLayer.flush()
                    }
                    displayLayer.enqueue(sample)
                    if !reportedLive {
                        reportedLive = true
                        DispatchQueue.main.async { [weak self] in
                            self?.onStatus(["state": "live"])
                        }
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
        }
    }
}
