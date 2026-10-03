// The real macOS pointer, for a phone that draws it itself.
//
// Downscaled with a Retina desktop, the pointer ScreenCaptureKit composites
// into the frame is a few pixels across on a phone. So when the phone asks
// (`pointer` on `h264start`), the stream is captured WITHOUT the pointer and
// this pushes `{"type":"pointer","x","y"}` lines instead — position normalized
// to the streamed display — plus the cursor's own image whenever its shape
// changes, so the phone draws exactly what macOS would (arrow, I-beam, hand,
// resize…) at a size that reads.

import AppKit
import CoreGraphics
import Foundation

final class PointerWatch {
    /// Poll rate. Moves are pushed only when the position changed, so a still
    /// pointer costs a timer tick and nothing on the wire.
    private static let hz = 60.0

    private let push: ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "belay.pointer", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private var bounds = CGRect.zero
    private var last = CGPoint(x: -1, y: -1)
    private var lastShape = ""

    init(push: @escaping ([String: Any]) -> Void) {
        self.push = push
    }

    /// (Re)start for a display, given in global points. A restart always
    /// re-sends the image: a socket that joins mid-session needs the shape.
    func start(bounds: CGRect) {
        queue.async { [self] in
            self.bounds = bounds
            last = CGPoint(x: -1, y: -1)
            lastShape = ""
            guard timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now(), repeating: 1.0 / Self.hz)
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            timer = t
        }
    }

    func stop() {
        queue.async { [self] in
            timer?.cancel()
            timer = nil
        }
    }

    private func tick() {
        // CGEvent's location is global, top-left origin, in points — the same
        // space as CGDisplayBounds, so no flipping against NSScreen.
        guard let location = CGEvent(source: nil)?.location, bounds.width > 0, bounds.height > 0 else { return }
        var payload: [String: Any] = [:]
        if let cursor = NSCursor.currentSystem {
            // ponytail: shape identity is hotspot + size. Two cursors that share
            // both are drawn as whichever came first; compare image bytes if a
            // real pair ever collides.
            let shape = "\(cursor.hotSpot)|\(cursor.image.size)"
            if shape != lastShape, let image = Self.image(of: cursor) {
                lastShape = shape
                payload["cursor"] = image
            }
        }
        guard location != last || payload["cursor"] != nil else { return }
        last = location
        payload["type"] = "pointer"
        payload["x"] = Double((location.x - bounds.minX) / bounds.width)
        payload["y"] = Double((location.y - bounds.minY) / bounds.height)
        push(payload)
    }

    /// The cursor as PNG at 2× its point size, with size and hotspot in points.
    private static func image(of cursor: NSCursor) -> [String: Any]? {
        let size = cursor.image.size
        guard size.width > 0, size.height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2),
                                         pixelsHigh: Int(size.height * 2), bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        cursor.image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return ["png": png.base64EncodedString(), "w": Double(size.width), "h": Double(size.height),
                "hx": Double(cursor.hotSpot.x), "hy": Double(cursor.hotSpot.y)]
    }
}
