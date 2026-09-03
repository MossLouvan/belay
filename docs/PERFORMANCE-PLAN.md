# Performance plan: reaching Parsec-class latency

The goal is a genuinely game-playable remote path — phone-to-computer and
computer-to-computer — at Parsec-class glass-to-glass latency. This document is
the sequenced engineering plan to get there from the JPEG-over-WebSocket path
that ships today. It is grounded in the real code; every integration point names
a file.

It builds directly on the LAN-only WebRTC latency slice already in the tree
(`docs/WEBRTC-SLICE.md`): the pure signaling/latency/ICE modules under
`app/src/stream/webrtc/`, the host signaling validator `server/src/webrtc/relay.ts`,
the `BELAY_WEBRTC` flag `server/src/webrtc/flag.ts`, and the
not-yet-compiled `server/native/mac/encode/VideoEncoder.swift`. Nothing here
throws that away — it wires it up and fills in the hardware half.

---

## 1. The latency budget: today vs target

### Target

Parsec on a good LAN/Wi-Fi runs roughly **8–40 ms** glass-to-glass; on the same
link a well-tuned WebRTC + hardware-encode path lands in the same band. Our
target for "done" is **p50 ≤ 40 ms, p95 ≤ 60 ms on LAN/Tailscale-direct**, and
**p95 ≤ 80 ms across a 1–5% loss + cellular-jitter loss-lab trace** (the
conformance bar `docs/WEBRTC-SLICE.md` already names). 60 fps is a 16.6 ms frame
cadence, so anything above ~40 ms of pipeline latency stops feeling direct.

### Today (JPEG / TCP), measured + estimated

The shipping path is `ScreenCaptureKit → scale → JPEG → base64 → JSON → WebSocket`
(host loop in `server/src/index.ts` `handleScreen`, capture in
`server/native/mac/Capture.swift`, Windows in `server/native/BelayHost.cs`
`DoCapture`). The header comment in `Capture.swift` records real measurements on
an M3 for the full `capture` round trip (acquire + scale + JPEG + base64 + JSON):

| Config | p50 host capture+encode | notes |
|---|---|---|
| w=1024 q=55 | 29–33 ms | ~30 fps of headroom on a busy box |
| w=1280 q=55 | 33–43 ms | |
| w=1920 q=55 | 34–73 ms | outliers to ~165 ms under contention |

Default stream params (`server/src/stream-params.ts`): **w=1024, q=50, fps=12**.
So a rough budget for one default frame today:

| Stage | Est. cost | Where |
|---|---|---|
| SCStream acquire + bilinear scale | ~10–20 ms | `Capture.swift` / `ImageOutput.swift` |
| JPEG encode (full intra frame) | ~8–15 ms | `ImageOutput.jpeg` |
| base64 in helper + newline pipe to Node | ~2–5 ms + copy | `main.swift` reply → `native.ts` readline |
| Node `JSON.parse` reply, re-`stringify` into frame JSON | ~1–3 ms | `native.ts` → `index.ts` |
| **Frame cadence gap at fps=12** | **up to 83 ms** | `handleScreen` pacing |
| TCP/WebSocket serialization + delivery | 1 ms LAN … **RTT-multiplied on loss** | `ws.send` |
| Client JPEG decode + paint | ~5–15 ms | (client, off-limits here) |

**Glass-to-glass today is dominated by two things: the frame cadence (fps=12 ⇒
83 ms between frames before anything else) and, on any lossy link, TCP.** Even
raising fps to the 30 cap only gets the cadence floor to 33 ms, and the host CPU
cost of full-frame JPEG at 30 fps is prohibitive on a loaded machine.

### Why this path structurally cannot hit the target

1. **TCP head-of-line blocking.** Everything rides one WebSocket = one TCP
   stream (`/ws/screen`). A single lost segment stalls *every* later frame until
   it is retransmitted — at least one RTT. On 40 ms-RTT cellular, one loss = a
   40 ms+ freeze of the whole stream, and the backpressure guard
   (`MAX_BUFFERED_BYTES = 256 KB`, `server/src/index.ts`) then *drops* the
   frames that piled up behind it. TCP gives ordered reliable delivery; a live
   stream wants newest-frame-wins, which is the exact opposite.

