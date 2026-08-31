// Synthetic mouse and keyboard input via CGEvent.
//
// Everything is posted to the HID event tap so applications see it exactly as
// they would see real hardware. Without the Accessibility grant CGEvent.post is
// silently dropped with no error return at all, so every entry point preflights
// the permission and fails loudly instead.
//
// Mouse coordinates on the wire are normalized 0..1 (the phone never learns the
// host resolution). They are mapped into CoreGraphics global display space —
// points, top-left origin — which is what CGEvent expects, so clicks land
// correctly on any Retina scale factor and on any display in the layout.

import CoreGraphics
import Foundation

enum MouseButton: String {
    case left, right, middle

    static func parse(_ raw: String?) throws -> MouseButton {
        guard let raw, !raw.isEmpty else { return .left }
        guard let button = MouseButton(rawValue: raw.lowercased()) else {
            throw HostError(.badArgument, "unknown mouse button '\(raw)' (expected left, right or middle)",
                            details: ["field": "button"])
        }
        return button
    }

    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    var dragType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

/// Which rectangle normalized 0..1 coordinates map onto.
/// A normalized pointer coordinate together with what it is normalized against.
///
/// `window` is a window id from the `windows` command and outranks everything
/// else: a client showing one window measured against that window and nothing
/// else. `screen` is an index into the `info` reply's `screens` list. With
/// neither, the host's InputSpace decides, which is what clients too old to say
/// anything rely on.
typealias PointerTarget = (x: Double, y: Double, screen: Int?, window: CGWindowID?)

enum InputSpace: String {
    /// The primary display — matches what `capture` streams by default.
    case primary
    /// The union of all displays — matches the Windows helper's MOUSEEVENTF_VIRTUALDESK.
    case virtualDesktop = "virtual"

    /// `TETHER_MAC_INPUT_SPACE=virtual` restores Windows-identical behaviour.
    static var configured: InputSpace {
        let raw = ProcessInfo.processInfo.environment["TETHER_MAC_INPUT_SPACE"]?.lowercased() ?? ""
        return InputSpace(rawValue: raw) ?? .primary
    }
}

final class InputController {
    /// Windows sends wheel deltas in WHEEL_DELTA units (120 per notch) and the
    /// protocol is shared, so the same unit arrives here. Overridable because
    /// a future client may send raw lines instead.
    private static let defaultWheelDelta = 120.0
    /// Gap between the two clicks of a synthetic double-click.
    private static let doubleClickGapSeconds = 0.04
    private static let maxUnicodeUnitsPerEvent = 16
    /// Ceiling on a single `text` command, in UTF-16 code units — the same unit
    /// JavaScript's `String.length` counts, so the Node-side guard in
    /// server/src/index.ts can use the identical number and the two layers can
    /// never disagree about whether a payload fits. 4096 is roughly a page of
    /// prose: comfortably more than any phone keyboard burst, far less than a
    /// runaway paste. Genuinely large text must be chunked by the client, which
    /// also lets the user see it landing and stop it.
    static let maxTextUnits = 4096

    private var heldButtons: Set<MouseButton> = []

    private var wheelDelta: Double {
        guard let raw = ProcessInfo.processInfo.environment["TETHER_MAC_WHEEL_DELTA"],
              let value = Double(raw), value.isFinite, value > 0 else {
            return Self.defaultWheelDelta
        }
        return value
    }

    // MARK: - Mouse

    func move(normalizedX: Double, normalizedY: Double, screen: Int?, window: CGWindowID?) throws {
        try Permissions.require(.accessibility)
        let point = try globalPoint(normalizedX: normalizedX, normalizedY: normalizedY,
                                    screen: screen, window: window)
        // While a button is held the OS needs a drag event, not a plain move,
        // or applications never see the drag at all.
        if let held = heldButtons.first {
            try post(type: held.dragType, at: point, button: held.cgButton, clickState: 1)
        } else {
            try post(type: .mouseMoved, at: point, button: .left, clickState: 0)
        }
    }

    func press(_ button: MouseButton, at position: PointerTarget?) throws {
        try Permissions.require(.accessibility)
        let point = try resolve(position)
        // Recorded only after the event is actually posted. Inserting first
        // meant a failed post left the button marked as held without it ever
        // being pressed — and from then on every `move` was emitted as a drag
        // instead of a move, until some later up/click happened to clear it.
        try post(type: button.downType, at: point, button: button.cgButton, clickState: 1)
        heldButtons.insert(button)
    }

    func release(_ button: MouseButton, at position: PointerTarget?) throws {
        try Permissions.require(.accessibility)
        let point = try resolve(position)
        heldButtons.remove(button)
        try post(type: button.upType, at: point, button: button.cgButton, clickState: 1)
    }

    /**
     Release every button we are still holding.

     Called when stdin closes, i.e. Node has gone away. A phone that disconnects
     mid-drag otherwise leaves the button physically down at the OS level, and
     nothing on the desktop will clear it. Best-effort by design: this runs on
     the way out, so a failure here must not prevent the rest of the shutdown.
     */
    func releaseAll() {
        guard !heldButtons.isEmpty else { return }
        let held = heldButtons
        heldButtons.removeAll()
        for button in held {
            let point = currentCursor()
            try? post(type: button.upType, at: point, button: button.cgButton, clickState: 1)
        }
    }

    func click(_ button: MouseButton, at position: PointerTarget?, double: Bool) throws {
        try Permissions.require(.accessibility)
        let point = try resolve(position)
        let count = double ? 2 : 1
        for index in 1...count {
            // clickState carries the "this is the Nth click of a sequence" hint
            // that makes applications recognise a real double-click.
            try post(type: button.downType, at: point, button: button.cgButton, clickState: index)
            try post(type: button.upType, at: point, button: button.cgButton, clickState: index)
            if index < count { Thread.sleep(forTimeInterval: Self.doubleClickGapSeconds) }
        }
        heldButtons.remove(button)
    }

