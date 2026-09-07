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
| Loss recovery | Complete video frame IDs checked for missing dependencies | Missing frames suppress deltas until a complete keyframe; requests retry at most every 250 ms; stale/duplicate packets do not request recovery |
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

- Extend the verified single-loss recovery to sustained loss, delay and jitter
  experiments; choose FEC or bounded retransmission based on those results.
- Extend submission-to-output measurements to actual games, multiple GPUs and
  CPU fallback; keep queues bounded if capture and sending are further overlapped.
- Measure real moving desktop/game capture, quality under motion, client decode
  and presentation, audio, cursor and input separately on Mac/phone clients.
- Complete Windows controller driver installation and physical controller/game
  validation; administrator elevation was canceled during the earlier attempt.
- Compare LAN and constrained/lossy WAN behavior. The reference's latency figures
  are targets, not acceptance evidence from this machine.

The requested bro skill was not available in the installed skill catalog or
local skill directories; explanations use plain language instead.

## Packet-loss validation follow-up

`node scripts/probe-desktop-video.mjs --loss` routes actual encrypted synthetic
GPU video through a local UDP proxy and drops one non-keyframe datagram after
warmup. The first subsequently delivered frame must be a keyframe. The measured
run recovered in 69 ms, delivered 457 frames and four keyframes over eight
seconds, and settled near 59 FPS. This measures receiver recovery, not decoded
presentation or WAN behavior. The smoke-test ceiling is two seconds; it is not
a product latency target.

35 transport tests pass, including a missing fragment, an entirely missing
frame, retry after a lost keyframe request, fragment reordering, duplicates,
frame-ID wrap, and rejecting invalid authenticated-encryption tags without
poisoning the replay window. Recovery preserves the existing v1 wire format.

## GPU frame ownership follow-up

The converter reuses its NV12 texture. The previous encoder passed that same
texture into every sample, although [Media Foundation may retain input samples](https://learn.microsoft.com/en-us/windows/win32/api/mftransform/nf-mftransform-imftransform-processinput)
after ProcessInput returns. A subsequent conversion could therefore overwrite
an input still being encoded. Each submitted sample now owns a separate GPU
snapshot, without CPU readback. The sample's DXGI buffer preserves that surface
until the encoder releases it.

This was chosen over immediate texture reuse because it establishes immutable
frame contents. A reusable pool may reduce allocation overhead later, but must
track actual sample release; a fixed ring based only on input submission does
not establish safety. The GPU test explicitly changes the source texture and
reads back the snapshot to verify that its NV12 bytes remain unchanged. It was
run successfully using the opt-in command:

```
cargo test --lib h264::tests::gpu_snapshot_is_unchanged_when_conversion_target_is_reused -- --ignored
```

The post-change synthetic loss run delivered 456 frames and four keyframes in
eight seconds, settled near 59 FPS, and recovered in 68 ms. Conversion/submission
calls in steady intervals were about 0.58–0.66 ms. This is not isolated GPU-copy
time or hardware encode completion time. The installed Electron presentation
playtest passes. The encoder library's normal tests pass (18); the GPU ownership
test is deliberately opt-in and was run separately rather than counted as passed
from an ignored test.

Encoder event waiting now has a real two-second deadline using nonblocking
[GetEvent](https://learn.microsoft.com/en-us/windows/win32/api/mfobjects/nf-mfobjects-imfmediaeventgenerator-getevent).
The previous bounded loop still called an API that could block indefinitely.
Unexpected event errors now propagate, and ProcessOutput event collections are
released. Device-loss and a deliberately wedged hardware encoder were not
physically induced for this validation.

## Ready-output scheduling follow-up

Timing now correlates each encoded sample's media timestamp with its input
submission time. `encoderOutputP95Ms` reports submission-to-observed-output
duration, including application polling; `encoderTimingSamples` reports how
many samples contributed. The bounded history reports no fabricated duration
for uncorrelated output. This is not pure hardware execution time or display
latency.

Before scheduling changes, the same synthetic 1080p60 test produced steady
one-second p95 values of about 17.5–17.8 ms. The main loop only collected output
during a subsequent encode call. It now polls completed asynchronous output
during the existing short frame waits and before capture, while retaining input
credits and the capture FPS cap. Completed frames also no longer depend on a
future changed desktop frame to be collected.

After the change, steady one-second p95 values were about 6.7–7.3 ms, while
throughput remained around 59 FPS (459 received frames in eight seconds). The
loss-injection run delivered 457 frames, recovered in 47 ms, and had output p95
values of roughly 6.6–7.4 ms. These are individual same-machine experiments,
not cross-device latency guarantees or a statistical claim about WAN recovery.

An opt-in hardware regression submits one frame, polls for its output without
submitting another or flushing, and repeats for three frames. It verifies output
timestamps and timing correlation and passes at 1080p on this machine:

```
cargo test --lib h264::tests::async_output_is_available_without_submitting_another_frame -- --ignored
```

The installed Electron playtest also passes with this rebuilt streamer. No new
wire format, public protocol handshake, or client decoder requirement was added.
