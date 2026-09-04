import ExpoModulesCore

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
            Prop("source") { (view: BelayStreamView, source: [String: Any]?) in
                guard let source,
                      let host = source["host"] as? String,
                      let port = source["port"] as? Int,
                      let key = source["key"] as? String,
                      let salt = source["salt"] as? String
                else {
                    view.stop()
                    return
                }
                let preset = source["preset"] as? String ?? "auto"
                let localPort = source["localPort"] as? Int ?? 0
                view.start(
                    host: host,
                    hostPort: port,
                    key: key,
                    salt: salt,
                    preset: preset,
                    localPort: localPort
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
            return Int(BelayPortReservation.reserve())
        }
    }
}

/// Finds a free UDP port by binding one and reporting it.
///
/// The port is released immediately: holding it would prevent the session from
/// binding the same one moments later. There is a race in principle — something
/// else could take it in between — but it is the same race every "get a free
/// port" implementation has, and the alternative (handing the socket across a
/// language boundary) buys nothing on a phone that is not running a server.
enum BelayPortReservation {
    static func reserve() -> UInt16 {
        let sock = socket(AF_INET, SOCK_DGRAM, 0)
        guard sock >= 0 else { return 0 }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = INADDR_ANY
        addr.sin_port = 0

        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return 0 }

        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &out) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(sock, $0, &len)
            }
        }
        guard got == 0 else { return 0 }
        return UInt16(bigEndian: out.sin_port)
    }
}
