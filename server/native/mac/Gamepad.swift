// Keyboard/mouse fallback only. No virtual HID driver on macOS.
import Foundation
import CoreGraphics
import ApplicationServices

final class GamepadKeymap {
    private let queue = DispatchQueue(label: "belay.gamepad")
    private var timer: DispatchSourceTimer?
    private var attached = false
    private var received = ProcessInfo.processInfo.systemUptime
    private var previousTick = ProcessInfo.processInfo.systemUptime
    private var held = Set<CGKeyCode>()
    private var left = false, right = false
    private var rx = 0.0, ry = 0.0
    private var carryX = 0.0, carryY = 0.0
    private var preset = "generic"
    private let masks = [4096,8192,16384,32768,256,512,1,2,4,8,16,32,128,1024,2048]
    // macOS hardware keycodes: Space, Control, R, F, Q, E, arrows, Escape, Tab.
    private let standard: [CGKeyCode?] = [49,59,15,3,12,14,126,125,123,124,53,48,nil,nil,nil]

    func status() -> [String: Any] {
        let available = AXIsProcessTrusted()
        return ["gamepad": "unavailable", "backend": available ? "keymap" : "unavailable",
                "reason": available ? "macOS uses keyboard/mouse fallback" : "Grant Accessibility to the host launcher"]
    }
    func attach(preset: String) {
        queue.sync {
            neutral()
            self.preset = preset
            attached = AXIsProcessTrusted()
            received = ProcessInfo.processInfo.systemUptime
            previousTick = received
            if timer == nil {
                let source = DispatchSource.makeTimerSource(queue: queue)
                source.schedule(deadline: .now(), repeating: .milliseconds(8))
                source.setEventHandler { [weak self] in self?.tick() }
                timer = source
                source.resume()
            }
        }
    }
    func detach() { queue.sync { attached = false; timer?.cancel(); timer = nil; neutral() } }
    func state(_ command: Command) throws {
        func value(_ name: String, _ minimum: Double) throws -> Double {
            guard let n = try command.double(name), n >= minimum, n <= 1 else {
                throw HostError(.badArgument, "Invalid gamepad axis")
            }
            return n
        }
        guard let rawButtons = try command.double("buttons"), rawButtons >= 0, rawButtons <= 65535,
              rawButtons.rounded() == rawButtons else { throw HostError(.badArgument, "Invalid gamepad buttons") }
        let buttons = Int(rawButtons)
        let lx = try value("lx", -1), ly = try value("ly", -1)
        let nrx = try value("rx", -1), nry = try value("ry", -1)
        let lt = try value("lt", 0), rt = try value("rt", 0)
        queue.sync {
            guard attached else { return }
            received = ProcessInfo.processInfo.systemUptime
            rx = nrx; ry = nry
            var wanted = Set<CGKeyCode>()
            for (i, mask) in masks.enumerated() where buttons & mask != 0 {
                var key = standard[i]
                if preset == "roblox", mask == 128 { key = 56 } // Shift-lock on R3
                if preset == "fortnite" {
                    let builds: [Int: CGKeyCode] = [1:6,2:7,4:8,8:9,1024:3,2048:5] // Z X C V F G
                    key = builds[mask] ?? key
                }
                if let key = key { wanted.insert(key) }
            }
            let directions: [(CGKeyCode, Double)] = [(13,ly),(1,-ly),(0,-lx),(2,lx)]
            for (key, axis) in directions {
                if axis > (held.contains(key) ? 0.18 : 0.25) { wanted.insert(key) }
            }
            for key in held.subtracting(wanted) { postKey(key, false) }
            for key in wanted.subtracting(held) { postKey(key, true) }
            held = wanted
            let newLeft = rt > (left ? 0.08 : 0.12), newRight = lt > (right ? 0.08 : 0.12)
            if newLeft != left { postMouse(newLeft ? .leftMouseDown : .leftMouseUp, .left); left = newLeft }
            if newRight != right { postMouse(newRight ? .rightMouseDown : .rightMouseUp, .right); right = newRight }
        }
    }
    private func postKey(_ key: CGKeyCode, _ down: Bool) {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
        if key == 59 { event?.flags = down ? .maskControl : [] }
        if key == 56 { event?.flags = down ? .maskShift : [] }
        event?.post(tap: .cghidEventTap)
    }
    private func postMouse(_ type: CGEventType, _ button: CGMouseButton) {
        let point = CGEvent(source: nil)?.location ?? .zero
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    }
    private func neutral() {
        for key in held { postKey(key, false) }
        held.removeAll()
        if left { postMouse(.leftMouseUp, .left) }
        if right { postMouse(.rightMouseUp, .right) }
        left = false; right = false; rx = 0; ry = 0; carryX = 0; carryY = 0
    }
    private func tick() {
        guard attached else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let dt = min(0.032, max(0, now - previousTick)); previousTick = now
        if now - received > 0.75 { neutral(); return }
        carryX += (abs(rx) > 0.12 ? rx : 0) * 900 * dt
        carryY -= (abs(ry) > 0.12 ? ry : 0) * 900 * dt
        let dx = Int64(carryX), dy = Int64(carryY)
        carryX -= Double(dx); carryY -= Double(dy)
        guard dx != 0 || dy != 0 else { return }
        let point = CGEvent(source: nil)?.location ?? .zero
        let type: CGEventType = left ? .leftMouseDragged : right ? .rightMouseDragged : .mouseMoved
        let event = CGEvent(mouseEventSource: nil, mouseType: type,
                            mouseCursorPosition: CGPoint(x: point.x + Double(dx), y: point.y + Double(dy)),
                            mouseButton: right ? .right : .left)
        event?.setIntegerValueField(.mouseEventDeltaX, value: dx)
        event?.setIntegerValueField(.mouseEventDeltaY, value: dy)
        event?.post(tap: .cghidEventTap)
    }
}
