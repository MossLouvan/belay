# WebRTC latency slice

The first vertical slice of the Parsec-class rewrite: hardware-encoded video over
a peer-to-peer WebRTC connection on the LAN/Tailscale path, measured
glass-to-glass, behind a flag. JPEG-over-WebSocket stays the default transport
until this beats it on a loss-lab suite.

Scope of this slice: **no cloud rendezvous, no TURN, no accounts.** The phone and
host already share an authenticated connection (the existing WS), so it carries
the SDP/ICE handshake. That proves the codec + transport + latency thesis on the
cheapest possible footprint before any infrastructure is built.

## What is implemented and tested (runs with no hardware)

| Module | Job | Tests |
|---|---|---|
| `app/src/stream/webrtc/signaling.ts` | Pure offer/answer/ICE state machine — terminal vs recoverable states, ICE buffering, glare, stale-session rejection | `signaling.test.mjs` |
| `app/src/stream/webrtc/latency.ts` | Glass-to-glass measurement: NTP-style clock-offset, percentile window, drop accounting | `latency.test.mjs` |
| `app/src/stream/webrtc/ice.ts` | Direct-vs-relayed classification — the telemetry that sets unit economics | `ice.test.mjs` |
| `server/src/webrtc/relay.ts` | Boundary validation of signaling messages before they reach the peer connection | `webrtc-relay.test.ts` |
| `server/src/webrtc/flag.ts` | `BELAY_WEBRTC` opt-in; JPEG stays default | `webrtc-relay.test.ts` |

The signaling state machine deliberately encodes the lessons the screen-stream
playtest surfaced: `failed` is recoverable and re-offers, `closed` is terminal
and never retries, a message for a stale session is ignored, and ICE candidates
that outrun their description are buffered rather than thrown at a peer
connection that has no remote description yet.

## What needs your hardware to compile and verify

These are written to the correct API shape but can only be built and measured on
a real Mac GPU + a phone running a dev-client:

- **`server/native/mac/encode/VideoEncoder.swift`** — VideoToolbox H.264
  low-latency encoder (no B-frames, periodic intra-refresh) fed by the existing
  `SCStream` sample buffers.
- **Windows** — the equivalent Media Foundation / NVENC path in `BelayHost.cs`.
- **libdatachannel** — statically linked into the native helpers for the SRTP
  transport (keeps the single dependency-free binary).
- **Client** — `react-native-webrtc` in an Expo dev-client build; needs
  `expo prebuild` + a native rebuild, which cannot run headless.

## Runbook: getting the first glass-to-glass number

1. Enable the flag on the host: `BELAY_WEBRTC=1 npm start` in `server/`.
2. Build the dev-client (`expo prebuild && expo run:ios`) with
   `react-native-webrtc` added — the web/Expo-Go client can't do WebRTC.
3. Pair as normal; the app races the LAN/Tailscale path exactly as it does today.
4. The overlay reports `p50 / p95` glass-to-glass and the ICE candidate type
   (direct-local / direct-reflexive / relayed) per session.
5. Compare against the JPEG path on the same link. JPEG stays default until the
   loss-lab suite (1–5% loss, cellular jitter) passes.

## Why LAN-only first

The consensus architecture hangs every cost decision on the real direct-P2P
ratio, which is unmeasurable until it runs against real users. This slice
measures latency and the ICE ratio with zero infrastructure, so the rendezvous
region and TURN PoPs are built only once the numbers justify them.