2. **JPEG frame size — no interframe prediction.** JPEG is intra-only: a static
   desktop costs a full-frame payload *every frame*. A 1024-wide q50 frame is
   ~60–120 KB; H.264/HEVC P-frames on the same content are 5–20× smaller because
   they encode only what changed. Bigger frames span more packets ⇒ higher
   probability at least one is lost ⇒ more HOL stalls, and more serialization
   delay on a constrained uplink.

3. **base64 + JSON overhead.** The helper returns base64 (`data` field), Node
   embeds that string in a JSON envelope. base64 is +33% bytes; JSON string
   escaping and a full UTF-8 encode/decode happen on both ends, on the largest
   payload in the system, every frame.

4. **Single-subprocess pull pipe.** `server/src/native.ts` serializes *all*
   helper traffic — capture and input — through one stdio pipe, one JSON line
   in / one line out, matched by id. Frames are **pulled** one RPC at a time
   (`native.capture(...)` per loop iteration in `handleScreen`), never pushed as
   they are produced, so each frame pays a full request/reply round trip through
   Node's readline buffer, and a large capture reply sits *in front of* a queued
   input event. `CALL_TIMEOUT_MS` is 15 s precisely because this queue is
   head-of-line-blocked too.

None of these are tunable away. They require a different transport (UDP/SRTP), a
different codec (hardware H.264/HEVC with interframe prediction), and a push
pipeline. That is the rewrite.

---

## 2. Transport + codec rewrite

