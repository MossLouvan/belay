# Streaming architecture alignment

Reviewed 7 September 2026 against the user's Downloads/message (1).txt, with
an independent Astra code and source review. The older message.txt is unrelated.

## Choice and comparison

Keep Belay's own BWP protocol and DXGI capture as the default. This follows the
reference's separation of host capture/encoding, encrypted media transport,
client decode/presentation and input, without adopting an unrelated handshake.

| Choice | Benefit | Cost or unresolved issue | Decision |
|---|---|---|---|
| Improve BWP | Existing clients, pairing and encrypted UDP remain compatible; directly addresses measured defects | Loss recovery and scheduling still need work | Implement and measure |
| Replace BWP with GameStream | Potential stock Moonlight interoperability | NVHTTP, pairing, RTSP and packet/FEC/ENet compatibility work; does not remove local pipeline waits | Only if Moonlight compatibility becomes a requirement |
| Keep DXGI Desktop Duplication | Existing whole-monitor GPU capture; measured capture cost is small in the current synthetic pipeline comparison | Real display acquisition, access-loss and texture lifetime need separate verification | Default |
| Add Windows Graphics Capture | Alternate window/capture compatibility path; free-threaded frame arrival | Not currently implemented; no equal-conditions latency measurement | Consider after direct A/B testing, not an assumed speed upgrade |

Microsoft documents [DXGI frame release timing](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-releaseframe)
and [WGC's free-threaded pool](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded?view=winrt-26100).
Those documents do not prove one capture API universally faster. Synthetic
source timings below bypass actual display capture and cannot settle that A/B.

The reference is an architecture guide, not a bit-exact specification. Sunshine's
[crypto implementation](https://github.com/LizardByte/Sunshine/blob/master/src/crypto.cpp)
derives the pairing AES key from salt followed by PIN and truncates the digest;
its [pairing implementation](https://github.com/LizardByte/Sunshine/blob/master/src/nvhttp.cpp)
returns the server secret plus its signature. These differ from the supplied
brief. No Sunshine or Moonlight implementation code was copied into Belay.

## What exists and what changed

| Reference stage | Belay evidence | Status |
|---|---|---|
| GPU capture and conversion | belay-encode capture.rs and gpu.rs | DXGI and NV12 path exist; WGC absent |
| Low-latency hardware encoding | h264.rs | Corrected COM setting types, forced keyframes, retained async input credits, submission-based timestamps |
| Encrypted UDP data plane | belay-net/session.rs | Own BWP, compatible v1 framing preserved |
| Link adaptation | session.rs and feedback.rs | Fixed actual RTT calculation using acknowledged sequence send history |
| Responsive scheduling | stream.rs and session.rs | Service feedback during pacing/frame waits; strict pacing at low rates can always earn one datagram |
| Bounded client delivery | desktop/src/video-queue.js | One in-flight plus two queued access units, 50 ms age limit, ordered delivery and keyframe recovery |
| Decoder recovery | desktop/renderer/video.js | Short overload resets to waiting for keyframe; timeout/unavailable codec still falls back |
| Controller input | existing gamepad channel and native target | Separate from video; native driver/device acceptance remains outstanding |
| FEC/retransmission | reassembly has nack_list but no active repair sender | Not implemented; do not claim Sunshine-equivalent loss resilience |
| Audio and cursor | Existing separate paths | Full client delivery and synchronization still require an end-to-end audit |

## Measured defect and improvement

V1 has a 16-byte packet header. Its in-memory send_us field is never serialized
and decodes as zero. The former RTT calculation therefore interpreted session
age as network delay. This held the adaptation ceiling around 2.57 Mbps even
on loopback. Correcting this uses Report.highest_seq to find an actual send time
in a bounded 8192-entry local history; no wire change is needed. Non-advancing
and unknown acknowledgements do not update RTT.

Same 1080p synthetic source, RTX 2070 SUPER, requested 60 FPS, eight-second run:

| Measurement | Before sequence correlation | After |
|---|---:|---:|
| Received frames | 303 | 460 |
| Keyframes | 3 | 3 |
| Reported RTT | Increased from ~0.87 to ~6.88 seconds | ~1.8–2.2 ms |
| Steady FPS | Often 25–26 | ~58.7–58.8 |
| Configured adaptive ceiling | Stalled at ~2.57 Mbps | Reached 20 Mbps |
| Mean send call time in affected intervals | ~35–37 ms | ~0.04–1.3 ms after startup |

This is a synthetic, same-machine transport experiment. It is not measured
game input-to-photon latency, a real DXGI capture comparison, rendered scanout,
or a guarantee of 60 FPS on Wi-Fi. convertEncodeMs measures API call time and
does not measure asynchronous hardware completion. CaptureMs includes source
generation and the cursor work before encoding. The source is mostly static
with one moving region, not a worst-case game scene.

Regression checks cover v1 zero-echo RTT at nonzero session age, duplicate
acknowledgements, deferred events exactly once, low-rate datagram progress,
ordered IPC bursts, overflow/age recovery and decoder overload recovery. Real
Electron testing covers H.264 presentation, pairing, rapid Gaming toggles,
compact layout, keyboard activation and simulated controller transport.

## Still required before declaring the objective complete

- Complete missing-frame dependency recovery and packet-loss/reordering tests.
- Audit asynchronous encoder surface lifetime and measure actual input-to-output
  latency; keep capture, encoding and network queues bounded if overlapped.
- Measure real moving desktop/game capture, quality under motion, client decode
  and presentation, audio, cursor and input separately on Mac/phone clients.
- Complete Windows controller driver installation and physical controller/game
  validation; administrator elevation was canceled during the earlier attempt.
- Compare LAN and constrained/lossy WAN behavior. The reference's latency figures
  are targets, not acceptance evidence from this machine.

The requested bro skill was not available in the installed skill catalog or
local skill directories; explanations use plain language instead.
