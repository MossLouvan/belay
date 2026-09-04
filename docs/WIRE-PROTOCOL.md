# BWP — the Belay Wire Protocol

A datagram protocol for remote desktop, written in Rust, replacing
JPEG-over-WebSocket on the hot path.

## Why this exists, honestly

The tree already contains a WebRTC slice (`docs/WEBRTC-SLICE.md`) and a plan to
finish it (`docs/PERFORMANCE-PLAN.md`). BWP is a deliberate decision to own the
transport instead, and the tradeoff is worth stating plainly so nobody has to
rediscover it:

**What owning it costs.** WebRTC hands you congestion control, loss recovery,
jitter buffering, NAT traversal and DTLS-SRTP encryption, all of it hardened by
a decade of adversarial use. Every one of those has to be re-earned here, and a
half-built version of any of them is *worse* than the thing it replaced. There
is also a client cost: `react-native-webrtc` exists; a custom datagram protocol
needs a native module on iOS talking to this crate over FFI.

**What owning it buys.** No SDP/ICE handshake before the first pixel. Channel
priorities we choose (a cursor update must never queue behind a video frame).
Frame-aware loss policy — a dropped P-frame is not worth retransmitting once
the next I-frame is already encoded, which a generic transport cannot know.
Encoder and transport sharing one bitrate controller instead of negotiating
through an ABR estimator. Those are real, and they are the reasons to do it.

**What does not change either way.** The dominant latency cost today is the
codec, not the wire: `capture → scale → JPEG → base64 → JSON → WebSocket` sends
a whole independently-coded frame every time, with no hardware encode. BWP is
built assuming H.264/HEVC with delta frames arrives alongside it. A perfect
transport carrying whole JPEGs is still a slideshow.

The good ideas from the WebRTC slice are ported here rather than discarded —
the AIMD-with-RTT-gradient control law, the loss-lab methodology, and the
glass-to-glass measurement discipline all carry over.

## Layering

```
   video encoder ──┐                    ┌── video decoder
   cursor sampler ─┼─ channels ─ BWP ─ UDP ─ channels ─┼── cursor renderer
   input events ───┘                    └── input apply
```

* `belay-wire` (this crate) is **pure protocol**: framing, fragmentation,
  reassembly, loss accounting, congestion control, pacing, jitter estimation.
  It owns no socket and no encoder, so every rule in it is exercised under
  `cargo test` with no hardware, no VM and no phone — the same discipline that
  made the WebRTC modules testable.
* A thin host layer owns the UDP socket and the encoder and feeds this crate.

## Channels

Priority is strict, highest first. A datagram from a higher channel is always
paced ahead of a lower one.

| Ch | Name     | Delivery              | Why |
|----|----------|-----------------------|-----|
| 0  | `Control`| reliable, tiny        | handshake, bitrate setpoints, mode changes |
| 1  | `Cursor` | unreliable, newest-wins | a stale cursor position is worthless; never retransmit, never queue |
| 2  | `Input`  | reliable, ordered     | a dropped keystroke is unacceptable; a reordered one is worse |
| 3  | `Video`  | unreliable + selective repair | repair only while the frame can still be shown |
| 4  | `Audio`  | unreliable, newest-wins | late audio is dropped, not played |

Cursor above video is the single most visible latency decision in the protocol.
Today the cursor is composited *into* the JPEG (`Native.DrawCursor`), so cursor
motion costs a whole frame — at 12 fps that is up to 83 ms of pure input lag on
the one element the eye tracks continuously. Splitting it onto its own
unreliable channel lets the cursor move at sampling rate while video runs at
frame rate.

## Datagram header

16 bytes, little-endian, then payload. Sized so a 1200-byte MTU budget leaves
1184 for payload.

```
 0       1       2       3
+-------+-------+---------------+
| magic | ver/ch| flags         |   magic 0xB1, ver:4|chan:4, flags:u8
+-------+-------+---------------+
| sequence (u32)                |   per-connection, wraps
+-------------------------------+
| frame id (u32)                |   groups fragments; also the ack unit
+-------------------------------+
| frag index (u16) | count (u16)|   0-based; count==1 means unfragmented
+-------------------------------+
| send timestamp (u32, µs)      |   sender clock, for RTT + jitter
+-------------------------------+
```

`flags`: bit0 `KEYFRAME`, bit1 `FRAME_END`, bit2 `RETRANSMIT`, bit3 `ACK_REQ`.

## Loss policy, frame-aware

Generic transports retransmit anything lost. This one asks whether the loss is
still worth repairing:

* a fragment of the **current** frame, still within its playout deadline → NACK
  once, immediately;
* a fragment of a frame already superseded by a newer keyframe → **drop it**,
  and tell the encoder to emit a keyframe if the decoder is broken;
* `Cursor`/`Audio` → never repaired; the next sample is the repair.

## Congestion control

Ported from `app/src/stream/webrtc/congestion.ts` — loss-based AIMD with an
RTT-gradient guard. Loss means the bottleneck is already overrun, so back off
multiplicatively; RTT climbing above its floor with no loss means a queue is
building, so hold; clean and drained means probe up additively. The rationale
is written out in that file and holds identically here.

The one change: the controller's output is the **transport's** send budget and
the **encoder's** target bitrate at once, rather than being translated through
a separate ABR estimator. That is a direct benefit of owning both ends.

## Security

Not negotiable and not novel: ChaCha20-Poly1305 AEAD on every datagram, keys
derived with HKDF from the existing paired device token, with the header as
associated data and the sequence number as part of the nonce. No custom
cryptography — the protocol is custom, the primitives are not.

## Status

See `crates/belay-wire/`. Nothing here is wired into the shipping path yet; the
JPEG-over-WebSocket transport remains the default until BWP beats it on the
loss-lab bar `docs/PERFORMANCE-PLAN.md` already names (p50 ≤ 40 ms, p95 ≤ 60 ms
on LAN/Tailscale-direct).

Measurement happens on real hardware, not in the dev VM: the VM has no GPU, so
there is no hardware encoder and any number taken there would misrepresent the
experience.
