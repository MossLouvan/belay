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
| `app/src/stream/webrtc/congestion.ts` | ABR control law: loss-based AIMD with an RTT-gradient guard | `congestion.test.mjs` |
| `app/src/stream/webrtc/channels.ts` | The three data channels + the pure routing policy (no stuck keys) | `channels.test.mjs` |
| `app/src/stream/webrtc/loss-lab.ts` | **M2** deterministic loss/jitter simulator over `congestion.ts` | `loss-lab.test.mjs` |
| `app/src/stream/webrtc/session.ts` | The controller: signaling + ABR (`onLinkFeedback`) + channel routing (`sendEvent`) wired to an injected `PeerAdapter` | `session.test.mjs` |
| `app/src/stream/webrtc/peer-adapter.ts` | react-native-webrtc adapter **mapping** (PeerAdapter ⇄ RTCPeerConnection); real ICE/SRTP gated | `peer-adapter.test.mjs` |
| `server/src/webrtc/relay.ts` | Boundary validation of signaling messages before they reach the peer connection | `webrtc-relay.test.ts` |
| `server/src/webrtc/bridge.ts` | **M1** the signaling-only relay: validated 1:1 bridge between the phone and the helper peer | `webrtc-bridge.test.ts`, `webrtc-signaling.test.ts` |
| `server/src/webrtc/flag.ts` | `BELAY_WEBRTC` opt-in; JPEG stays default | `webrtc-relay.test.ts` |
| `server/src/index.ts` | `/ws/webrtc` upgrade — added to `WS_ROUTES` only when the flag is on, bound to the authenticated device | `webrtc-signaling.test.ts` (bridge path) |

The signaling state machine deliberately encodes the lessons the screen-stream
playtest surfaced: `failed` is recoverable and re-offers, `closed` is terminal
and never retries, a message for a stale session is ignored, and ICE candidates
that outrun their description are buffered rather than thrown at a peer
connection that has no remote description yet.

### M1 — `/ws/webrtc` signaling, end-to-end against a fake peer (done)

`server/src/webrtc/bridge.ts` is the host's signaling-only relay: it validates
every frame through `relay.ts`'s `validateSignal`, binds a session id, rejects
stale/glare frames, and forwards offer/answer/ICE/bye between the two peers of a
session (the phone over the WS, the native helper as the callee). `index.ts`
adds the `/ws/webrtc` upgrade to `WS_ROUTES` **only when `BELAY_WEBRTC` is on**,
so the route is a 404 by default and JPEG stays the transport. The
`webrtc-signaling.test.ts` integration test drives **two real `StreamSession`s**
through the bridge — `offer → answer → ICE → connected`, plus glare, stale
session and `bye` — proving the handshake with no browser and no GPU.

### M2 — loss-lab over the ABR control law (done)

`loss-lab.ts` is a deterministic, network-free simulator: a synthetic bottleneck
whose loss and RTT are a function of how hard the sender pushes it, driven by a
seeded PRNG. `loss-lab.test.mjs` asserts the plan's bar — `congestion.ts`
**converges to within ±15% of link capacity** on congestion-driven and
cellular-jitter (30–80 ms) traces and **stays bounded (no runaway oscillation)**
everywhere, including heavy 5% random-loss traces where a loss-based law is
honestly conservative (it operates below capacity — a stable floor, not a
collapse). `congestion.ts` and `channels.ts` are now wired into `StreamSession`
(`onLinkFeedback` drives the encoder setpoint via `PeerAdapter.setBitrate`;
`sendEvent` routes via `PeerAdapter.sendOn`), so they are used, not inert —
behind the flag, since the session only mounts when WebRTC is enabled.

## What needs your hardware to compile and verify

These are written to the correct API shape and clearly marked
`WRITTEN-BUT-HARDWARE-GATED` in-source. They have **not** been compiled or
measured; do not treat them as working until the runbook below produces a
number.

