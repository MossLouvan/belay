// Display geometry.
//
// Everything here is in CoreGraphics *global display space*: points, origin at
// the top-left of the primary display, y growing downwards. That is the same
// space CGEvent mouse coordinates live in, so capture geometry and input
// coordinates never need converting between each other.
//
// Points, not pixels, on purpose: a Retina display reports 1512x982 points and
// 3024x1964 pixels, and only the point value is meaningful for positioning the
// cursor. Pixel dimensions are carried separately for capture sizing.

import CoreGraphics
import Foundation

struct DisplayGeometry {
    let id: CGDirectDisplayID
    /// Bounds in points, global display space.
    let bounds: CGRect
    /// Backing scale factor (2.0 on Retina).
    let scale: CGFloat

    var pixelWidth: Int { Int((bounds.width * scale).rounded()) }
    var pixelHeight: Int { Int((bounds.height * scale).rounded()) }
}

enum Displays {
    private static let maxDisplays: UInt32 = 16

    static func active() throws -> [DisplayGeometry] {
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
        var count: UInt32 = 0
        let status = CGGetActiveDisplayList(maxDisplays, &ids, &count)
        guard status == .success else {
            throw HostError(.display, "CGGetActiveDisplayList failed (status \(status.rawValue))")
        }
        let displays = ids.prefix(Int(count)).map(geometry(of:))
        guard !displays.isEmpty else {
            throw HostError(.display, "no active displays found (is the Mac headless or fully asleep?)")
        }
        return displays
    }

    static func primary() throws -> DisplayGeometry {
        let main = CGMainDisplayID()
        let all = try active()
        return all.first { $0.id == main } ?? all[0]
    }

    /// The display a client-supplied index names, within `displays`.
    ///
    /// The index is a position in `active()` order — the same order the `info`
    /// reply lists screens in, which is what makes the number the phone sends
    /// back mean the screen it was shown. Absent or out of range falls back to
    /// the primary, matching the Windows helper's `ScreenBounds` exactly: a
    /// stale index (a monitor unplugged mid-session) must not point capture and
    /// input at two different screens, and must never throw.
    static func at(_ index: Int?, in displays: [DisplayGeometry]) -> DisplayGeometry? {
        guard !displays.isEmpty else { return nil }
        if let index, index >= 0, index < displays.count { return displays[index] }
        let main = CGMainDisplayID()
        return displays.first { $0.id == main } ?? displays[0]
    }

    static func geometry(of id: CGDirectDisplayID) -> DisplayGeometry {
        let bounds = CGDisplayBounds(id)
        return DisplayGeometry(id: id, bounds: bounds, scale: backingScale(of: id, points: bounds.width))
    }

    /// Union of every active display — the macOS equivalent of the Windows
    /// virtual screen. May contain gaps when displays are not edge-aligned.
    static func virtualBounds(_ displays: [DisplayGeometry]) -> CGRect {
        displays.dropFirst().reduce(displays[0].bounds) { $0.union($1.bounds) }
    }

    private static func backingScale(of id: CGDirectDisplayID, points: CGFloat) -> CGFloat {
        guard points > 0, let mode = CGDisplayCopyDisplayMode(id) else { return 1 }
        let pixels = CGFloat(mode.pixelWidth)
        guard pixels > 0 else { return 1 }
        let ratio = pixels / points
        return ratio.isFinite && ratio > 0 ? ratio : 1
    }

    /// The rect shape the wire protocol uses (`{X,Y,W,H}`), matching DeskhandlerHost.cs.
    static func rectPayload(_ rect: CGRect) -> [String: Any] {
        [
            "X": Int(rect.origin.x.rounded()),
            "Y": Int(rect.origin.y.rounded()),
            "W": Int(rect.width.rounded()),
            "H": Int(rect.height.rounded()),
        ]
    }
}
