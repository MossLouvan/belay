// Tether native host helper for macOS.
//
// The mirror image of server/native/TetherHost.cs: a long-lived console process
// that reads one JSON command per line from stdin and writes one JSON reply per
// line to stdout. server/src/native.ts owns the process and matches replies by
// `id`. The command set is identical across platforms.
//
//   info | capture | move | down | up | click | scroll | key | text | ping
//
// The loop is deliberately single-threaded and synchronous: Node serialises
// requests anyway, and one command at a time means a frame can never interleave
// with an input event on the wire.

import CoreGraphics  // CGWindowID, for the per-window commands
import Foundation

private let defaultCaptureWidth = 1280
private let defaultCaptureQuality = 55
private let captureWidthRange = 16...7680
private let captureQualityRange = 1...100

private let replies = ReplyWriter()
private let capture = CaptureEngine()
private let input = InputController()

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
    input.releaseAll()
    capture.stopAll()
}

private func handle(_ command: Command) throws {
    switch command.name {
    case "info": try handleInfo(command)
    case "capture": try handleCapture(command)
    case "move": try handleMove(command)
    case "down": try handleButton(command, down: true)
    case "up": try handleButton(command, down: false)
    case "click": try handleClick(command)
    case "scroll": try handleScroll(command)
    case "key": try handleKey(command)
    case "text": try handleText(command)
    case "windows": replies.ok(id: command.id, ["windows": WindowList.all()])
    case "capturewindow": try handleCaptureWindow(command)
    case "focuswindow": try handleFocusWindow(command)
    case "ping": replies.ok(id: command.id, ["pong": true])
    default:
        throw HostError(.badCommand, "unknown command: \(command.name)", details: ["cmd": command.name])
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

private func handleCapture(_ command: Command) throws {
    let width = try command.int("w", default: defaultCaptureWidth, clampedTo: captureWidthRange)
    let quality = try command.int("q", default: defaultCaptureQuality, clampedTo: captureQualityRange)
    let wantsVirtual = try command.bool("virtual")

    // `virtual` (the whole desktop) still wins when asked for; otherwise the
    // `screen` index selects one display, falling back to the primary. Same
    // precedence as the Windows helper's DoCapture.
    let screen = try command.int("screen")
    let all = try Displays.active()
    let selected = Displays.at(screen, in: all) ?? (try Displays.primary())
    let targets = wantsVirtual ? all : [selected]
    let bounds = wantsVirtual ? Displays.virtualBounds(all) : selected.bounds

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
    try input.click(button, at: try optionalPosition(command), double: try command.bool("double"))
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
