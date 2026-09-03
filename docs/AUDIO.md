# Audio: streaming the host's system audio to the phone

The unlock for "watch/play/control anything": the phone hears what the computer
plays. This document records the adopt/fork/build decision, what is built and
**exactly how far each piece is verified**, the wire contract, and the runbook
for finishing verification on real devices. The reverse direction (phone mic →
host) reuses the same wire format and jitter policy and is explicitly out of
scope for this slice.

Everything here is behind `BELAY_WEBRTC` — with the flag off there is no audio
REST surface, no `/ws/audio` route, and the shipping JPEG/input paths are
byte-for-byte untouched.

---

## 1. Adopt / fork / build — and licenses

**Agreed direction: driverless loopback FIRST on both platforms.** No kernel
extension, no HAL plug-in, no installer step, no new permission prompt where
the OS allows it. A virtual audio driver comes later and only for the one case
that needs it (headless Windows, no render endpoint).

| Piece | Decision | License notes |
|---|---|---|
| macOS capture | **Build on ScreenCaptureKit `capturesAudio`** (macOS 13+). Rides the *same* TCC grant the screen path already holds — the checkbox macOS names "Screen & System Audio Recording". No driver. | Apple system API — no license exposure. |
| macOS alternative | CoreAudio process taps (`CATapDescription`, macOS 14.2+) — noted for the mic-return direction and for capture independent of ScreenCaptureKit; needs its own audio-capture TCC prompt (`NSAudioCaptureUsageDescription`). Not used in this slice. | Apple system API. |
| BlackHole | **Reference only. Never fork, link, or port.** It is the best-documented HAL loopback driver, useful to read; it is **GPL-3.0**, incompatible with this MIT-ish host. | GPL-3.0 — incompatible. |
| Windows capture | **Build on WASAPI loopback**: `IMMDeviceEnumerator.GetDefaultAudioEndpoint(eRender)` + `IAudioClient.Initialize(SHARED, LOOPBACK\|EVENTCALLBACK)`. Event-driven loopback is supported since Windows 10 1703. Per-process loopback (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Win 10 20H1 / Win 11 22H2 polish) is documented in-source as a later addition. | Win32 system API — no license exposure. |
| Windows headless (later) | **Fork Microsoft's SYSVAD** virtual audio driver sample when a host with *no* render endpoint must still produce audio. Separate milestone; driver signing is its own project. | MIT (Windows-driver-samples) — compatible. |
| Codec | **Adopt libopus**, statically vendored into the helpers exactly like libdatachannel (prebuilt archive, no package manager) — gated behind `BELAY_HAVE_OPUS`, not yet vendored. Until then the helpers emit PCM16 and the wire's `codec` field is how Opus arrives with **zero wire change**. | BSD-3-Clause — compatible. Patent grants are royalty-free. |
| Jitter buffer | **Build** — pure policy (`audio-jitter.ts`), NetEq-shaped: adaptive target depth from an RFC 3550-style interarrival-jitter estimate. Building it pure is what makes it testable with no audio hardware; adopting NetEq itself would drag in half of libwebrtc. | n/a (ours). |

Why not JS-side Opus (`@discordjs/opus`, wasm builds): encode belongs in the
native helper next to the capture — crossing the stdio pipe with raw PCM at
384 KB/s just to encode in Node adds copies and latency, and Node never sees
media in the target architecture anyway (PERFORMANCE-PLAN §2).

---

## 2. What exists, and how far each piece is verified

### TESTED-AND-DONE (runs under `node --test`, no hardware)

