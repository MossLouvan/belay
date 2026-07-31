// Modifier CGKeyCode -> CGEventFlags.
//
// The wire protocol sends modifiers as key codes (mirroring the Windows helper,
// which sends virtual-key codes). On macOS the reliable way to apply a modifier
// to a synthetic key press is to set the event's flags, not to post separate
// modifier key-down events — applications read the flags, and stray physical
// modifier events can leak into whatever the user is really typing.
//
// Codes are the classic Carbon kVK_* values (Events.h), which are layout
// independent for modifiers.

import CoreGraphics

enum ModifierKeys {
    static let command: Int = 0x37
    static let rightCommand: Int = 0x36
    static let shift: Int = 0x38
    static let rightShift: Int = 0x3C
    static let capsLock: Int = 0x39
    static let option: Int = 0x3A
    static let rightOption: Int = 0x3D
    static let control: Int = 0x3B
    static let rightControl: Int = 0x3E
    static let function: Int = 0x3F

    private static let table: [Int: CGEventFlags] = [
        command: .maskCommand,
        rightCommand: .maskCommand,
        shift: .maskShift,
        rightShift: .maskShift,
        capsLock: .maskAlphaShift,
        option: .maskAlternate,
        rightOption: .maskAlternate,
        control: .maskControl,
        rightControl: .maskControl,
        function: .maskSecondaryFn,
    ]

    /// Unknown codes are ignored rather than rejected: an older or newer client
    /// sending a modifier we do not model should still get its base key press.
    static func flags(for keyCodes: [Int]) -> CGEventFlags {
        keyCodes.reduce(into: CGEventFlags()) { result, code in
            if let flag = table[code] { result.insert(flag) }
        }
    }

    static func isModifier(_ keyCode: Int) -> Bool { table[keyCode] != nil }
}
