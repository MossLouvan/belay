// Belay native host helper for macOS.
//
// The mirror image of server/native/BelayHost.cs: a long-lived console process
// that reads one JSON command per line from stdin and writes one JSON reply per
// line to stdout. server/src/native.ts owns the process and matches replies by
// `id`. The command set is identical across platforms.
//
//   info | capture | move | down | up | click | scroll | key | text | ping
//   clipboard (get/set — two-way clipboard sync with the phone)
//   audiostart | audiostop | audiostatus  (driverless system-audio loopback)
//   authowner  (Touch ID or the login password; replies when the person answers)
//
// The loop is single-threaded and synchronous for everything except input.
// Node writes every command the moment it has it, and the helper answered them
// in order — so a click that arrived during a 30 ms capture waited for it.
// Mouse and keyboard commands now run on their own serial queue (`inputQueue`),
// which keeps them ordered among themselves but never behind a frame. Replies
// are id-matched and ReplyWriter locks the pipe, so lines never interleave.

import CoreGraphics  // CGWindowID, for the per-window commands
import Foundation

private let defaultCaptureWidth = 1280
private let defaultCaptureQuality = 55
private let captureWidthRange = 16...7680
private let captureQualityRange = 1...100

private let replies = ReplyWriter()
private let capture = CaptureEngine()
/// Touched only from `inputQueue` (and from `run()` on exit, via a sync hop):
/// InputController keeps `heldButtons`, which must never race.
private let input = InputController()
private let inputQueue = DispatchQueue(label: "belay.input", qos: .userInteractive)
private let gamepad = GamepadKeymap()
private let virtualDisplays = VirtualDisplayManager()

// Mode bounds mirror server/src/virtual-display.ts. Node validates before
// sending; the helper clamps again because stdin is a boundary of its own.
private let virtualWidthRange = 640...7680
private let virtualHeightRange = 480...4320
private let virtualRefreshRange = 24...240

#if BELAY_WEBRTC_BUILD
// HARDWARE-GATED: only exists in a BELAY_WEBRTC_BUILD=1 build (build-mac.sh);
// the shipping helper compiles none of the WebRTC sources.
private let webrtc = WebRTCVerb(replies: replies, capture: capture, input: input)
#endif
private let audio = SystemAudioCapture(replies: replies)
// H.264 over the screen socket (encode/H264Session.swift): frames leave on
// file descriptor 3, never on stdout.
private let h264 = H264Session(capture: capture)
private let h264FpsRange = 1...120

private func run() {
    // Without this the process is killed outright the moment stdout closes —
    // confirmed empirically: closing stdout produced an immediate SIGPIPE and
    // the helper died. Node then has no capture or input until the whole agent
    // is restarted, so one transient pipe hiccup took the feature away for the
    // life of the session. Ignoring it turns the same event into a write error
    // the loop can see and exit cleanly on.
    signal(SIGPIPE, SIG_IGN)

    let permissions = Permissions.requestMissing()
    replies.ready([
        "platform": "darwin",
        "permissions": permissions.asDictionary,
        "inputSpace": InputSpace.configured.rawValue,
        "warnings": Permissions.warnings(for: permissions),
    ])

    while let line = readLine(strippingNewline: true) {
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
        var id: Any = NSNull()
        do {
            let command = try Command.parse(line: line)
            id = command.id
            try handle(command)
        } catch {
            replies.failure(id: id, HostError.wrap(error))
        }
    }
    // stdin closed: Node is gone or shutting down. Release anything we are
    // holding down before exiting, or the OS keeps a mouse button or modifier
    // physically pressed — a phone that disconnects mid-drag would otherwise
    // leave the desktop stuck in a drag with no way to clear it.
    gamepad.detach()
    inputQueue.sync { input.releaseAll() }
    #if BELAY_WEBRTC_BUILD
    webrtc.stop() // close the peer + encoder before the capture streams they feed
    #endif
    h264.stop()
    capture.stopAll()
    // Releasing the reference removes the display; a crash would too (the OS
    // tears it down with the owning process), but exiting cleanly means the
    // host's desktop is back to normal before Node reports us gone.
    virtualDisplays.destroy()
    audio.stop()
}

