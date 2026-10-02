# Tunnel spike: iroh on iOS (2026-10-02)

**Verdict: GO.** iroh 1.3.0 (MIT/Apache) is the tunnel. No ICE fallback needed.

## Build for iOS
`crates/belay-net-tunnel` (iroh 1.3, default features: ring TLS, portmapper, fast-apple-datapath)
compiled as part of the existing `belay-client` static lib:

| target | result |
|---|---|
| aarch64-apple-ios | ok (release, 8 min cold) |
| aarch64-apple-ios-sim | ok |
| x86_64-apple-ios | ok (via scripts/build-ios-client.sh) |

iroh is a plain UDP-socket user (quinn/noq + a relay client over HTTPS/WebSocket). It needs no
Network Extension: a Network Extension is only for VPN/packet-tunnel providers that capture
other apps' traffic; an app opening its own sockets is ordinary. It runs in-process on the
app's own threads (tokio runtime inside the static lib). The iOS archive links (see the PR).

Not yet exercised on a physical phone: hole-punching from cellular NAT. Relay fallback covers
it until that is measured.

## Dial on this Mac (`cargo run --release --example spike` in crates/belay-net-tunnel)
Two endpoints in one process, echo over a `belay/1` bi-stream, 20 round trips:

| path | handshake | stream RTT median | QUIC smoothed RTT | selected path |
|---|---|---|---|---|
| direct (relay disabled, dial by IP) | 2.0 ms | 0.21 ms (min 0.16) | 0.2 ms | direct=true |
| relay only (client has no IP transports, n0 `use1-1.relay.n0.iroh.link`) | 382 ms | 92 ms (min 79) | 130 ms | direct=false |
| stranger (not on allow-list) | connects | first stream: `closed by peer: no (code 1)` | | refused |

The relay RTT is the Mac → n0 US-east relay → Mac loop. A self-hosted relay closer to the user
(infra/relay/README.md) brings that down; a direct path is used whenever hole-punching succeeds
and iroh migrates to it automatically.

## What this means for the design
- ALPN `belay/1`, allow-list by remote node id checked right after the handshake, connection
  closed before any stream is accepted: a stranger's bytes never reach the host port.
- The phone gets a 127.0.0.1 TCP forwarder (one QUIC connection, one bi-stream per TCP
  connection), so the app keeps using `https://127.0.0.1:<port>` with the same pinned cert.
- Relay URLs: n0 public relays by default (dev only); `relayUrls` from the heartbeat override.
