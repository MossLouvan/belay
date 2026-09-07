# Gaming performance and controller delivery

Engineering assessment for Belay, 7 September 2026.

Belay's desktop client needed a video-path change, not merely a higher FPS
setting. It previously used only JPEG, and Gaming lowered its picture to
1024 pixels wide at quality 35. The phone's Gaming preset capped H.264 at the
1.5 Mbps data-saver profile. Neither is an appropriate quality default for
fast, detailed games. The Windows host inspected for this work also lacked
both its ViGEm client runtime and virtual controller bus.

## What the evidence supports

| Decision | Primary evidence | Application to Belay |
|---|---|---|
| Hardware capture and encoding | [Microsoft Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) exposes desktop updates in DXGI surfaces. [NVIDIA's SDK 13.1 encoder guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html) recommends low/ultra-low latency tuning, CBR and small VBV buffers for game streaming. | Use the existing GPU capture/conversion/H.264 streamer; connect desktop clients to it. Verify the actual backend instead of assuming a hardware flag guarantees it. |
| Quality at 60 FPS before high refresh | [Parsec's gaming/playtest guidance](https://support.parsec.app/hc/en-us/articles/32361373629972-Gaming-Playtesting-Build-Reviews-and-QA), updated July 7, 2026, recommends 1080p, 60+ FPS and 25+ Mbps, with HEVC and hardware decoding. | Belay now starts Gaming at 60 FPS with its existing 20 Mbps maximum profile. This is a practical improvement within the current protocol, below Parsec's recommended ceiling; it is not demonstrated Parsec parity or an H.264 minimum requirement. |
| Bound latency-producing queues | [W3C WebCodecs](https://www.w3.org/TR/webcodecs/) defines decode queues and latency/hardware preferences; these are hints, not guarantees. | Bound pending JPEG decoding and desktop video handoff. On lost encoded dependencies request a keyframe; never treat arbitrary P-frames as independently decodable. |
| Correct controller mapping and lifecycle | [W3C Gamepad](https://www.w3.org/TR/gamepad/) defines standard mapping and negative-up Y axes; [Microsoft XINPUT_GAMEPAD](https://learn.microsoft.com/en-us/windows/win32/api/xinput/ns-xinput-xinput_gamepad) uses positive-up sticks. [Chromium's implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/gamepad/navigator_gamepad.cc) stops sampling hidden pages. | Preserve analog values and invert browser Y. Release on hiding; repeating a cached pressed button is not a heartbeat from a live controller. Prefer a supported pad over an unmapped device. |
| Diagnose the Windows target separately | [ViGEmClient](https://github.com/nefarius/ViGEmClient) requires the bus and a client integration; [Nefarius's EOL notice](https://docs.nefarius.at/projects/ViGEm/End-of-Life/) explains the archived status. [VirtualPad](https://docs.nefarius.at/projects/VirtualPad/) is a commercial framework. | Supply repeatable runtime/driver setup and independent XInput verification. Archived ViGEm remains usable, but a maintained replacement needs a separate licensing and compatibility decision. |

Sources were accessed September 7, 2026. Vendor guidance supplies architecture
and configuration evidence, not comparative measurements of Belay. Research
stopped after primary documentation and implementation sources resolved the
material codec, queue, mapping and driver questions; remaining uncertainty
requires device/game measurements rather than more general searching.

## Implemented changes

Capture API audit: Windows Graphics Capture (WGC) is not implemented. The live
Rust H.264 path imports `DesktopCapture` from `belay-encode/src/capture.rs`,
which uses `IDXGIOutputDuplication`. The native JPEG fallback calls GDI
`CopyFromScreen`. No Windows Graphics Capture API bindings are enabled in the
Rust capture crate. The legacy C# WebRTC capture scaffold is not a WGC backend.

- Desktop display windows negotiate the existing BWP H.264 stream over encrypted
  UDP. A small Rust receiver reuses the existing protocol implementation. The
  sandboxed Electron renderer receives bounded video messages and uses WebCodecs.
  Credentials cross stdin/IPC, not executable arguments or video URLs. Startup
  or decode failure returns to JPEG. Mac hosts retain their existing JPEG path.
- Gaming requests 60 FPS and the existing 20 Mbps adaptive ceiling. JPEG fallback
  requests 1600 pixels, quality 65, at most 30 FPS. Actual throughput depends on
  capture dimensions, endpoint hardware and the network.
- BWP receiver loss now sends an encrypted `IDR1` control request to the encoder
  peer. Hardware GOP hints are also backed by periodic explicit keyframe requests.
  Media Foundation settings now use their correct unsigned/boolean VARIANT
  types. Recovery uses [AVEncVideoForceKeyFrame](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencvideoforcekeyframe)
  before input, rather than misusing the output CleanPoint attribute.
- Capture avoids work while the send queue is congested. JPEG decoding retains
  one in-flight image and only the newest waiting image.
- Web clients now sample standard browser controllers. Desktop hidden windows
  release input, and a client that sends no first state cannot occupy the host
  controller indefinitely. Windows keyboard fallback uses scan codes.
- Settings apply supported FPS and bitrate presets to the active stream. Cancel
  discards the draft. Unsupported HEVC and 144–240 FPS choices were removed.
  Sheets fit short viewports. Touch labels no longer nest interactive buttons,
  which previously produced a visible React error overlay.

## Validation and limits

The final RTX 2070 SUPER synthetic video smoke test received 309 H.264 frames
and three keyframes in 8 seconds (about 39 FPS) through GPU encoding and encrypted
UDP. Before correcting the encoder property types it received 466 frames but
only one keyframe; that earlier result did not validate recovery or the requested
encoder settings. The final run does not meet the requested 60 FPS target and
needs profiling before any performance-parity claim. This measures
received synthetic frames, not game performance, hardware decode timing,
glass-to-glass latency or a sustained worst-case network test.

Electron interaction tests exercised pairing, actual H.264 decode/presentation,
Gaming toggles including rapid changes, compact layout and keyboard activation.
The same checks also pass against the installed Windows Belay executable.
A simulated standard controller traversed the real desktop renderer and
WebSocket; button, stick and neutral-release values were checked. Simulation
does not establish Bluetooth/device or Windows XInput behavior.

Phone-size Chrome tests exercise live JPEG, settings cancel/apply, portrait/
landscape resizing, loaded touch controls, and repeated Gaming entry/exit.
These are web tests, not an iOS device build. The iOS native modules require
a fresh Mac/Xcode build; Android native support and Safari hardware behavior
have not been established by these checks.

Windows host and Rust streamer/receiver builds pass. App/desktop unit tests and
focused host controller/streaming tests pass. The broader host suite was also
attempted: filesystem fixtures fail under Windows symlink privileges, POSIX
permission assumptions and path-dependent expectations. That broader suite is
not a clean release gate on this machine.

The x64 ViGEm runtime is installed locally. The signed bus installer was
downloaded, but Windows reported administrator elevation canceled; native
Xbox-controller delivery therefore remains blocked on this PC. The diagnostic
`node server/scripts/probe-gamepad.mjs` checks an actual virtual target through
XInput, including axes, triggers, release and detach, and refuses to generate
keyboard fallback input if the bus is unavailable. A real controller/game test
from the user's Mac/phone and Windows-to-Mac control test are still required.

## Next acceptance gate

1. Complete bus installation, then pass the XInput probe on the rebuilt host.
2. Build/install the receiver on the Mac client and refresh the iOS native build.
   Pair the actual controller, verify each control and rumble in a game, then
   unplug, hide/background, disconnect the network and reconnect while held.
3. Measure capture, encode, receive, decode and presentation FPS and timing
   distributions separately at 1080p60. Measure input-to-photon latency with an
   external camera; do not relabel RTT as that metric.
4. Compare detailed motion at 10/20 Mbps on LAN, direct Tailscale and cellular.
   Only then decide whether to expand the current 20 Mbps ceiling, add resolution
   scaling or HEVC, and offer high refresh as a tested capability.
5. Test multi-monitor selection, full-screen games, OS elevation, anti-cheat
   compatibility and physical controller models before broader distribution.

Remote access still uses a reachable LAN/Tailscale host. This work does not add
an Internet relay, automatic NAT traversal service or public-port deployment.
