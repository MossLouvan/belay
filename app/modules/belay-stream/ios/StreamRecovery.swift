import Foundation

/// Decides, per frame, whether the decoder can show it and whether the host
/// should be asked for a keyframe.
///
/// Kept free of AVFoundation on purpose so the rules can be exercised with
/// plain values. The rules:
///
///  * The stream starts needing a keyframe. A delta frame with nothing to
///    decode against is not shown — a display layer fed one produces green
///    smear or, worse, silently fails and drops everything after it.
///  * A keyframe clears the need. A failed layer or a frame the parser could
///    not turn into a sample sets it again.
///  * Requests are rate limited. Loss comes in bursts; one request per burst
///    costs the host one keyframe, one per dropped fragment would cost it a
///    keyframe per frame — a bitrate spike exactly when the link is worst.
struct StreamRecovery {
    /// Minimum spacing between two keyframe requests. Longer than a frame,
    /// shorter than the time a frozen picture becomes noticeable.
    static let minRequestInterval: TimeInterval = 0.25

    private(set) var awaitingKeyframe = true
    private(set) var lastRequestAt: TimeInterval = -.infinity
    private(set) var requests = 0

    /// What to do with a video frame.
    enum Verdict: Equatable {
        /// Show it.
        case show
        /// Drop it and ask the host for a keyframe.
        case dropAndRequest
        /// Drop it; a request went out recently and another would be noise.
        case drop
    }

    /// Judge a frame that reached the decoder.
    ///
    /// - Parameters:
    ///   - keyframe: whether it can start a decode (IDR with parameter sets).
    ///   - layerFailed: whether the display layer is in its failed state, in
    ///     which case only a keyframe after a flush can bring it back.
    ///   - now: the caller's monotonic clock, in seconds.
    mutating func judge(keyframe: Bool, layerFailed: Bool, now: TimeInterval) -> Verdict {
        if layerFailed { awaitingKeyframe = true }
        if keyframe {
            awaitingKeyframe = false
            return .show
        }
        guard awaitingKeyframe else { return .show }
        return requestIfDue(now: now) ? .dropAndRequest : .drop
    }

    /// The parser could not build a sample from a frame that should have
    /// decoded (no parameter sets yet, or a corrupt access unit). Returns
    /// whether a request should go out.
    mutating func decodeFailed(now: TimeInterval) -> Bool {
        awaitingKeyframe = true
        return requestIfDue(now: now)
    }

    private mutating func requestIfDue(now: TimeInterval) -> Bool {
        guard now - lastRequestAt >= Self.minRequestInterval else { return false }
        lastRequestAt = now
        requests += 1
        return true
    }
}
