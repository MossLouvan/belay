// Structured errors for the macOS native host.
//
// Every failure that reaches the stdio loop carries a stable machine-readable
// `code` plus a human message the Node layer can show verbatim. Nothing is ever
// swallowed: an unrecognised Swift error still becomes an `E_INTERNAL` reply
// rather than a crash or a dropped line.

import Foundation

/// Stable error codes. These are part of the wire contract; do not renumber or
/// reuse a retired value.
enum HostErrorCode: String {
    case badJSON = "E_BAD_JSON"
    case badCommand = "E_BAD_COMMAND"
    case badArgument = "E_BAD_ARG"
    case screenPermission = "E_PERM_SCREEN"
    case inputPermission = "E_PERM_INPUT"
    case display = "E_DISPLAY"
    case capture = "E_CAPTURE"
    case encode = "E_ENCODE"
    case input = "E_INPUT"
    case internalFailure = "E_INTERNAL"
}

/// An error with everything the reply needs. `details` is merged into the JSON
/// reply alongside `error`/`code`, so callers can branch on structure rather
/// than parsing the message.
struct HostError: Error {
    let code: HostErrorCode
    let message: String
    let details: [String: Any]

    init(_ code: HostErrorCode, _ message: String, details: [String: Any] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }

    /// Wraps anything thrown that is not already a `HostError`.
    static func wrap(_ error: Error) -> HostError {
        if let host = error as? HostError { return host }
        let ns = error as NSError
        return HostError(
            .internalFailure,
            "\(ns.domain) \(ns.code): \(ns.localizedDescription)",
            details: ["domain": ns.domain, "osStatus": ns.code]
        )
    }
}
