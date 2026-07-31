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

import Foundation

private let defaultCaptureWidth = 1280
private let defaultCaptureQuality = 55
private let captureWidthRange = 16...7680
private let captureQualityRange = 1...100

private let replies = ReplyWriter()
private let capture = CaptureEngine()
private let input = InputController()

private func run() {
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
    case "ping": replies.ok(id: command.id, ["pong": true])
    default:
        throw HostError(.badCommand, "unknown command: \(command.name)", details: ["cmd": command.name])
    }
}

// MARK: - Commands

private func handleInfo(_ command: Command) throws {
    let displays = try Displays.active()
    let primary = try Displays.primary()
    replies.ok(id: command.id, [
        "primary": Displays.rectPayload(primary.bounds),
        "virtual": Displays.rectPayload(Displays.virtualBounds(displays)),
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

    let all = try Displays.active()
    let targets = wantsVirtual ? all : [try Displays.primary()]
    let bounds = wantsVirtual ? Displays.virtualBounds(all) : targets[0].bounds

    let tiles = try capture.frames(for: targets)
    let composited = try ImageOutput.composite(tiles: tiles, bounds: bounds, targetWidth: width)
    let jpeg = try ImageOutput.jpeg(composited.image, quality: quality)

    replies.ok(id: command.id, [
        "data": jpeg.base64EncodedString(),
        "w": composited.width,
        "h": composited.height,
        "sw": composited.sourceWidth,
        "sh": composited.sourceHeight,
        "bytes": jpeg.count,
    ])
}

private func handleMove(_ command: Command) throws {
    let position = try requirePosition(command)
    try input.move(normalizedX: position.x, normalizedY: position.y)
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

private func requirePosition(_ command: Command) throws -> (x: Double, y: Double) {
    guard let x = try command.double("x"), let y = try command.double("y") else {
        throw HostError(.badArgument, "'x' and 'y' are required (normalized 0..1)")
    }
    return (x, y)
}

/// `down`/`up`/`click` may omit coordinates, meaning "wherever the cursor is".
private func optionalPosition(_ command: Command) throws -> (x: Double, y: Double)? {
    guard command.has("x") || command.has("y") else { return nil }
    return try requirePosition(command)
}

run()
