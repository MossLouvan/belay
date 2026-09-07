# NVENC API header

nvEncodeAPI.h is the unmodified NVIDIA MIT-licensed header from FFmpeg
nv-codec-headers tag n13.0.19.0 (NVENC API 13.0):
https://github.com/FFmpeg/nv-codec-headers/blob/n13.0.19.0/include/ffnvcodec/nvEncodeAPI.h

The copyright and license are preserved in the header and LICENSE. The native
bridge is independently implemented; no NVIDIA SDK sample code is included.
The driver DLL is loaded only from Windows System32, is not redistributed, and
must advertise API 13.0 or newer. No CUDA SDK or runtime is required.

Four registered NV12 textures, output buffers, and Windows events are allocated;
at most two submitted pictures can be outstanding. The bridge copies each input
texture before submission and retains the snapshot through completion. GOP is
specified in frames. Poll output is owned by the bridge until its next poll.

Teardown gives pending completion events a shared two-second wait budget, then
uses the driver session-destroy call before releasing textures. NVENC provides
no timeout for that driver call; an unresponsive driver can still block teardown.

## Rate-control diagnosis (RTX 2070 SUPER, driver 596.36)

Set BELAY_NVENC_TRACE=1 for preset limits/capabilities and one output sample per
60 frames (bytes, average QP, picture type, configured rate and VBV). This is
opt-in stderr diagnostics, not a telemetry wire-format change.

On the deterministic 1080p60 full-screen motion source, 180-frame isolated runs:

| Configuration | 8 Mbps fresh actual | Output p95 |
| --- | ---: | ---: |
| P1, single pass (retained) | 15.818 Mbps | 5.30 ms |
| P1, quarter-resolution analysis pass | 16.715 Mbps | 6.68 ms |
| P4, quarter-resolution analysis pass | 16.706 Mbps | 7.78 ms |

The preset has no enabled minimum/maximum/initial QP limits and already uses
CABAC. CBR and dynamic bitrate capabilities are supported. Single-pass output
samples reached average QP 49-50; two-pass samples reached 51. This is evidence
of quantizer saturation on this stress source, not evidence that reconfigure
ignores its requested rate. Stronger presets did not fix its bitrate floor.

A P1 sequential 180-frame-per-phase 20-to-8 Mbps run produced 15.982 then
18.978 Mbps; P4 single pass produced 15.864 then 19.050 Mbps with p95 output
latency increasing from 5.31/6.56 ms to 7.95/8.20 ms. The phases use different
source positions, so they cannot alone establish that lowering bitrate raised
output. P1/single-pass remains selected; experimental preset changes reverted.

NVIDIA documents that two-pass encoding can improve CBR targeting, with lower
performance; it is not a guarantee against exceeding the quantizer's usable
range. maxBitRate is ignored in CBR, and filler insertion pads undershoot, so
neither is an overshoot remedy. If the encoded byte rate exceeds available
wire capacity persistently, reduce image resolution or capture cadence before
encoding; preserve the bounded queue and do not discard encoded reference deltas.

Primary reference:
https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/