private func handle(_ command: Command) throws {
    switch command.name {
    case "gamepad": try gamepad.state(command) // fire-and-forget fast path
    case "gamepadstatus": replies.ok(id: command.id, gamepad.status())
    case "gamepadattach":
        gamepad.attach(preset: try command.string("preset") ?? "generic")
        replies.ok(id: command.id, gamepad.status())
    case "gamepaddetach": gamepad.detach(); replies.ok(id: command.id)
    case "info": try handleInfo(command)
    case "capture": try handleCapture(command)
    case "move": onInputQueue(command, handleMove)
    case "down": onInputQueue(command) { try handleButton($0, down: true) }
    case "up": onInputQueue(command) { try handleButton($0, down: false) }
    case "click": onInputQueue(command, handleClick)
    case "scroll": onInputQueue(command, handleScroll)
    case "key": onInputQueue(command, handleKey)
    case "text": onInputQueue(command, handleText)
    case "idle": try handleIdle(command)
    case "windows": replies.ok(id: command.id, ["windows": WindowList.all()])
    case "capturewindow": try handleCaptureWindow(command)
    case "focuswindow": try handleFocusWindow(command)
    case "virtualdisplay": try handleVirtualDisplay(command)
    case "clipboard": try handleClipboard(command)
    case "audiostart": try handleAudioStart(command)
    case "audiostop": audio.stop(); replies.ok(id: command.id)
    case "audiostatus": handleAudioStatus(command)
    case "h264start": try handleH264Start(command)
    case "h264stop": h264.stop(); replies.ok(id: command.id)
    case "h264key": h264.requestKeyframe(); replies.ok(id: command.id)
    case "h264status": replies.ok(id: command.id, h264.status())
    case "ping": replies.ok(id: command.id, ["pong": true])
    case "authowner": try OwnerAuth.handle(command, replies: replies)
    case "webrtc":
        #if BELAY_WEBRTC_BUILD
        try webrtc.handle(command)
        #else
        // A clean, explicit refusal (not a hang): Node's /ws/webrtc bridge sees
        // the error reply and the phone stays on the JPEG path.
        throw HostError(.badCommand,
            "webrtc transport is not built into this helper "
            + "(rebuild with BELAY_WEBRTC_BUILD=1 — see docs/WEBRTC-SLICE.md); JPEG stays the transport",
            details: ["cmd": command.name])
        #endif
    default:
        throw HostError(.badCommand, "unknown command: \(command.name)", details: ["cmd": command.name])
    }
}

/// Run an input command off the capture thread. The command is a value and
/// the reply carries its own id, so nothing here is shared with the main loop.
private func onInputQueue(_ command: Command, _ body: @escaping (Command) throws -> Void) {
    inputQueue.async {
        do { try body(command) } catch { replies.failure(id: command.id, HostError.wrap(error)) }
    }
}

// MARK: - Commands

private func handleInfo(_ command: Command) throws {
    let displays = try Displays.active()
    let primary = try Displays.primary()
    // One entry per display, in `active()` order — that position is the index
    // a client passes back as `screen`, so capture and input agree on which
    // rectangle it means. Identity strings ride along so the client can tell a
    // virtual display from the one a human is sitting in front of.
    let screens: [[String: Any]] = displays.enumerated().map { index, display in
        var entry: [String: Any] = ["index": index, "primary": display.id == CGMainDisplayID()]
        entry.merge(Displays.rectPayload(display.bounds)) { current, _ in current }
        entry.merge(DisplayIdentity.describe(display)) { current, _ in current }
        return entry
    }
    replies.ok(id: command.id, [
        "primary": Displays.rectPayload(primary.bounds),
        "virtual": Displays.rectPayload(Displays.virtualBounds(displays)),
        "screens": screens,
        "platform": "darwin",
        "scale": Double(primary.scale),
        "displays": displays.count,
        "permissions": Permissions.status().asDictionary,
        "inputSpace": InputSpace.configured.rawValue,
    ])
}

