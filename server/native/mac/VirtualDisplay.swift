// Driver-backed virtual displays on macOS, via CGVirtualDisplay.
//
// macOS has no third-party display driver model; every virtual display tool
// (DeskPad — MIT, our API reference; BetterDisplay; Chromium's test harness)
// uses the same PRIVATE CoreGraphics API: CGVirtualDisplay. Private means:
//
//   - No header ships in any SDK. Everything here is reached dynamically
//     through the Objective-C runtime (NSClassFromString + KVC + IMP calls),
//     so this file compiles against nothing private and keeps building even
//     if the API vanishes — it then fails at RUNTIME with a structured
//     E_DISPLAY error instead of breaking the whole helper build.
//   - Apple may change it in any release. The blast radius is contained: if
//     any class or selector is missing, `available()` is false and the
//     `virtualdisplay` command reports the reason; capture and input are
//     untouched.
//
// License note (see docs/VIRTUAL-DISPLAY.md for the full survey): this file is
// original code written for Belay. DeskPad (MIT) and Chromium's
// virtual_display_mac_util.mm (BSD-3-Clause) were used as *behavioural*
// references for which properties the descriptor needs; no code is copied.
// Both licenses are permissive and compatible with a proprietary host anyway.
//
// The display lives exactly as long as this process holds a reference to the
// CGVirtualDisplay object: destroy is "drop the reference", and a helper
// crash cleans up by construction — the OS removes the display when the
// owning process dies. That is the safety property that makes this feature
// tolerable to run unattended.

import CoreGraphics
import Foundation
import ObjectiveC

/// Owns at most one virtual display for the lifetime of the helper.
///
/// One, deliberately: the product feature is "render at the client's
/// resolution", and one remote client drives one virtual display. A second
/// create replaces the first (the client changed resolution) rather than
/// accumulating displays the host's owner has to hunt down.
final class VirtualDisplayManager {

    /// What `status` reports and `create` returns.
    struct ActiveDisplay {
        let displayID: UInt32
        let width: Int
        let height: Int
        let refreshHz: Int

        var asDictionary: [String: Any] {
            [
                "displayID": displayID,
                "W": width,
                "H": height,
                "hz": refreshHz,
                "name": VirtualDisplayManager.displayName,
            ]
        }
    }

    /// The name macOS shows in Settings → Displays, and the name
    /// server/src/displays.ts classifies as virtual (it contains "virtual").
    static let displayName = "Belay Virtual Display"

    private var display: AnyObject?
    private var active: ActiveDisplay?

    // MARK: - Availability

    private static let requiredClasses = [
        "CGVirtualDisplay", "CGVirtualDisplayDescriptor",
        "CGVirtualDisplaySettings", "CGVirtualDisplayMode",
    ]

    /// True when every private class this file needs exists in this macOS
    /// release. Checked before every operation so the failure mode is a
    /// structured error, never a crash on a nil class.
    static func available() -> Bool {
        requiredClasses.allSatisfy { NSClassFromString($0) != nil }
    }

    // MARK: - Operations

    /// Creates (or replaces) the virtual display at exactly the requested
    /// mode. Bounds are validated by the caller (main.swift clamps via the
    /// shared Command accessors); this re-checks only what would crash.
    func create(width: Int, height: Int, refreshHz: Int) throws -> ActiveDisplay {
        guard Self.available() else {
            throw HostError(.display,
                "CGVirtualDisplay is unavailable on this macOS release; virtual displays need a macOS that still ships the private API (see docs/VIRTUAL-DISPLAY.md)")
        }
        guard width > 0, height > 0, refreshHz > 0 else {
            throw HostError(.badArgument, "virtual display mode must be positive")
        }

        // Replace-not-stack: drop any existing display first.
        destroy()

        let descriptor = try Self.makeDescriptor(width: width, height: height)
        let newDisplay = try Self.makeDisplay(descriptor: descriptor)
        try Self.apply(width: width, height: height, refreshHz: refreshHz, to: newDisplay)

        guard let idNumber = newDisplay.value(forKey: "displayID") as? NSNumber else {
            throw HostError(.display, "virtual display created but reported no displayID")
        }
        let created = ActiveDisplay(
            displayID: idNumber.uint32Value, width: width, height: height, refreshHz: refreshHz)
        display = newDisplay
        active = created
        return created
    }

    /// Removes the display by releasing the only reference to it. Idempotent:
    /// destroying nothing is a success, so a client can always "make sure
    /// it's gone" without first asking.
    func destroy() {
        display = nil
        active = nil
    }

    /// The CoreGraphics display ID of the live virtual display, or nil when
    /// none is up. This is what `capture` targets when the client asks for the
    /// virtual display: one manager owns exactly one display, so there is never
    /// any ambiguity about which ID "the virtual display" means.
    func activeDisplayID() -> CGDirectDisplayID? {
        active.map { CGDirectDisplayID($0.displayID) }
    }

    func status() -> [String: Any] {
        var payload: [String: Any] = [
            "active": active != nil,
            "supported": Self.available(),
        ]
        if let active { payload["display"] = active.asDictionary }
        return payload
    }

    // MARK: - Private-API plumbing

