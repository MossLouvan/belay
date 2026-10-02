import BelayClientFFI
import ExpoModulesCore
import Foundation

/// The tunnel: reach the computer from anywhere, without Tailscale.
///
/// Thin on purpose, like BelayStreamModule: iroh, the allow-list and the
/// 127.0.0.1 forwarder all live in the Rust the host was tested against
/// (crates/belay-net-tunnel via crates/belay-client/src/tunnel.rs). This file
/// is only the shape React Native needs. One tunnel handle per app; the secret
/// key arrives from JS (SecureStore) as hex and is never logged.
public final class BelayTunnelModule: Module {
    private var handle: UnsafeMutableRawPointer?
    private let queue = DispatchQueue(label: "belay.tunnel")

    public func definition() -> ModuleDefinition {
        Name("BelayTunnel")

        OnDestroy {
            self.queue.sync {
                belay_tunnel_close(self.handle)
                self.handle = nil
            }
        }

        /// Start (or restart) the endpoint. Returns this phone's node id.
        AsyncFunction("start") { (secretHex: String, relayUrls: [String], promise: Promise) in
            self.queue.async {
                belay_tunnel_close(self.handle)
                self.handle = nil
                guard let h = belay_tunnel_start(secretHex, relayUrls.joined(separator: ",")) else {
                    promise.reject("ERR_TUNNEL_START", "the tunnel endpoint could not start (bad key?)")
                    return
                }
                self.handle = h
                var buf = [CChar](repeating: 0, count: 65)
                let n = belay_tunnel_node_id(h, &buf, buf.count)
                guard n > 0 else {
                    promise.reject("ERR_TUNNEL_START", "no node id")
                    return
                }
                promise.resolve(String(cString: buf))
            }
        }

        /// A local port forwarding to `nodeId`. Connect to https://127.0.0.1:<port>.
        AsyncFunction("dial") { (nodeId: String, promise: Promise) in
            self.queue.async {
                guard let h = self.handle else {
                    promise.reject("ERR_TUNNEL_CLOSED", "start the tunnel first")
                    return
                }
                let port = belay_tunnel_dial(h, nodeId)
                if port > 0 {
                    promise.resolve(Int(port))
                } else {
                    promise.reject("ERR_TUNNEL_DIAL", "dial failed (\(port))")
                }
            }
        }

        AsyncFunction("stats") { (nodeId: String, promise: Promise) in
            self.queue.async {
                guard let h = self.handle else {
                    promise.resolve(["connected": false, "rttMs": 0, "direct": false])
                    return
                }
                var st = BelayTunnelStats()
                let rc = belay_tunnel_stats(h, nodeId, &st)
                guard rc == BELAY_OK else {
                    promise.resolve(["connected": false, "rttMs": 0, "direct": false])
                    return
                }
                promise.resolve(["connected": st.connected != 0, "rttMs": st.rtt_ms, "direct": st.direct != 0])
            }
        }

        AsyncFunction("close") { (promise: Promise) in
            self.queue.async {
                belay_tunnel_close(self.handle)
                self.handle = nil
                promise.resolve(nil)
            }
        }
    }
}