    func scroll(deltaY: Double, deltaX: Double) throws {
        try Permissions.require(.accessibility)
        let lines = wheelDelta
        let vertical = Self.lineCount(deltaY, per: lines)
        let horizontal = Self.lineCount(deltaX, per: lines)
        guard vertical != 0 || horizontal != 0 else { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
            wheel1: vertical, wheel2: horizontal, wheel3: 0
        ) else {
            throw HostError(.input, "could not create a scroll event")
        }
        event.post(tap: .cghidEventTap)
    }

    /// Rounds toward at least one line so a small flick still scrolls.
    private static func lineCount(_ delta: Double, per unit: Double) -> Int32 {
        guard delta != 0 else { return 0 }
        let lines = (delta / unit).rounded()
        let magnitude = max(1.0, abs(lines))
        return Int32(min(magnitude, Double(Int32.max)) * (delta < 0 ? -1 : 1))
    }

    // MARK: - Keyboard

    /// A key press with modifiers. `mods` are CGKeyCodes of modifier keys; they
    /// are folded into the event's flags rather than posted as separate key
    /// events, which is what applications actually read.
    ///
    /// Like `type(_:)`, the event goes to the HID tap, so it lands in whatever
    /// window currently owns OS focus — not in any window this process chose.
    /// The caller decides what is focused; this layer cannot.
    func key(_ keyCode: Int?, modifiers: [Int]) throws {
        try Permissions.require(.accessibility)
        let flags = ModifierKeys.flags(for: modifiers)
        guard let keyCode else {
            // Modifier-only press: flagsChanged is the honest representation.
            try postFlagsOnly(flags)
            return
        }
        guard let code = CGKeyCode(exactly: keyCode), keyCode >= 0, keyCode <= 0x7F else {
            throw HostError(.badArgument, "'vk' must be a CGKeyCode in 0..127, got \(keyCode)",
                            details: ["field": "vk"])
        }
        try postKey(code, flags: flags, down: true)
        try postKey(code, flags: flags, down: false)
    }

    /// Types arbitrary Unicode independently of the active keyboard layout.
    ///
    /// The keystrokes land in whatever window currently owns OS focus, exactly
    /// as if they came from the keyboard — this process has no say in the
    /// destination. Length is therefore capped: an oversized payload is
    /// rejected whole, before a single event is posted, because a half-typed
    /// wall of text scattered across an unknown window is worse than an error.
    func type(_ text: String) throws {
        guard !text.isEmpty else { return }
        let units = Array(text.utf16)
        guard units.count <= Self.maxTextUnits else {
            throw HostError(.badArgument,
                            "'text' is \(units.count) UTF-16 units, over the \(Self.maxTextUnits) limit for one command; send it in chunks",
                            details: ["field": "text", "limit": Self.maxTextUnits, "length": units.count])
        }
        try Permissions.require(.accessibility)
        for chunk in stride(from: 0, to: units.count, by: Self.maxUnicodeUnitsPerEvent).map({ start in
            Array(units[start..<min(start + Self.maxUnicodeUnitsPerEvent, units.count)])
        }) {
            try postUnicode(chunk, down: true)
            try postUnicode(chunk, down: false)
        }
    }

    // MARK: - Event plumbing

    private func post(type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw HostError(.input, "could not create mouse event \(type.rawValue)")
        }
        if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState)) }
        event.post(tap: .cghidEventTap)
    }

    private func postKey(_ code: CGKeyCode, flags: CGEventFlags, down: Bool) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
            throw HostError(.input, "could not create key event for code \(code)")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    private func postFlagsOnly(_ flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
            throw HostError(.input, "could not create modifier event")
        }
        event.type = .flagsChanged
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    private func postUnicode(_ units: [UniChar], down: Bool) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
            throw HostError(.input, "could not create text event")
        }
        var mutable = units
        event.keyboardSetUnicodeString(stringLength: mutable.count, unicodeString: &mutable)
        event.post(tap: .cghidEventTap)
    }

    // MARK: - Coordinates

    private func resolve(_ position: PointerTarget?) throws -> CGPoint {
        guard let position else { return currentCursor() }
        return try globalPoint(normalizedX: position.x, normalizedY: position.y,
                               screen: position.screen, window: position.window)
    }

    private func currentCursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private func globalPoint(normalizedX: Double, normalizedY: Double,
                             screen: Int?, window: CGWindowID?) throws -> CGPoint {
        let displays = try Displays.active()
        let rect: CGRect
        if let window, let windowBounds = WindowList.bounds(of: window),
           windowBounds.width > 0, windowBounds.height > 0 {
            // A window the client is showing on its own. Falls through to the
            // monitor rule when the window has closed or has no area, so a
            // stale id sends the click somewhere harmless rather than mapping
            // it against a rectangle that now belongs to a different window.
            rect = windowBounds
        } else if let selected = screen.flatMap({ Displays.at($0, in: displays) }) {
            // A client that names a monitor is telling us which rectangle it
            // normalized against — the one whose frame it is showing. That
            // outranks the host's InputSpace setting, which exists to answer
            // the same question for clients too old to say.
            rect = selected.bounds
        } else {
            switch InputSpace.configured {
            case .primary:
                rect = (try Displays.primary()).bounds
            case .virtualDesktop:
                rect = Displays.virtualBounds(displays)
            }
        }
        let clampedX = min(max(normalizedX, 0), 1)
        let clampedY = min(max(normalizedY, 0), 1)
        return CGPoint(
            x: rect.minX + clampedX * rect.width,
            y: rect.minY + clampedY * rect.height
        )
    }
}