**Shape:** hardware encoder → H.264/HEVC → WebRTC media track over SRTP/UDP,
peer-to-peer. The native helper becomes the WebRTC peer (it holds the encoder
and `libdatachannel`); **Node stays purely a signaling relay** — it never sees
media, exactly as `server/src/webrtc/relay.ts` already assumes ("it never parses
the media"). `libdatachannel` is statically linked into the helper so the
single dependency-free binary property (ARCHITECTURE.md) is preserved.

### macOS integration points

- **`server/native/mac/Capture.swift` — the push seam.** `DisplayStream`
  already keeps the newest `CMSampleBuffer` and its `CVPixelBuffer`
  (`didOutputSampleBuffer`, line ~166; `copyLatest`). Today `latestImage()`
  pulls it → `CGImage` → JPEG. Add an **encoder sink**: when
  `BELAY_WEBRTC` is on and a peer is connected, `didOutputSampleBuffer` pushes
  the `CVPixelBuffer` straight into `VideoEncoder.encode(pixelBuffer:ptsMs:)`
  instead of storing-for-pull. This is the single most important change: it
  turns capture from a polled RPC into a push source and skips the
  CGImage/JPEG/base64 stages entirely. `stampCaptureTime` = the SCStream sample's
  host timestamp, carried through for glass-to-glass (`latency.ts`).

- **`server/native/mac/encode/VideoEncoder.swift` — finish it.** The API shape is
  right (RealTime, no B-frames, big keyframe interval). What is missing and must
  be built on the GPU:
  - `emit()`: real NAL extraction — read SPS/PPS from
    `CMSampleBufferGetFormatDescription` on the first keyframe, convert AVCC
    length-prefixed to Annex-B (or hand AVCC + parameter sets to the RTP
    packetizer), cache parameter sets to prepend to every IDR.
  - `requestKeyframe()`: set `kVTEncodeFrameOptionKey_ForceKeyFrame` in
    `frameProperties` on the next `encode` (currently a stub).
  - Rate control: `kVTCompressionPropertyKey_AverageBitRate`,
    `…_DataRateLimits`, `…_ExpectedFrameRate`,
    `…_MaxKeyFrameIntervalDuration`, and on Apple silicon
    `kVTVideoEncoderSpecification_EnableLowLatencyRateControl` — the setpoint is
    driven by the congestion controller (§3).
  - HEVC option: same session with `kCMVideoCodecType_HEVC` when the phone
    advertises decode support in the SDP (better ratio for text/UI).

- **New: `server/native/mac/transport/` — the WebRTC peer.** A small C++/Obj-C++
  shim over `libdatachannel` exposing a C ABI, called from Swift. It owns the
  `rtc::PeerConnection`, one video track (SRTP, the encoder's NAL sink is its
  RTP source), and the three data channels (§3). New stdio verbs on the helper —
  `webrtc.offer` / `webrtc.answer` / `webrtc.ice` / `webrtc.bye` — let Node hand
  it SDP/ICE and read back the local SDP/candidates. The helper never talks to
  the phone directly; it talks to Node, Node relays over the existing
  authenticated WS.

- **`server/native/build-mac.sh`** — add the static `libdatachannel` (+ its
  `libjuice`/`usrsctp`/`srtp` deps or the bundled build), `-lc++`, and the extra
  `-I/-L`. Keep the universal-binary + ad-hoc-signing flow intact. This is the
  one place the "no dependency to restore" claim bends — vendored as a prebuilt
  static archive checked in or fetched by the build, not a package manager.

### Windows integration points

- **`server/native/BelayHost.cs` — `DoCapture` / `EnsureSource`.** Today: GDI
  `CopyFromScreen` + `System.Drawing` JPEG (line ~379). Replace the capture
  source with **Desktop Duplication** (`IDXGIOutputDuplication`) for a GPU
  surface with no readback, and feed it to a **Media Foundation** H.264/HEVC
  encoder. Enumerate hardware MFTs and prefer **NVENC → QSV → AMF → software**
  (the encoder support matrix, §6). Same new `webrtc.*` verbs, same
  `libdatachannel` static link. Input injection (`SendInput`, unchanged) stays.

### Server wiring (`server/src`)

- **Bind the flag.** `server/src/webrtc/flag.ts` currently "gates nothing at
  runtime." Add a `/ws/webrtc` upgrade to `WS_ROUTES` in `server/src/index.ts`,
  guarded by `webrtcEnabled()`. Every signaling frame goes through
  `validateSignal` (`relay.ts`) before it is forwarded to the helper via new
  `native.ts` methods (`sendOffer`/`sendAnswer`/`sendIce`). JPEG `/ws/screen`
  stays the default and the fallback until the loss-lab suite passes.

- **Client.** The host is the ICE *callee*, the phone the *caller* (matches the
  fixed-initiator assumption in `signaling.ts`). The phone wraps a
  `react-native-webrtc` `RTCPeerConnection` in the `PeerAdapter` interface that
  `app/src/stream/webrtc/session.ts` already defines, so `StreamSession` drives
  it unchanged. The adapter factory can live in `app/src/stream/webrtc/`; the
  screen component only mounts it (frontend is off-limits and owned by another
  agent).

---

## 3. Pacing, adaptive bitrate, loss recovery, input path

### Three data channels (media rides SRTP, not a data channel)

Video/audio go over an SRTP **media track**. Alongside it, three
`RTCDataChannel`s, each with the reliability its traffic needs — encoded as a
pure, tested policy in `app/src/stream/webrtc/channels.ts` (added with this
plan):

| Channel | Reliability | Carries | Why |
|---|---|---|---|
| `input` | reliable, ordered | key down/up, click down/up, text | a dropped key-up = a stuck key; correctness over latency, but payloads are tiny so latency is fine |
| `cursor` | **unreliable, unordered** (`maxRetransmits: 0`) | pointer move, scroll | high-rate, newest-wins; never retransmit a stale mouse delta |
| `control` | reliable, ordered | config/resize, force-keyframe, latency pings, ABR feedback | small, must arrive, order matters |

The input path bypasses the video pipeline entirely: phone → `input`/`cursor`
channel → helper injects via `Input.swift` / `SendInput`. Target
phone-to-inject **< 16 ms on LAN**, which is unreachable today because input is
serialized behind capture on the one stdio pipe (§1.4) — the WebRTC peer lives
in the helper, so injection no longer queues behind a frame.

### Frame pacing

Encoder `ExpectedFrameRate` + a sender pacer (libdatachannel/GCC) spreads a
frame's packets across the frame interval rather than bursting, which keeps the
bottleneck queue shallow and RTT low. No B-frames (already configured) so no
reorder latency. Intra-refresh instead of periodic IDR (already the design in
`VideoEncoder.swift`) so recovery never costs a full-frame bandwidth spike.

### Adaptive bitrate under loss

WebRTC transport-cc / RTCP feedback gives loss ratio + RTT per interval. A
congestion controller turns that into the encoder's `AverageBitRate` setpoint.
Implemented as a pure, tested module `app/src/stream/webrtc/congestion.ts`
(added with this plan): loss-based AIMD with an RTT-gradient guard —
multiplicative decrease on real loss, additive increase only while the queue is
not building (RTT near its floor), clamped to `[min,max]`. It is deliberately
pure so the loss-lab (§5) can drive it with synthetic traces and assert it
converges without oscillating, before any GPU exists.

### Loss recovery

- **NACK / RTX** (libdatachannel) for retransmission when RTT is small enough
  that the retransmit still beats the frame deadline.
- **FEC** (ulpfec/flexfec) for the tail where a NACK round trip is too slow —
  trades a little steady bandwidth for not waiting on a retransmit under 1–5%
  loss.
- **PLI/FIR → `requestKeyframe()`** as the last resort when loss corrupts the
  reference chain beyond FEC/NACK repair; intra-refresh already spreads that
  cost.

---

## 4. Implementable now vs hardware-gated

**Verifiable now (no GPU, no phone):**

- All pure TS modules under `app/src/stream/webrtc/`: `signaling`, `latency`,
  `ice`, `session` (with a fake `PeerAdapter`), and the two added here,
  `congestion` and `channels` — all under `node --test`.
- Host signaling validation `server/src/webrtc/relay.ts` and the flag.
- **The `/ws/webrtc` signaling wiring** driven end-to-end against a *fake* peer
  adapter and a loopback relay (an integration test): offer/answer/ICE
  round-trips, stale-session and glare handling, terminal vs recoverable states.
- **The loss-lab simulator** (§5): a Node harness feeding synthetic loss/jitter
  traces into `congestion.ts` and asserting convergence/stability. No media
  needed — it validates the control law, which is where the risk is.

**Hardware-gated (needs a real GPU and/or a phone dev-client):**

- `VTCompressionSession` actually encoding a decodable stream; the real
  encode-latency and bitrate-tracking numbers (`VideoEncoder.swift`).
- `libdatachannel` static link + SRTP media flow.
- Windows Media Foundation / NVENC / QSV / AMF path.
- The real glass-to-glass number and the direct/relayed ICE ratio.

**react-native-webrtc requires a dev-client.** It is a native module: it cannot
run in Expo Go or the web build. Getting the first number needs
`expo prebuild && expo run:ios` with `react-native-webrtc` added, then a native
rebuild — which cannot run headless. This is already called out in the
`docs/WEBRTC-SLICE.md` runbook and is the gate on every hardware milestone below.

---

## 5. Milestones (each with an acceptance metric)

| # | Milestone | Acceptance metric | Gate |
|---|---|---|---|
| **M0** | Pure scaffolding (done + extended here) | `signaling/latency/ice/session/congestion/channels` all green under `node --test`; `relay` green | now ✓ |
| **M1** | Wire `/ws/webrtc` signaling end-to-end against a fake peer | An offer→answer→ICE→connected round trip passes through `validateSignal` + `StreamSession`; stale-session and `bye` handled; JPEG still default | done ✓ |
| **M2** | Loss-lab simulator over `congestion.ts` | Controller converges to within **±15%** of link capacity and does **not** oscillate across scripted **1–5% loss + 30–80 ms jitter** traces; `channels` routing unit-proven (stuck-key case: key-up always on the reliable channel) | done ✓ |
| **M3** | VideoToolbox encoder on a Mac GPU | Emits a decodable H.264 elementary stream; **encode p95 < 8 ms at 1080p60**; measured bitrate tracks setpoint within ±10% | GPU |
| **M4** | `libdatachannel` + SRTP to a dev-client on LAN | First real number: **glass-to-glass p50 ≤ 40 ms, p95 ≤ 60 ms** on LAN/Tailscale-direct; ICE reports `direct-local`/`direct-reflexive` | GPU + phone |
| **M5** | Loss-lab conformance on the *real* path | Under 1–5% loss + cellular jitter with NACK/FEC on: **glass-to-glass p95 ≤ 80 ms**, no stuck key, recovers from a burst loss within one intra-refresh cycle, and **beats JPEG on the same link** ⇒ flip `BELAY_WEBRTC` toward default | GPU + phone |
| **M6** | Windows MediaFoundation/NVENC parity | M4/M5 metrics on an NVENC box; graceful fallback verified across the QSV/AMF/software matrix | Win GPU |
| **M7** | TURN over TLS/443 for UDP-blocked nets | Connects when UDP egress is blocked; relayed **p95 ≤ 120 ms**; ICE reports `relayed` and the direct/relayed ratio is recorded (`ice.ts`) | infra |

**Recommended first milestone: M1** — it is the highest-leverage step that needs
no hardware. It turns the tested-but-inert scaffolding into a real, exercised
signaling loop (the `/ws/webrtc` upgrade + `relay.ts` + `StreamSession` against a
fake peer), so that when the GPU/phone arrive for M3/M4 the *only* new variables
are the encoder and the transport, not the handshake. M2 (loss-lab over the
congestion controller) runs in parallel — it de-risks the part that is hardest to
get right and is fully verifiable now.

---

## 6. Realistic assessment: can this match Parsec?

**On LAN / good Wi-Fi with a direct P2P path and a hardware encoder: yes,**
plausibly within a few ms of Parsec. The pipeline (hardware H.264/HEVC, SRTP/UDP,
no B-frames, intra-refresh, paced sending) is the same class of pipeline Parsec
uses, and glass-to-glass in the 16–40 ms band is achievable there.

**Where it will fall short of Parsec:**

- **Congestion control.** WebRTC's GCC is more conservative than Parsec's custom
  UDP protocol (BUD), so under load we will tend to *under*-shoot bitrate — safe,
  but softer picture at the same link than Parsec. The `congestion.ts` control
  law is where we can claw some of that back, but matching years of Parsec
  tuning is unrealistic near-term.

- **The encoder matrix on low-end hardware.** With NVENC/QSV/AMF/VideoToolbox we
  match. Without a hardware encoder (old desktops, some VMs) the fallback is
  software H.264, which cannot sustain 60 fps at useful resolution — those
  machines get a degraded experience Parsec also struggles with, but Parsec's
  fallback is more mature.

- **Corporate / UDP-blocked networks.** When UDP egress is blocked (§5 M7), the
  only path is **TURN over TLS on 443**, which forces every packet through a
  relay and adds a WAN round trip — the `relayed` p95 ≤ 120 ms target is a real
  regression from direct, and it is *unavoidable* on those networks. This is also
  where `TRANSPORT-SECURITY.md` gets revisited: a relayed path means the network
  is untrusted and app-layer E2E encryption (beyond SRTP's DTLS) must be the
  posture, not cleartext-over-tailnet.

- **Phone decode.** Older phones decode H.264 in hardware fine but HEVC and
  higher resolutions vary; the SDP negotiation must degrade gracefully.

- **Gaps we are not closing first:** HDR and 4:4:4 chroma for crisp text —
  Parsec has both; the plan above ships 4:2:0 video first. Audio now has its
  own slice: driverless system-audio loopback + a tested packetization/jitter
  spine, behind the same flag — see `docs/AUDIO.md` for exactly how far it is
  verified.

**Bottom line:** Parsec-class on the paths that matter most (home LAN, Tailscale
direct, good Wi-Fi), with an honest and measured degradation on hostile networks
and low-end encoders — and the whole thing is decided by numbers, not opinion,
because the measurement (`latency.ts`, `ice.ts`) and the conformance bar (the
loss-lab) ship before the codec is even turned on.