/// The one display a `screen`/`virtualdisplay` request names. The driver-backed
/// virtual display (the client's exact resolution) wins when asked for;
/// otherwise the `screen` index selects a physical display, falling back to
/// the primary.
private func selectedDisplay(_ command: Command) throws -> DisplayGeometry {
    if try command.bool("virtualdisplay") {
        // The Node side only sets this after a successful create, but the
        // display can still vanish (helper restart, API drift); a clear error
        // lets the stream fall back rather than capturing the wrong screen.
        guard let vid = virtualDisplays.activeDisplayID() else {
            throw HostError(.capture,
                "no virtual display is active; create one before capturing it")
        }
        return Displays.geometry(of: vid)
    }
    return try Displays.at(try command.int("screen"), in: Displays.active()) ?? Displays.primary()
}

private func handleCapture(_ command: Command) throws {
    let width = try command.int("w", default: defaultCaptureWidth, clampedTo: captureWidthRange)
    let quality = try command.int("q", default: defaultCaptureQuality, clampedTo: captureQualityRange)
    // Precedence: one display as `selectedDisplay` resolves it, unless
    // `virtual` asks for the whole desktop union (physical displays only).
    let wantsUnion = try command.bool("virtual") && !(try command.bool("virtualdisplay"))
    let all = try Displays.active()
    let selected = try selectedDisplay(command)
    let targets = wantsUnion ? all : [selected]
    let bounds = wantsUnion ? Displays.virtualBounds(all) : selected.bounds

    let tiles = try capture.frames(for: targets)
    let composited = try ImageOutput.composite(
        tiles: tiles.map { (geometry: $0.geometry, image: $0.image) },
        bounds: bounds, targetWidth: width
    )
    let jpeg = try ImageOutput.jpeg(composited.image, quality: quality)

    // Age of the oldest tile in the composite. Reported on every reply so a
    // frozen picture is visible in the data rather than only to the human
    // looking at it; `stale` is advisory, not an error (see CaptureEngine).
    let age = tiles.map(\.age).max() ?? 0
    var payload: [String: Any] = [
        "data": jpeg.base64EncodedString(),
        "w": composited.width,
        "h": composited.height,
        "sw": composited.sourceWidth,
        "sh": composited.sourceHeight,
        "bytes": jpeg.count,
        "ageMs": Int((age * 1000).rounded()),
    ]
    if age >= CaptureEngine.staleFrameSeconds {
        payload["stale"] = true
        payload["warning"] = "frame is \(Int((age * 1000).rounded())) ms old — the desktop may simply be idle, "
            + "as ScreenCaptureKit delivers no frames while nothing changes"
    }
    replies.ok(id: command.id, payload)
}

/// Start (or retune) hardware H.264 of one display. Frames leave on fd 3 from
/// here on; the reply carries the encoded and source sizes. Idempotent: a
/// second start re-sizes the running session and its first frame is an IDR.
private func handleH264Start(_ command: Command) throws {
    let width = try command.int("w", default: defaultCaptureWidth, clampedTo: captureWidthRange)
    let quality = try command.int("q", default: defaultCaptureQuality, clampedTo: captureQualityRange)
    let fps = try command.int("fps", default: 30, clampedTo: h264FpsRange)
    let geometry = try h264.start(display: try selectedDisplay(command), width: width, fps: fps, quality: quality)
    var payload = H264Session.payload(geometry)
    payload["fps"] = fps
    replies.ok(id: command.id, payload)
}

/// One window's own pixels, plus where that window currently is.
///
/// The rectangle rides along with every frame because it is the only signal a
/// seamless client gets that the user moved or resized the window on the host.
/// A window that has gone is an error rather than an empty frame: the client's
/// answer to it is to close, which it cannot decide from a black picture.
private func handleCaptureWindow(_ command: Command) throws {
    try Permissions.require(.screenRecording)
    guard let id = WindowList.parse(try command.string("window")) else {
        throw HostError(.badArgument, "'window' must be a window id from the `windows` command")
    }
    let width = try command.int("w", default: defaultCaptureWidth, clampedTo: captureWidthRange)
    let quality = try command.int("q", default: defaultCaptureQuality, clampedTo: captureQualityRange)

    guard let bounds = WindowList.bounds(of: id) else {
        throw HostError(.capture, "window \(id) no longer exists")
    }
    let rect: [String: Any] = [
        "X": Int(bounds.origin.x.rounded()), "Y": Int(bounds.origin.y.rounded()),
        "W": Int(bounds.width.rounded()), "H": Int(bounds.height.rounded()),
    ]

    // No image for a window that is on screen is not a failure — a window
    // minimized to the Dock, or on another Space, has nothing to draw. Reported
    // the same way the Windows helper reports a minimized window, so a client
    // keeps the last frame and says why rather than painting black.
    guard let image = WindowList.image(of: id) else {
        replies.ok(id: command.id, ["hidden": true, "rect": rect])
        return
    }

    let scaled = try ImageOutput.scaled(image, targetWidth: width)
    let jpeg = try ImageOutput.jpeg(scaled.image, quality: quality)
    replies.ok(id: command.id, [
        "data": jpeg.base64EncodedString(),
        "w": scaled.width, "h": scaled.height,
        "sw": scaled.sourceWidth, "sh": scaled.sourceHeight,
        "bytes": jpeg.count,
        "rect": rect,
        "title": WindowList.title(of: id),
    ])
}

