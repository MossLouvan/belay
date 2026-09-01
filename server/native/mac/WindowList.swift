// Per-window enumeration, capture and raise for the macOS helper — the
// counterpart of BelayHostWindows.cs, answering the same three commands with
// the same wire shapes so the server and the desktop client stay
// platform-agnostic.
//
// macOS splits the job across three frameworks, and each brings a constraint:
//
//   CoreGraphics window list   the only enumeration API. It reports every
//                              window in the session, most of which are not
//                              windows anyone would recognise — menu bar items,
//                              shadows, tooltips, the Dock. Layer 0 is the
//                              "normal window" layer and is the filter that
//                              matters.
//   CGWindowListCreateImage    a window's own pixels, on demand and
//                              synchronously. Deprecated in macOS 14 in favour
//                              of ScreenCaptureKit's SCScreenshotManager, which
//                              requires macOS 14 — above this helper's 13.0
//                              deployment target — so this is the path that
//                              works on every macOS Belay supports. Both need
//                              the Screen Recording grant.
//   Accessibility (AXUIElement) raising a window. There is no CoreGraphics call
//                              for it: the window belongs to another process,
//                              and only the accessibility API can reach into
//                              one. Needs the Accessibility grant, which the
//                              helper already requires for input injection.

import ApplicationServices
import CoreGraphics
import Foundation

enum WindowList {
    /// The CoreGraphics layer normal application windows live on. Everything
    /// else — menus, the Dock, tooltips, drag images — sits above or below it,
    /// and none of it is a window a person would think to remote.
    private static let normalLayer = 0

    /// Smallest window worth listing, in points. Below this a "window" is
    /// almost always an artefact: a shadow, a one-pixel helper, a status item.
    private static let minimumSide: CGFloat = 40

    private static func size(_ dict: [String: Any], _ key: String) -> CGFloat? {
        (dict[key] as? NSNumber).map { CGFloat($0.doubleValue) }
    }

    /// Every on-screen window worth showing, front to back.
    ///
    /// `optionOnScreenOnly` returns them in front-to-back order, so the index
    /// doubles as the stacking order exactly as EnumWindows does on Windows.
    static func all() -> [[String: Any]] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }

        var windows: [[String: Any]] = []
        for info in raw {
            guard let id = info[kCGWindowNumber as String] as? NSNumber else { continue }
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
            guard layer == normalLayer else { continue }

            // A fully transparent window is present but invisible; offering it
            // would give the user a window that streams nothing.
            let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            guard alpha > 0.05 else { continue }

            guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let x = size(bounds, "X"), let y = size(bounds, "Y"),
                  let width = size(bounds, "Width"), let height = size(bounds, "Height")
            else { continue }
            guard width >= minimumSide, height >= minimumSide else { continue }

            let owner = info[kCGWindowOwnerName as String] as? String ?? ""
            let title = info[kCGWindowName as String] as? String ?? ""
            // Neither a title nor an owner means the row cannot be labelled, and
            // an unlabelled row in a window picker is not worth offering. A
            // title alone is often absent: reading window *names* needs the
            // Screen Recording grant, so before it is given the owner is all
            // there is.
            guard !(owner.isEmpty && title.isEmpty) else { continue }

            windows.append([
                "id": id.stringValue,
                "title": title,
                "app": owner,
                "X": Int(x.rounded()), "Y": Int(y.rounded()),
                "W": Int(width.rounded()), "H": Int(height.rounded()),
                // macOS reports no minimized flag here — a minimized window
                // stops being on-screen and drops out of the list entirely. The
                // field is sent for wire parity with the Windows helper.
                "minimized": false,
                "z": windows.count,
            ])
        }
        return windows
    }

    /// A window id parsed from the string form the wire uses, or nil.
    ///
    /// Same rule as the Windows helper: digits only, and never zero —
    /// kCGNullWindowID asks CoreGraphics for *every* window rather than one,
    /// which would quietly capture the whole desktop.
    static func parse(_ raw: Any?) -> CGWindowID? {
        let text = (raw as? String) ?? (raw as? NSNumber)?.stringValue
        guard let text, let value = UInt32(text), value != 0 else { return nil }
        return CGWindowID(value)
    }

    private static func info(of id: CGWindowID) -> [String: Any]? {
        (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first
    }

    /// The window's current rectangle, or nil when it no longer exists.
    static func bounds(of id: CGWindowID) -> CGRect? {
        guard let info = info(of: id),
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let x = size(bounds, "X"), let y = size(bounds, "Y"),
              let width = size(bounds, "Width"), let height = size(bounds, "Height")
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// The window's title now, which is not the title it had when it was listed
    /// — a browser tab or an edited document renames its window constantly.
    static func title(of id: CGWindowID) -> String {
        info(of: id)?[kCGWindowName as String] as? String ?? ""
    }

    /// The window's own pixels, or nil when it has gone.
    ///
    /// `.boundsIgnoreFraming` trims the drop shadow, which is not part of the
    /// window and would otherwise stream as a translucent border.
    /// `.optionIncludingWindow` restricts the capture to this one window, so
    /// anything sitting on top of it on the host does not appear — the same
    /// property PrintWindow gives the Windows helper, and what lets a client
    /// stack remote windows in its own order rather than the host's.
    static func image(of id: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(.null, [.optionIncludingWindow], id,
                                [.boundsIgnoreFraming, .nominalResolution])
    }

    private static func ownerPid(of id: CGWindowID) -> pid_t? {
        guard let pid = info(of: id)?[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
        return pid_t(pid.int32Value)
    }

    /// Bring a window to the front so typed input reaches it.
    ///
    /// Two steps, both required: raise the window within its application, and
    /// bring that application forward. Doing only the first leaves the window
    /// frontmost inside an app that is itself still behind everything else.
    ///
    /// Accessibility cannot address a window by CGWindowID, so the match is
    /// made on position and size — the one pair of attributes both APIs report.
    /// Returns false rather than throwing when the grant is missing or nothing
    /// matches: "could not raise" is a normal outcome the client reports, not a
    /// failure of the call.
    static func focus(_ id: CGWindowID) -> Bool {
        guard let pid = ownerPid(of: id), let target = bounds(of: id) else { return false }

        let app = AXUIElementCreateApplication(pid)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
              let windows = raw as? [AXUIElement]
        else { return false }

        for window in windows where matches(window, target) {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            return true
        }
        return false
    }

    /// Whether an accessibility window sits at the same place and size as a
    /// CoreGraphics rectangle. A couple of points of tolerance absorbs the
    /// rounding difference between the two APIs.
    private static func matches(_ window: AXUIElement, _ target: CGRect) -> Bool {
        guard let origin: CGPoint = axValue(window, kAXPositionAttribute, .cgPoint),
              let size: CGSize = axValue(window, kAXSizeAttribute, .cgSize)
        else { return false }
        return abs(origin.x - target.origin.x) <= 2 && abs(origin.y - target.origin.y) <= 2
            && abs(size.width - target.width) <= 2 && abs(size.height - target.height) <= 2
    }

    private static func axValue<T>(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> T? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let value = raw, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let out = UnsafeMutablePointer<T>.allocate(capacity: 1)
        defer { out.deallocate() }
        guard AXValueGetValue(value as! AXValue, type, out) else { return nil }
        return out.pointee
    }
}
