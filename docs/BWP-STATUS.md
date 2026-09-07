# BWP status — what is real, what is stubbed

An honest map of the low-latency path (H.264 over the Belay Wire Protocol) as
of the `feat/bwp-default-low-latency` branch point (`main` @ `d72c713`).
Every claim points at a file and line so it can be re-checked rather than
trusted. Line numbers are as of that commit.

Read `WIRE-PROTOCOL.md` for the protocol itself, `PERFORMANCE-PLAN.md` for
why it exists, and `WEBRTC-SLICE.md` for the *other* low-latency path — which
this document is not about, except to say where the two are confused.

## One correction to the mental model

The C# host helper (`server/native/BelayHost*.cs`) is **not** where BWP video
is encoded. The Media Foundation H.264 code in `server/native/BelayHostWebRtc.cs`
(559 lines, `MFTEnumEx` at line 353, `CODECAPI_AVLowLatencyMode`/CBR at 367–369)
belongs to the flag-gated WebRTC slice and has never been compiled into a
shipping helper. Likewise `server/native/mac/encode/VideoEncoder.swift`
(VideoToolbox) exists only under the WebRTC build flag.

The real BWP host is the Rust binary `belay-stream` (`crates/belay-stream`),
which links `belay-encode` (Desktop Duplication → D3D11 NV12 → Media
Foundation H.264 MFT) and `belay-net` (UDP session, pacing, feedback). Node
spawns it as a child process (`server/src/bwp-stream.ts:215`). Everything in
this audit about "the encoder" refers to that crate, not to C#.

## Summary table

| Area | State | Evidence |
|---|---|---|
| Wire protocol (framing, AEAD, reassembly, AIMD) | **Done, tested** (52 tests) | `crates/belay-wire/src/*` |
| UDP session, pacer, RTT/loss feedback | **Done, tested** (28 tests) | `crates/belay-net/src/session.rs`, `feedback.rs` |
| Windows capture + GPU NV12 + MF H.264 encode | **Written, uncompiled here**; keyframe forcing is wrong | `crates/belay-encode/src/h264.rs` |
| Windows host streamer binary | **Written, uncompiled here**; input channel ignored | `crates/belay-stream/src/stream.rs` |
| macOS host streamer | **Does not exist** — hard fail | `crates/belay-stream/src/main.rs` (`fail("the host streamer is Windows-only")`), `server/src/bwp-stream.ts:29` |
| Server session supervision (`bwpStart`/`bwpOffer`/`bwpStats`/`bwpEnded`) | **Done** | `server/src/index.ts:1362–1416,1463–1464` |
| `/health` advertises BWP | **Missing** | `server/src/index.ts:240–256` (no `bwp` field) |
| iOS UDP client (C ABI) | **Done, tested** (6 tests); no send path, no RTT accessor | `crates/belay-client/src/lib.rs` |
| iOS decode (Annex-B → AVCC → `AVSampleBufferDisplayLayer`) | **Done for the happy path**; no keyframe request on error | `app/modules/belay-stream/ios/H264Stream.swift`, `BelayStreamView.swift:130–160` |
| App requests BWP | **Done, unconditional** when native module present | `app/src/screen/stream.ts:499–506,560–566` |
| Decoded-frame liveness → fallback | **Missing**; `onStatus` never wired in the screen | `app/app/(home)/screen.tsx:894–895` |
| Manual BWP toggle in HUD | **Missing** | `app/src/screen/hud.ts`, `parts.tsx` |
| Gaming mode prefers BWP | **Partial**: it picks presets, not the transport | `app/src/screen/stream.ts:234`, `app/src/gamepad/presets.ts` |
| Gamepad over BWP Input channel | **Missing entirely** — WebSocket only | `app/src/gamepad/use-gamepad.ts:68`, `server/src/gamepad-channel.ts` |
| Glass-to-glass latency in HUD | **Missing**; RTT exists internally, not exposed | `crates/belay-net/src/session.rs:89,327–329` |

## Detail by area

### 1. iOS decode path

**Works**

