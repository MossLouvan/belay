// Wire protocol: one JSON object per line in on stdin, one JSON object per line
// out on stdout. Identical contract to the Windows helper (BelayHost.cs) so the
// Node side (server/src/native.ts) needs no per-platform message handling.
//
// Everything arriving on stdin is untrusted. `Command` is the only way the rest
// of the program reads it, and every accessor validates the type it wants.

import Foundation

/// A validated inbound command. `id` is echoed back verbatim so the Node side
/// can match the reply; anything that is not a JSON number or string becomes
/// null rather than being rejected outright (the id is the caller's business).
struct Command {
    let id: Any
    let name: String
    private let raw: [String: Any]

    /// Parses one line of stdin. Throws `HostError` for anything malformed.
    ///
    /// Note on encoding: by the time a line reaches here it is already a Swift
    /// `String`, and `readLine` repairs malformed UTF-8 lossily on the way in —
    /// bad bytes become U+FFFD rather than being rejected. Re-encoding a
    /// `String` to UTF-8 therefore always succeeds, so the guard below is a
    /// belt-and-braces check, not the encoding gate. That is deliberate: JSON's
    /// structural characters are all ASCII, so lossy repair can only ever
    /// corrupt the *contents* of a string value (into replacement characters),
    /// never the shape of the message. Reading raw bytes to reject such input
    /// outright would buy nothing beyond a slightly better error message.
    static func parse(line: String) throws -> Command {
        guard let data = line.data(using: .utf8) else {
            throw HostError(.badJSON, "command line could not be encoded as UTF-8")
        }
        let any: Any
        do {
            any = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw HostError(.badJSON, "malformed JSON: \(error.localizedDescription)")
        }
        guard let object = any as? [String: Any] else {
            throw HostError(.badJSON, "command must be a JSON object")
        }
        let id = Command.normalizeID(object["id"])
        guard let name = object["cmd"] as? String, !name.isEmpty else {
            throw HostError(.badCommand, "missing or non-string 'cmd' field", details: ["id": id])
        }
        return Command(id: id, name: name, raw: object)
    }

    private static func normalizeID(_ value: Any?) -> Any {
        if let number = value as? NSNumber { return number }
        if let string = value as? String { return string }
        return NSNull()
    }

    // MARK: - Typed accessors

    private func present(_ key: String) -> Any? {
        guard let value = raw[key], !(value is NSNull) else { return nil }
        return value
    }

    func has(_ key: String) -> Bool { present(key) != nil }

    /// Optional double. Throws if present but not numeric, so a client bug
    /// surfaces as an error reply instead of a silent zero.
    func double(_ key: String) throws -> Double? {
        guard let value = present(key) else { return nil }
        guard let number = value as? NSNumber, !(value is NSString) else {
            throw HostError(.badArgument, "'\(key)' must be a number", details: ["field": key])
        }
        let d = number.doubleValue
        guard d.isFinite else {
            throw HostError(.badArgument, "'\(key)' must be finite", details: ["field": key])
        }
        return d
    }

    func int(_ key: String) throws -> Int? {
        guard let d = try double(key) else { return nil }
        return Int(d.rounded())
    }

    /// Integer clamped into `range`, or `fallback` when absent. Clamping rather
    /// than rejecting keeps a slightly out-of-range client usable.
    func int(_ key: String, default fallback: Int, clampedTo range: ClosedRange<Int>) throws -> Int {
        guard let value = try int(key) else { return fallback }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    func string(_ key: String) throws -> String? {
        guard let value = present(key) else { return nil }
        guard let string = value as? String else {
            throw HostError(.badArgument, "'\(key)' must be a string", details: ["field": key])
        }
        return string
    }

    func bool(_ key: String) throws -> Bool {
        guard let value = present(key) else { return false }
        if let number = value as? NSNumber { return number.boolValue }
        throw HostError(.badArgument, "'\(key)' must be a boolean", details: ["field": key])
    }

    /// Array of integers (used for `mods`). Non-numeric entries are an error.
    func intArray(_ key: String) throws -> [Int] {
        guard let value = present(key) else { return [] }
        guard let array = value as? [Any] else {
            throw HostError(.badArgument, "'\(key)' must be an array", details: ["field": key])
        }
        return try array.map { element in
            guard let number = element as? NSNumber, !(element is NSString) else {
                throw HostError(.badArgument, "'\(key)' entries must be numbers", details: ["field": key])
            }
            return number.intValue
        }
    }
}

/// Serialises replies and writes them as single lines. All writes go through
/// one lock so a reply can never be interleaved even if a future change moves
/// work off the reader thread.
final class ReplyWriter {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func ok(id: Any, _ extra: [String: Any] = [:]) {
        write(merge(["id": id, "ok": true], extra))
    }

    func failure(id: Any, _ error: HostError) {
        // A command that failed during parsing never reached the caller's `id`
        // variable, so fall back to the id the error itself carries.
        let correlation = id is NSNull ? (error.details["id"] ?? id) : id
        var payload: [String: Any] = ["ok": false, "error": error.message, "code": error.code.rawValue]
        payload = merge(payload, error.details)
        payload["id"] = correlation // details must never override the correlation id
        write(payload)
    }

    /// The startup banner. Node keys off `ready`; the rest is diagnostic.
    func ready(_ extra: [String: Any] = [:]) {
        write(merge(["id": 0, "ok": true, "ready": true], extra))
    }

    private func merge(_ base: [String: Any], _ extra: [String: Any]) -> [String: Any] {
        extra.reduce(into: base) { result, pair in result[pair.key] = pair.value }
    }

    private func write(_ payload: [String: Any]) {
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: payload, options: [])
        } catch {
            // Last resort: a reply we cannot serialise still has to reach Node,
            // otherwise the caller hangs until its timeout.
            let escaped = "\(error)".replacingOccurrences(of: "\"", with: "'")
            data = Data("{\"id\":null,\"ok\":false,\"code\":\"E_INTERNAL\",\"error\":\"reply serialisation failed: \(escaped)\"}".utf8)
        }
        lock.lock()
        defer { lock.unlock() }
        handle.write(data)
        handle.write(Data("\n".utf8))
    }
}