- **`server/native/mac/encode/VideoEncoder.swift`** — VideoToolbox H.264/HEVC
  low-latency encoder. Now includes AVCC→Annex-B NAL extraction with cached
  SPS/PPS (VPS/SPS/PPS for HEVC) prepended to every IDR, `requestKeyframe()`
  forcing an IDR via `kVTEncodeFrameOptionKey_ForceKeyFrame`, and rate control
  (`AverageBitRate` + `DataRateLimits` + `ExpectedFrameRate` + low-latency on
  Apple silicon) driven by `setBitrate()`. Excluded from the default build.
- **`server/native/mac/transport/`** — new libdatachannel shim behind a C ABI
  (`belay_transport.h` / `.cpp`, `belay-bridging.h`): the `rtc::PeerConnection`,
  one SRTP video track (the encoder's NAL sink is its RTP source) and the three
  data channels from `channels.ts`. Guarded by `#ifdef BELAY_HAVE_LIBDATACHANNEL`.
- **`server/native/build-mac.sh`** — opt-in `BELAY_WEBRTC_BUILD=1` path folds in
  `encode/` + `transport/` and links the static libdatachannel (+ libjuice /
  usrsctp / srtp). Default build is untouched — the WebRTC sources are excluded.
- **Windows** — `BelayHost.cs` gains the `webrtc` verb (fails cleanly today) and
  the NVENC→QSV→AMF→software encoder-preference matrix; the Desktop Duplication
  + Media Foundation + libdatachannel path is described in-source, not built.
- **Client** — `app/src/stream/webrtc/peer-adapter.ts`. The mapping is tested
  headless; the **real** `RTCPeerConnection` from `react-native-webrtc` (a
  native module) must be injected by the screen component in an Expo dev-client
  build (`expo prebuild` + native rebuild). It cannot run in Expo Go or the web
  build, and cannot run headless.

## Runbook: getting the first glass-to-glass number

1. Enable the flag on the host: `BELAY_WEBRTC=1 npm start` in `server/`. This is
   what makes `/ws/webrtc` exist (it is a 404 otherwise).
2. Build the native helper with the WebRTC path: `BELAY_WEBRTC_BUILD=1 bash
   native/build-mac.sh`. This first needs a prebuilt **static libdatachannel**
   archive under `native/mac/transport/vendor/libdatachannel/` (+ its
   libjuice/usrsctp/srtp deps); the default `npm run build:native` does not
   include it. Confirm the helper answers the `webrtc` verb instead of
   `unknown command`.
3. Build the dev-client (`expo prebuild && expo run:ios`) with
   `react-native-webrtc` added, and have the screen component construct
   `new RTCPeerConnection(config)` and pass it to `createPeerAdapter()` — the
   web/Expo-Go client can't do WebRTC.
4. Pair as normal; the app races the LAN/Tailscale path exactly as it does
   today. The signaling now flows phone → `/ws/webrtc` → `SignalingBridge` →
   helper and back, all validated.
5. The overlay reports `p50 / p95` glass-to-glass (`latency.ts`) and the ICE
   candidate type (direct-local / direct-reflexive / relayed) per session
   (`ice.ts`), and the live ABR setpoint (`SessionMetrics.bitrateBps`).
6. Compare against the JPEG path on the same link. JPEG stays default until the
   loss-lab conformance bar is met **on the real path** (M5): under 1–5% loss +
   cellular jitter, `p95 ≤ 80 ms`, no stuck key, recovery within one
   intra-refresh — and it must beat JPEG on the same link.

## Why LAN-only first

The consensus architecture hangs every cost decision on the real direct-P2P
ratio, which is unmeasurable until it runs against real users. This slice
measures latency and the ICE ratio with zero infrastructure, so the rendezvous
region and TURN PoPs are built only once the numbers justify them.

The cloud rendezvous tier itself — the untrusted introducer, TURN credential
minting, and the presence/lease model — is now specified and its pure logic
implemented and tested in `infra/rendezvous/` + `server/src/webrtc/envelope.ts`,
behind `BELAY_CLOUD_SIGNALING`. See `docs/SCALABILITY.md`.