* `crates/belay-client/src/lib.rs` — `belay_client_open/local_port/next_frame/
  bitrate/close`; a receive loop over `belay_net::Session`; per-frame
  `keyframe` flag surfaced in `BelayFrame`. Tests pass (`cargo test`, 6).
* `app/modules/belay-stream/ios/H264Stream.swift` — splits Annex-B, caches
  SPS/PPS, builds a `CMVideoFormatDescription`, converts to AVCC length
  prefixes, tags samples `DisplayImmediately`.
* `BelayStreamView.swift:130–152` — one receive thread polls
  `belay_client_next_frame`, enqueues into `AVSampleBufferDisplayLayer`
  (hardware decode), emits `onStatus {state: "live"}` on the first enqueued
  sample.
* Delta frames: nothing in the pipeline rejects P-frames; `H264Stream.decode`
  only needs SPS/PPS once. Delta frames already flow if the host sends them.

**Missing**

* **No keyframe request reaches the host.** `belay-net` sets `want_keyframe`
  on a dropped Video frame (`session.rs:319`) and turns it into a *local*
  `Event::KeyframeNeeded` (`session.rs:286–288`). On the host that drives
  `encoder.request_keyframe()` (`crates/belay-stream/src/stream.rs:178`), but on
  the client `belay-client` discards it — there is no control message for it in
  `on_control` (`session.rs:327`, which only decodes the 20-byte `Report`).
  The decoder therefore has no way to recover from loss except the host's
  periodic GOP.
* `BelayStreamView.swift:144` flushes the layer on `.failed` but cannot ask for
  a keyframe; `frame.keyframe` is never consulted, so a P-frame after a flush
  is enqueued against a stale reference.
* `app/app/(home)/screen.tsx:894` mounts `BelayStreamView` without `onStatus`,
  so JS never learns that a frame decoded. "BWP live" in the app means "an
  offer arrived", not "pixels are showing".

### 2. Host encoder

**Written (Windows, Rust)** — `crates/belay-encode/src/h264.rs`

* `find_h264_encoder` prefers hardware MFTs, then sync, then any (line 496).
* Sets `CODECAPI_AVLowLatencyMode`, `CODECAPI_AVEncCommonRateControlMode = 0`
  (CBR), `CODECAPI_AVEncCommonMeanBitRate` (lines 159–161); `set_bitrate`
  re-applies the mean bitrate live (line 306).
* Async MFT drain loop, D3D11 texture input path, CPU NV12 fallback.

**Wrong**

* Keyframe forcing sets `MFSampleExtension_CleanPoint` on the *input* sample
  (lines 283–286 and 333–336). That attribute is an *output* marker set by the
  encoder; setting it on input is not the documented way to force an IDR and
  hardware MFTs ignore it. The documented control is
  `CODECAPI_AVEncVideoForceKeyFrame` via `ICodecAPI::SetValue` before
  `ProcessInput`. As written, host-side keyframe recovery is a no-op.

**Not verifiable here**

* No Windows toolchain on this Mac: `belay-encode`/`belay-stream` cannot be
  compiled or run. Cargo targets present: aarch64-apple-darwin, aarch64-apple-ios,
  aarch64-apple-ios-sim, x86_64-apple-ios. There is no evidence in the repo
  (no CI artefact, no `belay-stream.exe` checked in, no log) that the streamer
  has ever produced a frame on real hardware.

**macOS**

* No BWP host at all. `crates/belay-stream/src/main.rs` fails with
  "the host streamer is Windows-only"; `server/src/bwp-stream.ts:29` returns
  `null` on any non-win32 platform, so `bwpAvailable()` is false and Node
  answers `bwpUnavailable`. `belay-encode` is `#[cfg(windows)]` throughout.
  The VideoToolbox encoder under `server/native/mac/encode/` is WebRTC-only.

### 3. Server session / bitrate control

**Works** — `server/src/index.ts:1362–1416`

* `bwpStart` → `BwpSession.start` (fresh 32-byte key + 8-byte salt per
  session, key on stdin, peer address from the socket, port < 1024 refused) →
  `bwpOffer` to the phone; `stats`/`bitrate` relayed; exit/error → `bwpEnded`
  and the JPEG loop resumes (`bwpActive` guard at line 1489, 200 ms idle poll).
