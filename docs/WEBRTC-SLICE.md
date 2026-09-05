# WebRTC latency slice

The first vertical slice of the Parsec-class rewrite: hardware-encoded video over
a peer-to-peer WebRTC connection on the LAN/Tailscale path, measured
glass-to-glass, behind a flag. JPEG-over-WebSocket stays the default transport
until this beats it on a loss-lab suite.

Scope of this slice: **no cloud rendezvous, no TURN, no accounts.** The phone and
host already share an authenticated connection (the existing WS), so it carries
the SDP/ICE handshake. That proves the codec + transport + latency thesis on the
cheapest possible footprint before any infrastructure is built.

## Status Update (Latest)

**All signaling and server infrastructure is COMPLETE and TESTED** (as of this commit):
- `/ws/webrtc` route wired with SignalingBridge validation
- Audio routes (`/audio/start`, `/audio/stop`, `/audio/status`, `/ws/audio`) registered behind flag
- Native verb dispatch for `webrtc`, `audiostart`, `audiostop`, `audiostatus` in both Swift and C#
- Encoder push sink mechanism in Capture.swift ready for hardware path
- `webrtc` field added to `/screen/info` response for UI feature detection
- Server typechecks and all tests pass

**What remains HARDWARE-GATED:** The actual hardware encode/decode loop requires building
with `BELAY_WEBRTC_BUILD=1` and vendoring libdatachannel. To enable:

```bash
# macOS:
cd server/native/mac/transport/vendor
bash build-libdatachannel.sh
cd ../../../..
BELAY_WEBRTC_BUILD=1 bash native/build-mac.sh

# Then start with flag:
BELAY_WEBRTC=1 npm start
```

Until the hardware path is built, the `webrtc` verb returns a clean error and the phone
stays on JPEG (graceful degradation).

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
| `server/src/webrtc/nal.ts` | Pure H.264/HEVC NAL reference: Annex-B split, AVCC⇄Annex-B, keyframe/parameter-set classification, the "every IDR is self-contained" conformance check — the byte contract `VideoEncoder.swift` implements | `webrtc-nal.test.ts` |
| `server/src/webrtc/packetization.ts` | Pure RTP math: 90 kHz timestamp mapping, FU-A/FU fragment counts, per-frame wire cost, pacing schedule — the same 1188-byte budget `belay_transport.cpp` is built with | `webrtc-packetization.test.ts` |
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

These are written to the correct API shape, verified as far as a machine with no
GPU-encode loop can verify them (see "Verify without hardware" below), and
clearly marked `WRITTEN-BUT-HARDWARE-GATED` / `WRITTEN-BUT-NOT-COMPILED`
in-source. They have **not** been linked, run, or measured; do not treat them as
working until the runbook below produces a number.

- **`server/native/mac/encode/VideoEncoder.swift`** — VideoToolbox H.264/HEVC
  low-latency encoder. AVCC→Annex-B NAL extraction with cached SPS/PPS
  (VPS/SPS/PPS for HEVC) prepended to every IDR (the invariant
  `server/src/webrtc/nal.ts` encodes and tests), `requestKeyframe()` via
  `kVTEncodeFrameOptionKey_ForceKeyFrame`, rate control
  (`AverageBitRate` + `DataRateLimits` + `ExpectedFrameRate` +
  `MaxFrameDelayCount=0` + `PrioritizeEncodingSpeedOverQuality`, low-latency
  rate control on Apple silicon — where it covers H.264 *and* HEVC; Intel is
  H.264-only) clamped to the same floor/ceiling as `congestion.ts`, plus
  dropped-frame/error reporting and a drain-then-invalidate `stop()`.
- **`server/native/mac/transport/`** — the libdatachannel peer behind a C ABI
  (`belay_transport.h/.cpp`): `rtc::PeerConnection` (callee), one send-only
  video track with the media-handler chain `H264RtpPacketizer`/`H265RtpPacketizer`
  (Annex-B, 1188-byte fragments — the tested budget in
  `server/src/webrtc/packetization.ts`) → `RtcpSrReporter` →
  `RtcpNackResponder` → `PliHandler` (PLI → `requestKeyframe`), and the three
  phone-created data channels received via `onDataChannel`. Written against the
  **pinned libdatachannel v0.23.1** headers.
- **`server/native/mac/transport/WebRTCSession.swift`** — the helper-side
  controller: the `webrtc` stdio verb (offer/ice/bye), transport callbacks →
  `type:"webrtc"` push lines to Node, encoder lifecycle on `connected`, control
  channel (`bitrate`/`keyframe`/`ping→pong`), and input/cursor channel events
  injected through `InputController`. Compiled only under `BELAY_WEBRTC_BUILD`,
  as are the small `#if`-gated seams in `main.swift` (the verb) and
  `Capture.swift` (the `CVPixelBuffer` push sink — capture becomes push, not
  poll, when a peer is connected).
