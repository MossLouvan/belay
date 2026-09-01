// Product-prefixed environment variables, post-rename (Tether → Deskhandler).
// The Swift twin of server/src/env.ts, for the helper's own knobs.

import Foundation

/// A product env var: DESKHANDLER_* is canonical, TETHER_* still honoured.
/// The rename must not invalidate a knob someone set before it — a helper
/// rebuilt after the rename would otherwise silently ignore, say, the
/// TETHER_MAC_INPUT_SPACE a user set to fix their multi-monitor mapping.
func productEnv(_ suffix: String) -> String? {
    let env = ProcessInfo.processInfo.environment
    return env["DESKHANDLER_" + suffix] ?? env["TETHER_" + suffix]
}