* Bitrate control is inside the streamer: `belay-net` AIMD on the host side,
  fed by the client's 50 ms `Report`s; the encoder is re-targeted through
  `set_bitrate`. Node only observes it.

**Missing**

* `/health` (`index.ts:240`) has no BWP capability flag; the phone cannot
  know in advance and has to try and wait for `bwpUnavailable`.

### 4. App stream selection

**Works** — `app/src/screen/stream.ts`

* Reserves a UDP port before opening the socket (line 499), sends `bwpStart`
  on open (line 560), handles `offer/stats/bitrate/unavailable/ended`
  (lines 331–377), re-sends `bwpStart` when the preset changes (line 252–260),
  suppresses the JPEG stall detector while BWP is live (line 616).
* `model.ts` presets carry `bwpPreset`/`bwpFps`; gaming mode swaps to
  `gamingQuality(bwpPath)` (line 234).

**Missing**

* Liveness is "offer received" (`bwpLive.current = true` at line 337), not
  "frame decoded". A host whose streamer starts but whose UDP never gets
  through (firewall, NAT, wrong interface) leaves the phone on a black
  `BelayStreamView` forever — JPEG is stopped on the host while `bwpActive`.
* No 3 s decoded-frame timeout, no automatic `bwpStop` + JPEG fallback.
* No manual toggle: the user cannot force JPEG or force BWP.
* Gaming mode does not force the transport; it only changes presets.

### 5. Gamepad

* Wire format is **17 bytes** (`app/src/gamepad/codec.ts`,
  `server/src/gamepad-codec.ts`): v1, buttons u16, lt/rt u8, four i16 axes,
  u32 seq. Sent every 8 ms over `/ws/gamepad` (`use-gamepad.ts:68`).
* Server side is a single-owner hub (`gamepad-channel.ts`) with a 4 ms tick
  and 750 ms watchdog.
* BWP has an `Input` channel (priority above Video) but: the client has no
  send API (`belay-client` is receive-only), the host streamer drops inbound
  frames (`stream.rs:184`, `Event::Frame { .. } => {}`), and Node has no way
  to receive them from the child. Also, despite `Channel::repairable`, no
  NACK/retransmit is ever sent by `belay-net` (the reassembler's `nack_list`
  is never consumed), so the Input channel is currently *not* reliable.

### 6. Glass-to-glass measurement

* The header carries `send_timestamp` (µs) and the `Report` echoes it
  (`echo_send_us`, `delay_us` in `crates/belay-net/src/feedback.rs`), so both
  ends already have a smoothed RTT (`session.rs:89`, `RttEstimator`).
* Nothing exposes it: `Session` has no accessor, `belay-client` has no
  `rtt_ms` call, Swift reports no latency status, `hud.ts` has no row for it.
  Host-side encode time is not in the `stats` line either.

## Test baseline at branch point

* `server`: 731 tests, 730 pass (one pre-existing `images.test.ts` failure
  from a leftover `~/.belay-test-images` directory — unrelated).
* `app`: 995 pass. `desktop`: 130 pass.
* `crates`: belay-wire 52, belay-net 28, belay-client 6 — all pass.
* `belay-encode`, `belay-stream`: not buildable on macOS.

## Plan of work (in the priority given)

1. Add a control-channel message kind so the client's keyframe need reaches
   the host; expose `request_keyframe` and `rtt_ms` through the C ABI; make
   Swift request a keyframe when the layer fails or a delta arrives with no
   reference, and report latency in `onStatus`.
2. Fix `CODECAPI_AVEncVideoForceKeyFrame` in `h264.rs` (uncompiled, small,
   reviewed twice). A macOS host is a new crate's worth of work and is not
   attempted here.
3. `/health` gains `bwp`; the app stops trusting "offer" as "live", falls back
   to JPEG after 3 s without a decoded frame, gets a HUD toggle, and gaming
   mode forces BWP on.
4. Gamepad over BWP: the parts that can be tested here (Rust client send path,
   host-side forwarding, Node ingestion) — the Windows half stays unverified.
5. HUD latency row from the RTT the session already measures.