- **`server/native/build-mac.sh`** — `BELAY_WEBRTC_BUILD=1` adds
  `-D BELAY_WEBRTC_BUILD`, folds in `encode/` + `transport/`, compiles the C++
  shim per-arch with clang++ and links the vendored static libdatachannel
  (+ libjuice/usrsctp/srtp2 + OpenSSL). Default build is untouched — the WebRTC
  sources are excluded and the `webrtc` verb fails cleanly to JPEG.
- **Windows** — `BelayHost.cs` routes the `webrtc` verb to
  `BelayHostWebRtc.cs` **only** when `build.ps1` runs with
  `BELAY_WEBRTC_BUILD=1` (`/define` + extra source); otherwise it errors cleanly
  and JPEG stays. `BelayHostWebRtc.cs` holds the session/verb plumbing, the
  real MFTEnumEx NVENC→QSV→AMF→software selection, the P/Invoke surface of
  `belay_transport.dll`, and the Desktop Duplication + Media Foundation encode
  loop written to shape — its COM vtables **must be verified on the first
  Windows compile** (there was no Windows machine in this loop; it has never
  been compiled).
- **Client** — `app/src/stream/webrtc/peer-adapter.ts`. The mapping is tested
  headless; the **real** `RTCPeerConnection` from `react-native-webrtc` must be
  injected by the screen component in an Expo dev-client build (step C below).
  It cannot run in Expo Go, the web build, or headless.

### Verify without hardware (all run clean on this tree)

No GPU or phone is needed to re-check everything that *can* be checked:

```bash
# 1. Pure glue + signaling + loss-lab (509 tests at time of writing):
cd server && npx tsc --noEmit && npm test
cd app && npm test   # the app-side pure modules

# 2. Swift typechecks, BOTH configurations (from server/native/mac):
swiftc -typecheck -swift-version 5 -target arm64-apple-macos13.0 *.swift
swiftc -typecheck -swift-version 5 -target arm64-apple-macos13.0 \
  -D BELAY_WEBRTC_BUILD -import-objc-header transport/belay-bridging.h \
  *.swift encode/*.swift transport/*.swift

# 3. The C++ shim against the real pinned headers (from server/native/mac/transport):
git clone --depth 1 --branch v0.23.1 \
  https://github.com/paullouisageneau/libdatachannel /tmp/ldc
clang++ -fsyntax-only -std=c++17 -DBELAY_HAVE_LIBDATACHANNEL \
  -DRTC_ENABLE_MEDIA=1 -I /tmp/ldc/include belay_transport.cpp
clang++ -fsyntax-only -std=c++17 belay_transport.cpp   # fallback (no-lib) config
```

What this does **not** prove: linking, SRTP handshake, a decodable stream,
encode latency, or any glass-to-glass number. `BelayHostWebRtc.cs` has no
compiler on this machine at all — treat it as the least-verified file here.

### Vendoring and licenses (the build decision, recorded)

`libdatachannel` **v0.23.1** (pinned), statically linked into the helper to
preserve the single-binary property. Licenses, all compatible with static
linking into Belay provided the vendored sources are unmodified and their
origin is recorded (this section and the vendor script are that record):

| Component | Role | License |
|---|---|---|
| libdatachannel | WebRTC peer, SRTP media, data channels | MPL 2.0 (file-level copyleft) |
| libjuice | ICE agent (bundled submodule) | MPL 2.0 |
| usrsctp | SCTP for data channels (bundled) | BSD-3-Clause |
| libsrtp (srtp2) | SRTP (bundled) | BSD-3-Clause |
| plog | logging (bundled, header) | MIT |
| OpenSSL 3 (Homebrew) | DTLS/crypto | Apache 2.0 |

Google's libwebrtc was rejected (a gigantic bespoke build for a slice that
needs one send track + three channels); Sunshine/Moonlight were used as the
*architecture* reference for the encode→packetize→SRTP shape only — Sunshine is
GPL-3 and no code was taken from it.

## Runbook: zero → a measured glass-to-glass number

Hardware needed: an Apple-silicon Mac (the host) and an iPhone (the client) on
the same LAN or tailnet. Every step is copy-paste from the repo root unless
noted.

### A. Build the WebRTC-capable helper (Mac)

```bash
# A1. One-time: vendor the static libdatachannel (pinned v0.23.1).
brew install cmake openssl@3       # git + clang ship with the CLT
bash server/native/mac/transport/vendor/build-libdatachannel.sh
# → server/native/mac/transport/vendor/libdatachannel/{include,lib} (gitignored)

# A2. Build the helper with the WebRTC path folded in.
BELAY_WEBRTC_BUILD=1 bash server/native/build-mac.sh

# A3. Prove the verb exists (default builds answer with the rebuild hint):
printf '{"id":1,"cmd":"webrtc","signal":{"kind":"bye","sessionId":"probe"}}\n' \
  | server/native/BelayHostMac | head -2
# Expect: the ready line, then {"id":1,"ok":true}. An "is not built into this
# helper" error means step A2 didn't run or didn't take.
```