| Module | Job |
|---|---|
| `app/src/stream/webrtc/audio-frames.ts` | The binary wire frame (magic/version/seq/timestamp/codec/length + payload) and wrap-aware u16 seq arithmetic. `audio-frames.test.mjs`. |
| `app/src/stream/webrtc/audio-jitter.ts` | The jitter-buffer policy: prebuffer, reorder, loss concealment (bounded), late/duplicate handling, stream-restart resync, underrun-driven depth growth, adaptive target from interarrival jitter, bounded memory. Pure and immutable. `audio-jitter.test.mjs`. |
| `app/src/stream/webrtc/audio-stream.ts` | The push contract: `AudioSender` (stamps seq/timestamp, frames packets) and `AudioReceiver` (validates, jitter-buffers, answers each 20 ms tick with play/conceal/wait). Transport injected as a byte callback. `audio-stream.test.mjs`. |
| `app/src/stream/webrtc/channels.ts` | New `audio` data channel spec (unreliable, unordered — a retransmit past the playout deadline is wasted) + `audioframe` routing. |
| `app/src/stream/webrtc/peer-adapter.ts` | `sendBytesOn(channel, bytes)` — the binary path onto a data channel, no JSON wrapper. Tested with the fake peer connection. |
| `server/src/audio.ts` | Helper-push validation (caps, base64 shape, codec whitelist) and the server-side wire encoder. **Golden-vector test pins the exact bytes on both sides** — `server/test/audio.test.ts` and `audio-frames.test.mjs` carry the same 13-byte vector; change the layout and both fail. |
| `server/src/audio-routes.ts` | REST `POST /audio/start`, `POST /audio/stop`, `GET /audio/status` + the `/ws/audio` binary relay with refcounted capture lifecycle and shed-on-congestion (`shouldDropAudioFrame`). Registered by `index.ts` **only when `BELAY_WEBRTC` is on**. |
| `server/src/native.ts` | `audiostart`/`audiostop`/`audiostatus` verbs and the `type:'audio'` push subscription (mirrors the webrtc push shape). |

`cd app && npx tsc --noEmit && npm test` and
`cd server && npx tsc --noEmit && npm test` are green with all of the above.

### COMPILED AND PARTIALLY RUNTIME-VERIFIED (macOS) — with one honest caveat

`server/native/mac/AudioCapture.swift` + the `audiostart|audiostop|audiostatus`
verbs in `main.swift` and `ReplyWriter.push` in `Protocol.swift`.

Verified on this machine (M-series, macOS 26, `scripts/smoke-audio.py`):

- `build-mac.sh` compiles the helper universal (arm64 + x86_64) with the audio
  path **in the default build** — no opt-in flag, because it is dead code until
  `audiostart` arrives.
- `audiostart` → `{capturing:true, codec:"pcm16", sampleRate:48000, channels:2}`;
  `audiostatus`/`audiostop` behave; screen/input verbs unaffected.
- `type:"audio"` frames flow at a **perfect 20 ms cadence** (585 contiguous
  frames observed over ~12 s), seq contiguous, timestamp stepping exactly 960
  samples, 3840-byte PCM16-stereo payloads — the whole framing path is real.

**CAVEAT — silent capture:** on this machine every delivered sample was ZERO
even while audio was audibly playing (tested with both `afplay` and a Chromium
tab playing a 440 Hz WebAudio tone; output device: built-in speakers, 48 kHz,
not muted; delivered format confirmed float32 non-interleaved 2ch via
`BELAY_AUDIO_DEBUG=1`). Delivery works; content is silence. Do **not** claim
audio works end-to-end. Prime suspects, in order:

1. **TCC audio attribution.** The helper runs ad-hoc-signed under a terminal's
   responsible process. macOS 15+ splits "System Audio Recording" from screen
   recording in places; a grant that satisfies `CGPreflightScreenCaptureAccess`
   can still leave SCK zero-filling audio (zero-fill instead of an error is the
   documented TCC failure mode for audio). Check *System Settings → Privacy &
   Security → Screen & System Audio Recording* for the terminal/helper entry;
   re-tick it (the ad-hoc CDHash changes each rebuild, invalidating old grants).
2. macOS 26 behaviour change in SCK audio for display-filter streams (the
   Sequoia era had documented audio-capture regressions).
3. If both dead-end: switch to a CoreAudio process tap (`CATapDescription`,
   macOS 14.2+) — the fallback this document already scopes.

Reproduce with: `python3 server/scripts/smoke-audio.py` (prints a
SOUND CAPTURED / SILENT CAPTURE verdict).

### WRITTEN-BUT-NOT-COMPILED (Windows)