/// Raise a window on the host so typed input reaches it.
///
/// `focused: false` is a real outcome rather than an error: without the
/// Accessibility grant, or for an application that exposes no matching window,
/// there is nothing to raise and the client says so.
private func handleFocusWindow(_ command: Command) throws {
    try Permissions.require(.accessibility)
    guard let id = WindowList.parse(try command.string("window")) else {
        throw HostError(.badArgument, "'window' must be a window id from the `windows` command")
    }
    replies.ok(id: command.id, ["focused": WindowList.focus(id)])
}

private func handleMove(_ command: Command) throws {
    let position = try requirePosition(command)
    try input.move(normalizedX: position.x, normalizedY: position.y,
                   screen: position.screen, window: position.window)
    replies.ok(id: command.id)
}

private func handleButton(_ command: Command, down: Bool) throws {
    let button = try MouseButton.parse(try command.string("button"))
    let position = try optionalPosition(command)
    if down { try input.press(button, at: position) } else { try input.release(button, at: position) }
    replies.ok(id: command.id)
}

private func handleClick(_ command: Command) throws {
    let button = try MouseButton.parse(try command.string("button"))
    try input.click(button, at: try optionalPosition(command), double: try command.bool("double"),
                    count: try command.int("count", default: 1, clampedTo: 1...2))
    replies.ok(id: command.id)
}

private func handleScroll(_ command: Command) throws {
    try input.scroll(deltaY: try command.double("dy") ?? 0, deltaX: try command.double("dx") ?? 0)
    replies.ok(id: command.id)
}

private func handleKey(_ command: Command) throws {
    try input.key(try command.int("vk"), modifiers: try command.intArray("mods"))
    replies.ok(id: command.id)
}

private func handleText(_ command: Command) throws {
    try input.type(try command.string("text") ?? "")
    replies.ok(id: command.id)
}

/// How long the host has been idle, in milliseconds.
///
/// Used by the input floor to detect a human at the keyboard: when a local user
/// is typing or moving the mouse, remote input is frozen for a few seconds so
/// the person physically at the machine always wins. The Windows helper has had
/// this since PR #15; the macOS equivalent is `CGEventSourceSecondsSinceLastEventType`,
/// which is what this implements.
///
/// The probe counts injected input too, exactly like Windows `GetLastInputInfo`.
/// The server records when it injects and discounts readings landing within 400 ms
/// of that (see `isLocalActivity` in server/src/input-floor.ts), so a remote
/// click does not freeze out the user who sent it.
private func handleIdle(_ command: Command) throws {
    // CGEventSourceSecondsSinceLastEventType: seconds (fractional) since the last
    // event of the specified type. `.combinedSessionState` includes both the
    // current user session and the system (vs `.hidSystemState` which is
    // hardware-only and misses some input). We check both mouse and keyboard
    // events and take the minimum — activity on either counts as "the human is here".
    let mouseIdle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .mouseMoved)
    let keyIdle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    
    // Take the minimum: if either is recent, the user is active
    let idleSeconds = min(mouseIdle, keyIdle)
    let idleMs = Int((idleSeconds * 1000).rounded())
    
    replies.ok(id: command.id, ["idleMs": idleMs])
}

