import Darwin
import ExpoModulesCore
import Foundation

/// What the host offered, as it arrives from JS.
///
/// A `Record` rather than a loose dictionary: the fields are declared once and
/// converted by the Expo runtime, so a missing or wrongly typed field is caught
/// at the boundary instead of becoming a nil-ish default that surfaces later as
/// a session that will not open.
struct BwpSourceRecord: Record {
    @Field var host: String = ""
    @Field var port: Int = 0
    /// Per-session media key, hex. Never logged.
    @Field var key: String = ""
    @Field var salt: String = ""
    @Field var preset: String = "auto"
    /// The port JS reserved and already told the host about.
    @Field var localPort: Int = 0

    /// Enough to attempt a session. The Rust side validates the key and salt
    /// properly; this only rejects the obviously unusable so the native call is
    /// not made with placeholder values.
    var isUsable: Bool {
        !host.isEmpty && port > 0 && !key.isEmpty && !salt.isEmpty
    }
}

/// The Expo module surface.
///
/// Deliberately thin: it owns no protocol logic at all. Everything about BWP
/// lives in the Rust the host was tested against, and everything about decoding
/// lives in H264Stream. This file is only the shape React Native needs.
public class BelayStreamModule: Module {
    public func definition() -> ModuleDefinition {
        Name("BelayStream")

        View(BelayStreamView.self) {
            Events("onStatus", "onCursor")

            // One prop rather than a start() method with five arguments: React
            // re-renders, and a declarative source means a re-render with the
            // same values is a no-op instead of restarting the stream.
            Prop("source") { (view: BelayStreamView, source: BwpSourceRecord?) in
                guard let source, source.isUsable else {
                    view.stop()
                    return
                }
                view.start(
                    host: source.host,
                    hostPort: source.port,
                    key: source.key,
                    salt: source.salt,
                    preset: source.preset,
                    localPort: source.localPort
                )
            }
        }

        /// Reserve a UDP port before the offer is requested.
        ///
        /// The order matters and is not negotiable: the host must be told where
        /// to send before it starts sending. Binding after the offer arrives
        /// means the first frames land on a closed port and the stream appears
        /// dead until the next keyframe.
        AsyncFunction("reservePort") { () -> Int in
            Int(BelayPortReservation.reserve())
        }
    }
}

/// Finds a free UDP port by binding one and reporting it.
///
/// The port is released immediately: holding it would stop the session binding
/// the same one moments later. There is a race in principle — something else
/// could take it in between — but it is the same race every "find a free port"
/// implementation has, and the alternative (handing a live socket across a
/// language boundary) buys nothing on a phone that is not running a server.
enum BelayPortReservation {
    static func reserve() -> UInt16 {
        // Darwin-qualified throughout. `bind` in particular is a name Swift can
        // resolve elsewhere depending on what a later import brings in, and the
        // resulting error would point a long way from the cause.
        let sock = Darwin.socket(AF_INET, SOCK_DGRAM, 0)
        guard sock >= 0 else { return 0 }
        defer { Darwin.close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = INADDR_ANY
        addr.sin_port = 0

        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return 0 }

        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &out) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(sock, $0, &len)
            }
        }
        guard got == 0 else { return 0 }
        return UInt16(bigEndian: out.sin_port)
    }
}