`server/native/BelayHostAudio.cs` (+ dispatch in `BelayHost.cs`, added to
`build.ps1`). No Windows machine or C# compiler exists in the environment this
was written in — it has never been compiled, let alone run. The COM interop
(IMMDeviceEnumerator/IMMDevice/IAudioClient/IAudioCaptureClient vtables, the
mix-format probe, the event-driven loopback loop, the 48 kHz linear resampler)
follows the documented recipe, but treat every line as unverified. If
`build.ps1` fails on it, the fastest rollback is removing `BelayHostAudio.cs`
from `$src` and the three `case "audio…"` lines — nothing else references it.

---

## 3. The wire contract (all transports)

One frame = 20 ms of audio, 48 kHz. Binary layout (big-endian), 11-byte header:

```
[0]     magic 0xA5
[1]     version<<4 | flags        (version 1, flags 0)
[2..3]  seq        u16, wraps     (loss/reorder detection)
[4..7]  timestamp  u32, wraps     (samples @48 kHz — the playout clock)
[8]     codec      0=opus, 1=pcm16 (48 kHz interleaved s16le)
[9..10] payload length u16        (1..4096)
[11..]  payload
```

Helper → Node rides stdio as `{"type":"audio",seq,ts,codec,sr,ch,data}` JSON
lines (validated by `server/src/audio.ts`); Node → phone rides `/ws/audio` as
one binary WS message per frame; later the identical bytes ride the `audio`
data channel (`channels.ts`), and eventually an SRTP Opus track replaces the
framing entirely. The `codec` byte is how PCM16→Opus lands with no wire change.

Bandwidth honesty: PCM16 stereo is 192 KB/s (~1.5 Mbps) — fine on LAN, wrong on
cellular. Opus at 20 ms / 64 kbps is ~25× smaller; vendoring libopus into the
helpers is the first follow-up after sound is verified.

---

## 4. Runbook: verifying on real devices

macOS (start here — it is one caveat away):
1. `cd server && npm run build:native` (audio is in the default build).
2. `python3 scripts/smoke-audio.py` while music plays. Want: `SOUND CAPTURED`.
   If `SILENT CAPTURE`: work the TCC checklist in §2, re-run.
3. `BELAY_WEBRTC=1 npm start`, connect a WS client to `/ws/audio` (with a
   ticket, as for `/ws/screen`), assert binary frames arrive and decode via
   `decodeAudioFrame` (the app module).
4. On the phone (dev client): feed `/ws/audio` bytes into `AudioReceiver`, play
   `play` actions' PCM through expo-av / AVAudioEngine, output silence for
   `conceal`/`wait`. Listen. Measure delay (target: `targetDelayMs` + one frame).

Windows:
1. On a Win10 1703+ box: `npm run build:native:win` — first prove
   `BelayHostAudio.cs` **compiles** (see rollback note in §2 if not).
2. Same smoke sequence over stdio (`audiostart`, play sound, expect nonzero
   PCM), then steps 3–4 above.
3. Win11 22H2+: consider per-process loopback so notification dings from other
   apps can be excluded.

Not until sound is heard on a phone may anyone claim the feature works.

---

## 5. Design notes worth keeping

- **Separate audio-only SCStream** on macOS rather than `capturesAudio` on the
  screen `DisplayStream`: screen streams restart on resolution change and
  stall-healing (every restart would be an audible dropout), and audio must
  flow when nobody is polling JPEG frames. Costs one extra SCStream.
- **Unreliable, unordered audio channel** (`maxRetransmits: 0`): with a 40–80 ms
  jitter cushion, a retransmit that arrives late is pure waste; concealment is
  cheaper than retransmission at these deadlines. The reliable channels keep
  the stuck-key guarantee untouched.
- **Refcounted capture** (`audio-routes.ts`): first listener starts the helper's
  capture, last one out stops it — an idle host never encodes audio nobody
  hears, and a dead socket cannot leak a running capture.
- **Shed on congestion, newest wins** (`shouldDropAudioFrame`, 64 KB cap):
  identical philosophy to the screen path's frame dropping — queued audio is
  dead audio; the receiver's concealment covers the gap.
- **Reset heuristic** (`resetGapFrames`): a seq jump > 5 s of frames reads as a
  capture restart and resyncs instead of concealing thousands of frames. A
  fresh `AudioSender` per capture session is what makes restarts look distant.
