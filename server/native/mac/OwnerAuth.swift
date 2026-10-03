// `authowner`: prove the person at this Mac is its owner before Belay lets a
// new phone in. LAContext's .deviceOwnerAuthentication is Touch ID with the
// login password as fallback (password only on Macs without Touch ID). The
// sheet is drawn by the system (coreauthd), not by us, so remote input from a
// phone cannot fake it, and a click alone never passes it.
//
// The reply is asynchronous: evaluatePolicy calls back on a private queue and
// the stdin loop keeps serving capture and input while the sheet is up.

import Foundation
import LocalAuthentication

enum OwnerAuth {
    static func handle(_ command: Command, replies: ReplyWriter) throws {
        let reason = try command.string("reason") ?? "let a new phone use this computer"
        guard !reason.isEmpty, reason.count <= 200 else {
            throw HostError(.badArgument, "'reason' must be 1-200 characters", details: ["field": "reason"])
        }
        let context = LAContext()
        var canError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError) else {
            throw HostError(.ownerAuth, canError?.localizedDescription ?? "This Mac cannot ask for your password.")
        }
        let id = command.id
        // The context is captured by the closure, so it lives until the answer.
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            if success {
                replies.ok(id: id)
            } else {
                replies.failure(id: id, HostError(.ownerAuth, error?.localizedDescription ?? "Not approved."))
            }
            _ = context
        }
    }
}
