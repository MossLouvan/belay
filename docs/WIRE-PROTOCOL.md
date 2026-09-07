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

## Controller channel: `/ws/gamepad`

This authenticated WebSocket is separate from the Rust BWP datagrams above.
Upgrade with the same one-shot `/ws-ticket` flow as `/ws/cursors`.
An optional `preset=generic|roblox|fortnite` query selects keyboard fallback
bindings; it never remaps the virtual Xbox controller.

Every client input message is **binary**, exactly **17 bytes**, little-endian:

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | Version, must be 1 |
| 1 | u16 | Buttons |
| 3 | u8 | Left trigger, 0..255 → 0..1 |
| 4 | u8 | Right trigger, 0..255 → 0..1 |
| 5 | i16 | Left X |
| 7 | i16 | Left Y |
| 9 | i16 | Right X |
| 11 | i16 | Right Y |
| 13 | u32 | Sequence, wrapping |

Sticks decode negative values divided by 32768 and nonnegative values by
32767, giving exact -1 and +1 endpoints. Positive X is right, positive Y is up.
Buttons use XUSB bits: Up `0x0001`, Down `0x0002`, Left `0x0004`, Right `0x0008`,
Start `0x0010`, Select `0x0020`, L3 `0x0040`, R3 `0x0080`, LB `0x0100`, RB
`0x0200`, A `0x1000`, B `0x2000`, X `0x4000`, Y `0x8000`. Two otherwise
reserved bits are Belay touch extensions: Edit `0x0400`, Build `0x0800`.
The ViGEm report strips these two bits; Fortnite keymap mode consumes them.

Frames with the wrong length/version, or text messages, close the socket.
The payload limit is also enforced at WebSocket assembly. A sequence is newer
only when `(next - previous) >>> 0` is between 1 and `0x7fffffff` inclusive.
Duplicate/stale samples are discarded. The server admits at most 500 frames
per one-second window and forwards only the newest pending sample per 4 ms
helper tick, retaining that sample while the helper pipe is busy.

Server messages are validated JSON:

```json
{"type":"hello","available":true,"backend":"vigem"}
{"type":"hello","available":true,"backend":"keymap","reason":"ViGEmBus connect failed"}
{"type":"hello","available":false,"backend":"unavailable","reason":"Native helper unavailable"}
{"type":"rumble","low":0.5,"high":1}
```

`low`/`high` are finite 0..1 motor intensities; zero stops that motor. While
rumble is active, the host refreshes it every 250 ms. The phone stops motors
after 750 ms without a refresh, including a stalled network. Backend
changes may send a new hello. One socket owns the controller until detach
finishes. Disconnect and 750 ms of inactivity release held state. Clients
send full-state heartbeats even when buttons do not change. The gamepad lane
bypasses input-floor arbitration but retains idle/injection accounting.

### BWP decoder recovery control

A four-byte ASCII `IDR1` payload on the authenticated encrypted Control channel
requests a new H.264 keyframe. It is separate from the 20-byte feedback report.
New receivers send it after video reassembly loss or a bounded desktop handoff
drop; old peers ignore the shorter unknown message. Encoder peers report
`KeyframeNeeded` and force the next encoded frame. Periodic keyframes remain
a compatibility backstop. Session credentials and source-address validation
apply before this control is interpreted.

### Experimental BWP XOR repair

Feedback retains its 20-byte layout. `highest_seq`, echo and receiver delay refer
to the newest actual advancing packet. `received`/`expected` now describe a
separate settled sequence range: gaps get 25 ms to fill before being counted as
loss. This accommodates packet reordering and scheduling jitter without delaying
media delivery. State is bounded to 4096 pending sequence slots. Old senders can
consume the unchanged loss ratio; old receivers retain their earlier accounting.

Streamer configuration `"fec": true` opts into capability negotiation. The host
sends encrypted four-byte Control `FEC?`, retrying at one-second intervals until
a compatible client replies `FEC!`. The host never sends protected video before
that acknowledgement; old peers ignore these short controls. Header version stays
1. Video mode and shard size are frozen for each access unit.

Protected Video uses flag bit 4 and up to 1120 plaintext bytes per shard. Every
group of at most eight shards has a Control parity packet with flag bit 5. Its
plaintext is `FEC1`, frame ID (u32 LE), total fragment count (u16 LE), first
fragment index (u16 LE), group count (u8), keyframe boolean (u8), one length
(u16 LE) per shard, then their zero-padded XOR bytes. First index is a multiple
of eight. Full nonfinal shards are 1120 bytes; the final shard is 1–1120 bytes.
The largest parity datagram is 1182 bytes including header and authentication tag.

Parity is authenticated and paced inside the total wire bitrate. The encoder's
picture budget reserves parity/header overhead. Reconstructed shards enter
reassembly without being counted as network arrivals or changing replay state.
At most eight frames with 512 shards each are retained; groups expire after
200 ms without new valid progress, with a two-second hard frame lifetime.
Duplicates cannot extend expiry. Completed dependencies can wait for missing
earlier video for an 8 ms grace period, checked at polling, with at most three
completed frames queued. Unrecoverable gaps request `IDR1`.

Ordinary new-sender fragments use up to 1168 plaintext bytes so header plus
tag fit 1200 bytes. Receivers still accept legacy 1184-byte plaintext fragments.
See [FEC experiment](FEC-EXPERIMENT.md) for measured tradeoffs and limitations.