    /// KVC-configured CGVirtualDisplayDescriptor. Every property named here is
    /// one the API requires to bring a display up; values are arbitrary but
    /// stable so the OS treats rebuilds as the same monitor (layout sticks).
    private static func makeDescriptor(width: Int, height: Int) throws -> NSObject {
        let descriptor = try instantiate("CGVirtualDisplayDescriptor")
        descriptor.setValue(displayName, forKey: "name")
        descriptor.setValue(UInt32(width), forKey: "maxPixelsWide")
        descriptor.setValue(UInt32(height), forKey: "maxPixelsHigh")
        // Physical size at ~96 DPI so text renders at a sane default scale.
        let mm = NSSize(width: Double(width) * 25.4 / 96.0, height: Double(height) * 25.4 / 96.0)
        descriptor.setValue(NSValue(size: mm), forKey: "sizeInMillimeters")
        // "BLAY" spelled in hex-ish; any stable vendor/product pair works.
        descriptor.setValue(UInt32(0xB1AE), forKey: "vendorID")
        descriptor.setValue(UInt32(0x0001), forKey: "productID")
        descriptor.setValue(UInt32(0x0001), forKey: "serialNum")
        descriptor.setValue(DispatchQueue.main, forKey: "queue")
        return descriptor
    }

    /// `[[CGVirtualDisplay alloc] initWithDescriptor:descriptor]`, called
    /// through the raw IMP because the initializer takes an object argument
    /// and returns ownership — `perform` cannot express either safely.
    private static func makeDisplay(descriptor: NSObject) throws -> NSObject {
        let raw = try allocate("CGVirtualDisplay")
        typealias InitWithDescriptor =
            @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<AnyObject>?
        let initFn: InitWithDescriptor = try implementation(
            of: "initWithDescriptor:", on: "CGVirtualDisplay")
        guard let display = initFn(raw, sel("initWithDescriptor:"), descriptor)?
            .takeRetainedValue() as? NSObject else {
            throw HostError(.display, "CGVirtualDisplay initWithDescriptor: returned nil")
        }
        return display
    }

    /// Builds the settings (one mode, exactly the requested one) and applies
    /// them. `applySettings:` returning NO is the API's only failure signal.
    private static func apply(width: Int, height: Int, refreshHz: Int, to display: NSObject) throws {
        let mode = try makeMode(width: width, height: height, refreshHz: refreshHz)
        let settings = try instantiate("CGVirtualDisplaySettings")
        // hiDPI 0: the mode's pixels are the mode's points, so the client gets
        // exactly the pixel count it asked for. A Retina option would set 1
        // and halve the logical size — deliberately not offered yet.
        settings.setValue(UInt32(0), forKey: "hiDPI")
        settings.setValue([mode] as NSArray, forKey: "modes")

        typealias ApplySettings = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        let applyFn: ApplySettings = try implementation(of: "applySettings:", on: "CGVirtualDisplay")
        guard applyFn(display, sel("applySettings:"), settings) else {
            throw HostError(.display,
                "CGVirtualDisplay applySettings: refused \(width)x\(height)@\(refreshHz)")
        }
    }

    private static func makeMode(width: Int, height: Int, refreshHz: Int) throws -> NSObject {
        let raw = try allocate("CGVirtualDisplayMode")
        typealias InitMode =
            @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
        let initFn: InitMode = try implementation(
            of: "initWithWidth:height:refreshRate:", on: "CGVirtualDisplayMode")
        guard let mode = initFn(
            raw, sel("initWithWidth:height:refreshRate:"),
            UInt32(width), UInt32(height), Double(refreshHz))?
            .takeRetainedValue() as? NSObject else {
            throw HostError(.display, "CGVirtualDisplayMode init returned nil")
        }
        return mode
    }

    // MARK: - ObjC runtime helpers

    private static func sel(_ name: String) -> Selector { NSSelectorFromString(name) }

    private static func objcClass(_ name: String) throws -> AnyClass {
        guard let cls = NSClassFromString(name) else {
            throw HostError(.display, "private class \(name) is missing on this macOS release")
        }
        return cls
    }

    /// `[Cls new]` for classes whose plain init is fine (descriptor, settings).
    private static func instantiate(_ name: String) throws -> NSObject {
        guard let type = try objcClass(name) as? NSObject.Type else {
            throw HostError(.display, "private class \(name) is not an NSObject subclass")
        }
        return type.init()
    }

    /// `[Cls alloc]` without init, for classes with custom initializers.
    ///
    /// Ownership: alloc returns +1, and that +1 belongs to the `init...` call
    /// the caller hands the object to (ObjC init CONSUMES its receiver). So
    /// ARC must not also own it — `takeUnretainedValue`, not Retained. Taking
    /// retained here double-released the object and crashed the helper
    /// (SIGSEGV, observed) the first time this ran.
    private static func allocate(_ name: String) throws -> AnyObject {
        let cls = try objcClass(name)
        typealias Alloc = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>
        guard let method = class_getClassMethod(cls, sel("alloc")) else {
            throw HostError(.display, "\(name) has no alloc")
        }
        let allocFn = unsafeBitCast(method_getImplementation(method), to: Alloc.self)
        return allocFn(cls, sel("alloc")).takeUnretainedValue()
    }

    /// The raw IMP of an instance method, typed by the caller. Throws rather
    /// than crashing when a selector is gone — that is the API-drift seam.
    private static func implementation<F>(of selector: String, on className: String) throws -> F {
        let cls = try objcClass(className)
        guard let method = class_getInstanceMethod(cls, sel(selector)) else {
            throw HostError(.display, "\(className) no longer responds to \(selector)")
        }
        return unsafeBitCast(method_getImplementation(method), to: F.self)
    }
}