/// Driver-backed virtual display management (on by default; the Node side
/// honours BELAY_VIRTUAL_DISPLAY=0 as the off switch and validates first — see
/// server/src/virtual-display.ts and docs/VIRTUAL-DISPLAY.md).
///
/// One command, an `action` verb, three actions:
///   create  {w, h, hz} → makes (or replaces) the display at exactly that mode
///   destroy            → removes it (idempotent)
///   status             → whether one is active, and whether this macOS can
private func handleVirtualDisplay(_ command: Command) throws {
    switch try command.string("action") ?? "" {
    case "create":
        guard let w = try command.int("w"), let h = try command.int("h") else {
            throw HostError(.badArgument, "'w' and 'h' are required for create")
        }
        guard virtualWidthRange.contains(w), virtualHeightRange.contains(h) else {
            throw HostError(.badArgument,
                "virtual display size must be \(virtualWidthRange.lowerBound)x\(virtualHeightRange.lowerBound)..\(virtualWidthRange.upperBound)x\(virtualHeightRange.upperBound)")
        }
        let hz = try command.int("hz", default: 60, clampedTo: virtualRefreshRange)
        let created = try virtualDisplays.create(width: w, height: h, refreshHz: hz)
        replies.ok(id: command.id, ["display": created.asDictionary])
    case "destroy":
        virtualDisplays.destroy()
        replies.ok(id: command.id, ["destroyed": true])
    case "status":
        replies.ok(id: command.id, virtualDisplays.status())
    case let other:
        throw HostError(.badArgument, "unknown virtualdisplay action: \(other)")
    }
}

/// Clipboard sync (see Clipboard.swift). One command, an `action` verb:
///   get          → the pasteboard's plain text, capped, `truncated` when cut
///   set  {text}  → replaces the pasteboard's contents with `text`
///
/// Node validates size first (server/src/clipboard.ts); the helper rejects an
/// over-cap `set` again because stdin is a boundary of its own.
private func handleClipboard(_ command: Command) throws {
    switch try command.string("action") ?? "" {
    case "get":
        let readout = HostClipboard.read()
        var payload: [String: Any] = ["text": readout.text]
        if readout.truncated { payload["truncated"] = true }
        replies.ok(id: command.id, payload)
    case "set":
        guard let text = try command.string("text") else {
            throw HostError(.badArgument, "'text' is required for set")
        }
        guard text.utf16.count <= HostClipboard.maxTextUnits else {
            throw HostError(.badArgument,
                "clipboard text exceeds the \(HostClipboard.maxTextUnits)-unit cap")
        }
        guard HostClipboard.write(text) else {
            throw HostError(.internalFailure, "the pasteboard refused the write")
        }
        replies.ok(id: command.id, ["set": true])
    case let other:
        throw HostError(.badArgument, "unknown clipboard action: \(other)")
    }
}

// MARK: - System audio (driverless loopback — see AudioCapture.swift)

/// Start pushing 20 ms system-audio frames as `type:"audio"` lines. Rides the
/// same Screen & System Audio Recording grant as capture; idempotent.
private func handleAudioStart(_ command: Command) throws {
    try audio.start()
    replies.ok(id: command.id, [
        "capturing": true,
        "codec": "pcm16",
        "sampleRate": SystemAudioCapture.sampleRate,
        "channels": SystemAudioCapture.channels,
    ])
}

private func handleAudioStatus(_ command: Command) {
    var payload: [String: Any] = ["capturing": audio.isCapturing, "codec": "pcm16"]
    if let reason = audio.lastStopReason { payload["stopReason"] = reason }
    replies.ok(id: command.id, payload)
}

// MARK: - Argument helpers

private func requirePosition(_ command: Command) throws -> PointerTarget {
    guard let x = try command.double("x"), let y = try command.double("y") else {
        throw HostError(.badArgument, "'x' and 'y' are required (normalized 0..1)")
    }
    // Optional and unvalidated here on purpose: an index naming no display is
    // resolved to the primary further down (Displays.at), so a stale monitor
    // index degrades to the old single-monitor behaviour instead of failing
    // the click.
    return (x, y, try command.int("screen"), WindowList.parse(try command.string("window")))
}

/// `down`/`up`/`click` may omit coordinates, meaning "wherever the cursor is".
private func optionalPosition(_ command: Command) throws -> PointerTarget? {
    guard command.has("x") || command.has("y") else { return nil }
    return try requirePosition(command)
}

run()
