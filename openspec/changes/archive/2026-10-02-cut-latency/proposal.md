## Why
Read-only audits (2026-10-02) found the Mac host streams **JPEG over WebSocket**. The VideoToolbox encoder exists but `build-mac.sh` excludes `mac/encode/`, and BWP is win32-only and has never run. Each frame costs ~30 ms of host CPU and 60–250 KB. On top of that, every single tap waits 260 ms for a possible double-tap, keep-alive drops after 5 s idle, and the phone pushes each JPEG through base64 twice and re-renders the whole route.

## What Changes (ranked: win per effort)
Group H — host quick wins (agent H):
1. Tap sends at once. Double-tap = second click with `clickState=2` (Input.swift already sets clickState; Windows helper equivalent). **−260 ms per tap.**
2. `keepAliveTimeout=65s`, `headersTimeout=66s` on both servers. **−1 handshake (10–180 ms) after any pause.**
3. Frame loop checks backpressure BEFORE capture and waits on drain (≤10 ms), not a fixed 50 ms. Buffer cap = ~2 frames (≥64 KB) instead of 256 KB. **−50–80 ms stalls, −bufferbloat on cellular.**
4. Explicit `setNoDelay(true)` on the raw socket in transport.ts.
5. Helper input commands run on their own serial queue so they never wait behind a capture (main.swift; BelayHost.cs equivalent). **−5–25 ms per input.**
6. Windows GDI capture bitmap `Format32bppPArgb`. **−5–10 ms/frame.**
7. Cache `tailnetTrusted` per IP for 60 s; `/health` no longer shells out per call.
8. BWP keyframe interval default 30 s, passed from Node (on-demand keyframes already exist).

Group C — client quick wins (agent C):
9. The JPEG frame lives in an external store and only a leaf `<Image>` re-renders. Newest-wins per animation frame (stale payloads never parsed). The data URI is built once (preview-store reuses it). **−8–20 ms JS/frame, no unbounded queue.**
10. Race stagger 250 → 75 ms. **−~175 ms away-from-home connects.**
11. Skip the `/challenge` round trip only when the link is HTTPS with a pinned fingerprint (TLS pin already proves identity). Keep it for plain/Tailscale. **−1 RTT per connect.**
12. BWP: gap detection on frame_id → request keyframe; replace the 2 ms poll sleep with a blocking wait; skip cursor events with no listener; 2–4 MB UDP recv buffer.

Group V — Mac H.264 (agent V, the big one):
13. Compile `mac/encode/VideoEncoder.swift` into the default helper. Fix its config (drop MaxKeyFrameIntervalDuration, ExpectedFrameRate = capture fps). Send Annex-B access units over the EXISTING binary `/ws/screen` frames with a codec tag in the frame-codec meta. The phone decodes natively with the existing `modules/belay-stream` H264Stream/AVSampleBufferDisplayLayer path (bytes must not cross JS — use blob or a native socket). JPEG stays as fallback. SCK captures at the target size on the GPU and 60 fps. **~30 ms → ~8 ms host/frame, 5–10× less bandwidth.**

Later (not this change): input over a persistent WebSocket (also fixes out-of-order moves), SCStream pre-warm for time-to-first-frame, auth header on native WS instead of the ticket round trip.

## Impact
server/src (index.ts, transport.ts), server/native/mac, server/native/BelayHost.cs, crates/belay-*, app/src/screen, app/src/devices, modules/belay-stream. Security-relevant: item 11 (owner-visible in the PR).
