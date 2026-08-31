// Display identity for the macOS helper — the counterpart of
// TetherHostDisplays.cs on Windows, reporting the same four wire keys so the
// server can read one shape regardless of which host it is talking to.
//
// The question being answered is "which of these displays is a virtual one the
// desktop client may take over?" macOS has no single API that says so. What it
// does expose, and what is reported here verbatim:
//
//   localizedName  the human name — "Built-in Retina Display", "DELL U2720Q",
//                  and, for the software displays people actually use,
//                  "BetterDisplay Virtual" / "Virtual Display". This is the
//                  signal the classifier leans on.
//   isBuiltin      true only for the laptop panel, which is never virtual.
//   vendor/model   IODisplay EDID numbers. Zero for most synthesized displays,
//                  but zero is *also* seen on some real adapters, so this is
//                  carried as evidence and not treated as proof.
//
// As on Windows the judgement itself is deliberately not made here — it lives
// in server/src/displays.ts where it is unit-tested and fixable without a
// recompile of the helper.

import AppKit
import CoreGraphics
import Foundation

enum DisplayIdentity {
    /// NSScreen carries the localized name; CGDirectDisplayID is the only key
    /// the rest of the helper knows a display by. `deviceDescription` is the
    /// documented bridge between the two.
    private static func screen(for id: CGDirectDisplayID) -> NSScreen? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return NSScreen.screens.first { ($0.deviceDescription[key] as? NSNumber)?.uint32Value == id }
    }

    /// Identity strings for one display, keyed exactly as the Windows helper
    /// keys them: device / adapter / monitor / id, plus the macOS-only evidence
    /// the classifier may use.
    ///
    /// Every field is optional and independently best-effort. A display that
    /// answers none of these still appears in the list as a usable rectangle —
    /// an unlabelled monitor is a cosmetic problem, a missing one is not.
    static func describe(_ display: DisplayGeometry) -> [String: Any] {
        let id = display.id
        let builtin = CGDisplayIsBuiltin(id) != 0
        let vendor = CGDisplayVendorNumber(id)
        let model = CGDisplayModelNumber(id)
        let name = screen(for: id)?.localizedName

        return [
            // No `\.\DISPLAYn` equivalent exists; the CG id is the stable
            // handle everything else in this helper uses, so it plays that role.
            "device": "CGDisplay \(id)",
            // The nearest thing to Windows' adapter string. Built-in is worth
            // stating outright because it settles "is this virtual?" on its own.
            "adapter": builtin ? "Built-in display" : NSNull(),
            "monitor": name ?? NSNull(),
            // Shaped as a path-like triple so the classifier's string tests read
            // the same on both platforms. Never claims the `ROOT#` enumerator
            // that means "software display" on Windows — that would be a lie
            // about a different OS's namespace.
            "id": "CGDisplay#\(vendor)#\(model)#\(id)",
            "builtin": builtin,
            "vendor": Int(vendor),
            "model": Int(model),
        ]
    }
}
