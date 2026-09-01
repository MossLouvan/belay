// macOS TCC permission gates.
//
// Two separate consents are required and they fail very differently:
//
//   Screen Recording  -> without it ScreenCaptureKit returns either an error or
//                        a black/desktop-only frame. Silent black frames are the
//                        worst outcome for a remote-desktop tool, so we preflight
//                        and refuse rather than stream a blank screen.
//   Accessibility     -> without it CGEvent.post() is accepted and then dropped.
//                        There is no error return at all, so again we preflight.
//
// Important and widely tripped over: TCC grants the permission to the
// *responsible* process, which for a helper spawned by `npm start` is Terminal
// (or iTerm, or whatever launched node) — not this binary and not node. The
// entry the user must tick in System Settings is therefore their terminal app.

import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

enum PermissionKind: String {
    case screenRecording = "screen-recording"
    case accessibility = "accessibility"

    var settingsPane: String {
        switch self {
        case .screenRecording: return "Privacy & Security → Screen & System Audio Recording"
        case .accessibility: return "Privacy & Security → Accessibility"
        }
    }

    var errorCode: HostErrorCode {
        switch self {
        case .screenRecording: return .screenPermission
        case .accessibility: return .inputPermission
        }
    }
}

struct PermissionStatus {
    let screenRecording: Bool
    let accessibility: Bool

    var asDictionary: [String: Any] {
        ["screenRecording": screenRecording, "accessibility": accessibility]
    }
}

enum Permissions {
    /// Set `BELAY_MAC_NO_PROMPT=1` to suppress the one-time system dialogs
    /// (useful when the helper runs unattended under launchd).
    private static var promptingEnabled: Bool {
        productEnv("MAC_NO_PROMPT") != "1"
    }

    /// Whether we were started by launchd rather than from a terminal.
    ///
    /// It matters because the advice is completely different. Launched from a
    /// terminal, the grant attaches to that terminal app and the user has to
    /// find it by name. Launched by launchd there is no such app — the
    /// responsible process is the node binary itself, macOS cannot show a
    /// prompt for a background job, and the only route is adding that binary by
    /// hand with the + button.
    static var startedByLaunchd: Bool {
        // launchd sets neither of these; every terminal emulator sets at least
        // one. XPC_SERVICE_NAME is present for launchd-managed jobs.
        let env = ProcessInfo.processInfo.environment
        if env["TERM_PROGRAM"] != nil || env["TERM"] != nil { return false }
        return env["XPC_SERVICE_NAME"] != nil
    }

    /// Name of the process macOS will actually list in System Settings.
    static var responsibleProcessName: String {
        if startedByLaunchd { return nodeBinaryPath }
        return ProcessInfo.processInfo.environment["TERM_PROGRAM"]
            ?? ProcessInfo.processInfo.environment["__CFBundleIdentifier"]
            ?? "the app that launched the Belay server (usually Terminal)"
    }

    /// Absolute path of the node binary running the server, for the + button.
    private static var nodeBinaryPath: String {
        // The helper's parent is the node process that spawned it. Reading the
        // executable path off our own parent is more reliable than guessing at
        // a Homebrew or system location.
        let parent = getppid()
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        if proc_pidpath(parent, &buffer, UInt32(buffer.count)) > 0 {
            return String(cString: buffer)
        }
        return "the node binary running the Belay server"
    }

    /// Test seam. `BELAY_MAC_FORCE_DENY=screen-recording,accessibility` makes
    /// the preflight report those grants as missing, so the denial path can be
    /// exercised on a machine where they are actually granted. It can only ever
    /// remove access, never add it.
    private static var forcedDenials: Set<String> {
        let raw = productEnv("MAC_FORCE_DENY") ?? ""
        return Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    }

    private static func isForcedDenied(_ kind: PermissionKind) -> Bool {
        forcedDenials.contains(kind.rawValue)
    }

    static func status() -> PermissionStatus {
        PermissionStatus(
            screenRecording: hasScreenRecording(),
            accessibility: hasAccessibility(prompt: false)
        )
    }

    static func hasScreenRecording() -> Bool {
        !isForcedDenied(.screenRecording) && CGPreflightScreenCaptureAccess()
    }

    static func hasAccessibility(prompt: Bool) -> Bool {
        guard !isForcedDenied(.accessibility) else { return false }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Fires the system consent dialogs once at startup for anything missing.
    /// Returns the status after asking — the first call always reports `false`
    /// because the user has not answered the dialog yet.
    @discardableResult
    static func requestMissing() -> PermissionStatus {
        guard promptingEnabled else { return status() }
        if !hasScreenRecording() { _ = CGRequestScreenCaptureAccess() }
        if !hasAccessibility(prompt: false) { _ = hasAccessibility(prompt: true) }
        return status()
    }

    /// Throws a fully actionable error when `kind` is not granted.
    static func require(_ kind: PermissionKind) throws {
        let granted = kind == .screenRecording ? hasScreenRecording() : hasAccessibility(prompt: false)
        guard !granted else { return }
        throw denied(kind)
    }

    static func denied(_ kind: PermissionKind) -> HostError {
        let owner = responsibleProcessName
        let message: String
        if startedByLaunchd {
            // No launching app exists, and macOS will not prompt for a
            // background job, so naming a terminal here would send the user
            // looking for something that is not involved.
            message = """
            macOS \(kind.rawValue) permission is not granted, and Belay was started by \
            launchd so macOS cannot prompt for it. Open System Settings → \(kind.settingsPane), \
            click +, and add this binary directly: \(owner). Then run: \
            npm run autostart -- remove && npm run autostart. Terminal, Files and System \
            work without this; only the Screen tab needs it.
            """
        } else {
            message = """
            macOS \(kind.rawValue) permission is not granted. \
            Open System Settings → \(kind.settingsPane) and enable "\(owner)" \
            (the permission is granted to the app that launched the Belay server, not to node itself), \
            then fully quit and reopen it and restart the server.
            """
        }
        return HostError(kind.errorCode, message, details: [
            "permission": kind.rawValue,
            "settingsPane": kind.settingsPane,
            "responsibleProcess": owner,
            "recoverable": true,
        ])
    }

    /// Human-readable warnings for the startup banner.
    static func warnings(for status: PermissionStatus) -> [String] {
        var out: [String] = []
        if !status.screenRecording { out.append(denied(.screenRecording).message) }
        if !status.accessibility { out.append(denied(.accessibility).message) }
        return out
    }
}