Screen-recording permission must be re-granted after the rebuild (ad-hoc
signature = new CDHash; see build-mac.sh).

### B. Run the host with the flag on

```bash
cd server && BELAY_WEBRTC=1 npm start
```

`BELAY_WEBRTC=1` is what makes `/ws/webrtc` exist (404 otherwise) and is the
only server-side switch. JPEG `/ws/screen` keeps running throughout — it is the
fallback at every failure point below.

### C. Build the phone dev-client and inject the real peer connection

`react-native-webrtc` is a native module: **Expo Go and the web build cannot
run it.** From `app/`:

```bash
npm install react-native-webrtc
npx expo prebuild            # generates ios/ with the native module
npx expo run:ios --device    # dev-client on the physical phone
```

Then the screen component (frontend-owned) constructs the real peer and hands
it to the already-tested adapter — the only new client code the slice needs:

```ts
import { RTCPeerConnection } from 'react-native-webrtc';
import { createPeerAdapter } from '../stream/webrtc/peer-adapter';

const pc = new RTCPeerConnection({ iceServers: [] }); // LAN slice: none
const adapter = createPeerAdapter({
  pc,                       // satisfies PeerConnectionLike
  sessionId,                // the id used on /ws/webrtc
  send: (msg) => webrtcSocket.send(JSON.stringify(msg)), // → /ws/webrtc
  onConnectionState: (s) => session.onConnectionState(s),
});
```

`StreamSession` (session.ts) then drives offer/answer/ICE through the bridge
unchanged; the helper answers as the callee. The three data channels are created
by this side (`createPeerAdapter` does it) and received by the helper.

### D. Control-channel contract (already implemented on the helper)

JSON messages on the `control` channel: `{"t":"bitrate","bps":N}` (the ABR
setpoint from `congestion.ts` → encoder, clamped host-side),
`{"t":"keyframe"}` (force IDR), `{"t":"ping",...}` → echoed as
`{"t":"pong","tHost":ms,...}` for the `latency.ts` clock-offset probe.
Input/cursor channels carry the stdio command shapes (`{"cmd":"move",...}`
etc.); errors come back on `control` as `{"t":"error","message"}`.

### E. Measure

1. Pair as normal; the app races the LAN/Tailscale path exactly as today.
   Signaling: phone → `/ws/webrtc` → `SignalingBridge` → helper → back.
2. The overlay reports `p50/p95` glass-to-glass (`latency.ts`, fed by the
   ping/pong clock offset and the frame capture timestamps that ride the RTP
   timing), the ICE candidate type per session (`ice.ts` —
   direct-local / direct-reflexive / relayed), and the live ABR setpoint
   (`SessionMetrics.bitrateBps`).
3. Record the same numbers on the JPEG path on the same link, same hour.
4. The bar (M4/M5, PERFORMANCE-PLAN §5): LAN-direct **p50 ≤ 40 ms,
   p95 ≤ 60 ms**; under 1–5% loss + cellular jitter **p95 ≤ 80 ms**, no stuck
   key, recovery within one intra-refresh — and it must beat JPEG on the same
   link. JPEG stays the default until then.

### F. Windows (M6, after the Mac number exists)

1. Build `belay_transport.dll` from `server/native/mac/transport/belay_transport.{h,cpp}`
   + static libdatachannel v0.23.1 (same pin; cmake + MSVC or clang-cl) and put
   it beside `BelayHost.exe`.
2. `$env:BELAY_WEBRTC_BUILD='1'; powershell -File server/native/build.ps1` —
   first compile WILL surface the COM-vtable TODOs in `BelayHostWebRtc.cs`
   (`EncoderMatrix.Selection.Activate`, `Duplicator`); they are marked and
   scoped. Encoder preference NVENC → QSV → AMF → software is already real
   (`MFTEnumEx` + vendor ranking).
3. Any failure (no encoder, duplication denied, DLL missing) returns a clean
   error reply → the phone stays on JPEG. Verify that first, then M4/M5 metrics
   on an NVENC box.

## Why LAN-only first

The consensus architecture hangs every cost decision on the real direct-P2P
ratio, which is unmeasurable until it runs against real users. This slice
measures latency and the ICE ratio with zero infrastructure, so the rendezvous
region and TURN PoPs are built only once the numbers justify them.

The cloud rendezvous tier itself — the untrusted introducer, TURN credential
minting, and the presence/lease model — is now specified and its pure logic
implemented and tested in `infra/rendezvous/` + `server/src/webrtc/envelope.ts`,
behind `BELAY_CLOUD_SIGNALING`. See `docs/SCALABILITY.md`.
