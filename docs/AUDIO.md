# Audio: streaming the host's system audio to the phone

The unlock for "watch/play/control anything": the phone hears what the computer
plays. This document records the adopt/fork/build decision, what is built and
**exactly how far each piece is verified**, the wire contract, and the runbook
for finishing verification on real devices. The reverse direction (phone mic →
host) reuses the same wire format and jitter policy and is explicitly out of
scope for this slice.


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
| `server/src/audio-routes.ts` | REST `POST /audio/start`, `POST /audio/stop`, `GET /audio/status` + the `/ws/audio` binary relay with refcounted capture lifecycle, shed-on-congestion (`shouldDropAudioFrame`) and the stall watchdog. Always registered by `index.ts`. |
| `server/src/audio-health.ts` | Why a host cannot do audio, as a typed verdict with a fix — the four causes in §2a. Pure; `server/test/audio-health.test.ts`. |
| `app/src/stream/audio-capability.ts` | The phone's half of the same question: probe result → a sentence plus a fix, and the short dock label. Pure; `audio-capability.test.mjs`. |
| `server/src/native.ts` | `audiostart`/`audiostop`/`audiostatus` verbs and the `type:'audio'` push subscription (mirrors the webrtc push shape). |

`cd app && npx tsc --noEmit && npm test` and
`cd server && npx tsc --noEmit && npm test` are green with all of the above.

### COMPILED AND RUNTIME-VERIFIED (macOS)

`server/native/mac/AudioCapture.swift` + the `audiostart|audiostop|audiostatus`
verbs in `main.swift` and `ReplyWriter.push` in `Protocol.swift`.

Verified on this machine (M-series, macOS 26, `scripts/smoke-audio.py`):

- `build-mac.sh` compiles the helper universal (arm64 + x86_64) with the audio
  path **in the default build** — no opt-in flag, because it is dead code until
  `audiostart` arrives.
- `audiostart` → `{capturing:true, codec:"pcm16", sampleRate:48000, channels:2}`;
  `audiostatus`/`audiostop` behave; screen/input verbs unaffected.
- `type:"audio"` frames flow at a **perfect 20 ms cadence** (251 frames in the
  current smoke test, including 57 nonzero frames), seq contiguous, timestamp stepping exactly 960
  samples, 3840-byte PCM16-stereo payloads — the whole framing path is real.

The old silent-capture result was a smoke-test race: `afplay` started before
`audiostart` had completed, so the short test sound ended before ScreenCaptureKit
was listening. The script now waits for the successful start reply before it
plays the tone and exits nonzero if it receives no audible samples.

Reproduce with: `python3 server/scripts/smoke-audio.py` (prints a
SOUND CAPTURED / SILENT CAPTURE verdict).

### END-TO-END VERIFIED (macOS, over the real socket)

Not just the helper: the whole host path, on this MacBook Air, against a server
started from this branch.

```
$ curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8891/audio/status
{"ok":true,"supported":true,"capturing":false,"codec":"pcm16","listeners":0}

$ node ws-audio-probe.mjs http://127.0.0.1:8891 $TOKEN 8   # POST /ws-ticket -> /ws/audio
socket open; playing test sound
control messages: []
binary frames: 378 bytes: 1455678
first header: { magic: 'a5', verFlags: 16, seq: 0, ts: 0, codec: 1, len: 3840 }
frames with nonzero PCM: 64 of 378
VERDICT: AUDIO DELIVERED OVER /ws/audio
```

378 frames in 8 s is the 20 ms cadence with no gaps; 64 of them carry the test
tone. `scripts/smoke-audio.py` agrees at the helper level (`SOUND CAPTURED`,
198 frames, 57 nonzero, contiguous seqs, timestamp step 960 everywhere).

### WRITTEN-BUT-NOT-COMPILED (Windows)

`server/native/BelayHostAudio.cs` (+ dispatch in `BelayHost.cs`, added to
`build.ps1`). No Windows machine or C# compiler exists in the environment this
was written in — it has never been compiled, let alone run. The COM interop
(IMMDeviceEnumerator/IMMDevice/IAudioClient/IAudioCaptureClient vtables, the
mix-format probe, the event-driven loopback loop, the 48 kHz linear resampler)
follows the documented recipe, but treat every line as unverified. If
`build.ps1` fails on it, the fastest rollback is removing `BelayHostAudio.cs`
from `$src` and the three `case "audio…"` lines — nothing else references it.

Two defects were found by reading it against the WASAPI contract and fixed
blind. Both are behaviours macOS does not have, so neither could have shown up
in any macOS test:

* **`audiostart` used to answer before it knew.** It slept a fixed 150 ms and
  then reported `capturing: true` unless the worker had already failed. COM
  activation routinely takes longer than that, so a PC that could not capture
  at all still answered "yes" and then delivered nothing. It now blocks on a
  `ManualResetEvent` the capture thread signals when it either reaches
  `IAudioClient.Start()` or throws (5 s ceiling), so the reply is the truth.
* **An idle render endpoint produces no packets at all** — not silence,
  *nothing*. ScreenCaptureKit keeps a continuous 20 ms cadence either way, and
  both the phone's jitter buffer and the host's new stall watchdog treat a
  multi-second gap as a fault. The loop now owns a `Stopwatch` and pads with
  real silence frames whenever packets fall behind wall time (capped at 1 s of
  catch-up), so "nothing is playing on the PC" is no longer indistinguishable
  from "capture is broken".

---

## 2a. Why a host says it cannot do audio — the four causes

"Audio unavailable" used to be one word covering four unrelated conditions with
four unrelated fixes. Whenever this feature is debugged again, identify which
one it is **first**; they are distinguishable in about ten seconds.

| Cause | How to see it | Fix |
|---|---|---|
| The host's Belay **server** predates audio | `curl -o /dev/null -w '%{http_code}' http://HOST:8787/audio/status` → **404** while `/screen/info` → 401 | Update Belay on that computer and restart it |
| The native **helper** has no audio verbs | `/audio/status` → **501**, `kind: "unsupported-helper"` | `npm run build:native` on that computer, restart |
| The OS **refused permission** | `/audio/status` → **501**, `kind: "permission"` | The pane named in the `hint` (macOS: Screen & System Audio Recording) |
| No **output device** to tap | `/audio/status` → **501**, `kind: "no-device"` | Plug in / enable a playback endpoint |

The classification is `server/src/audio-health.ts` (pure, and every branch is
asserted in `server/test/audio-health.test.ts`). It is applied by
`audio-routes.ts` to `/audio/start`, `/audio/stop`, `/audio/status` and to the
`{type:"error"}` control message on `/ws/audio`, so all four surfaces speak the
same `{error, kind, hint, detail}` shape. The phone's half is
`app/src/stream/audio-capability.ts`: it reads the HTTP status (404 is how an
out-of-date host answers, and no cooperation from that host is needed), turns it
into a sentence plus a fix, and refuses to call anything "unsupported" that was
merely unreachable.

Two further honesty mechanisms:

* **The capability probe runs before the socket.** `connectHostAudio` asks
  `GET /audio/status` first. A definite "no" is reported once and is terminal —
  a host's installed software will not change because we retried. Previously a
  host with no `/ws/audio` route failed at the WebSocket upgrade and reconnected
  forever behind "System audio connection lost", a transient-sounding message
  for a permanent, fixable condition.
* **The stall watchdog.** Both helpers emit a 20 ms frame *continuously*,
  silence included, so no frame for `AUDIO_STALL_TIMEOUT_MS` (4 s) is never
  "nothing is playing" — it is a fault. `handleAudioSocket` then asks the helper
  for its `stopReason` and forwards the real cause. Verified on this Mac by
  killing the helper mid-stream:

  ```
  {"type":"error","error":"Audio capture started but no sound is arriving from this computer.",
   "kind":"capture-stalled",
   "hint":"Check that the computer is playing to its normal speakers, then toggle host audio off and on."}
  ```

### What was actually wrong on each of the founder's two hosts (Sept 2026)

**MacBook Air — capture was never the problem; the phone's UI was.** The helper
captures correctly (evidence above), and `/audio/status` answers 200. But
`/screen/info` reports `webrtc: false` (BELAY_WEBRTC is not set), and the Stream
Settings sheet disabled its System Audio control on exactly that flag, over a
banner reading "High-performance features require WebRTC hardware encoding".
Audio has not needed BELAY_WEBRTC since commit 7eedba8 ungated the routes; the
gate was stale and made a fully working machine look incapable. The control is
no longer tied to `webrtcAvailable` — frame rate, bitrate and codec still are,
because those genuinely need it.

**Windows PC (DESKTOP-BB4FRER) — the host software is out of date.** Probed
read-only over Tailscale:

```
$ curl -o /dev/null -w '%{http_code}' http://100.82.170.69:8787/audio/status   -> 404
$ curl -o /dev/null -w '%{http_code}' http://100.82.170.69:8787/screen/info    -> 401
$ curl http://100.82.170.69:8787/health
{"ok":true,"name":"DESKTOP-BB4FRER",...,"platform":"win32",...}      # note: no "bwp" field
```

A 404 where `/screen/info` gives 401 means the route does not exist, i.e.
`registerAudioRoutes` never ran — that server still has audio behind the
`BELAY_WEBRTC` gate (or predates it entirely). The missing `bwp` key in
`/health` independently dates that build before `ef1eb99` (2026-09-07). So the
phone's `/ws/audio` upgrade is rejected at the router and no amount of client
work can produce sound there. **This is unverifiable from macOS and no claim is
made that Windows capture works** — `BelayHostAudio.cs` has still never been
compiled or run anywhere. The runbook below has the one command that settles it.

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

macOS:
1. `cd server && npm run build:native` (audio is in the default build).
2. `python3 scripts/smoke-audio.py` while music plays. Want: `SOUND CAPTURED`.
   If permission is denied, grant *Screen & System Audio Recording* and re-run.
3. Start the server, connect a WS client to `/ws/audio` (with a
   ticket, as for `/ws/screen`), assert binary frames arrive and decode via
   `decodeAudioFrame` (the app module).
4. On the phone (dev client): feed `/ws/audio` bytes into `AudioReceiver`, play
   `play` actions' PCM through expo-av / AVAudioEngine, output silence for
   `conceal`/`wait`. Listen. Measure delay (target: `targetDelayMs` + one frame).

Windows — **the one command that settles it.** In PowerShell, in the Belay
repo on the PC, with music playing:

```powershell
cd server
git pull
npm run build:native:win
node scripts\smoke-audio-win.mjs
```

Want, in order:

* `Built ...\BelayHost.exe` — proves `BelayHostAudio.cs` **compiles** (it never
  has, anywhere; see the rollback note in §2 if csc rejects it).
* `start reply: {"ok":true,"capturing":true,...}` — proves WASAPI loopback
  initialised. Anything else here is the real error text and names the fault.
* `VERDICT: SOUND CAPTURED` with a nonzero count — proves actual audio.
  `frames: N, nonzero: 0` means capture works but the mix was silent: play
  something on the PC's **default** output device and re-run.

Then `npm start` (the server) so `/audio/status` answers 200 instead of 404, and
toggle Host audio on the phone. Only then does anything on this feature apply to
that machine.

Follow-up once that passes: Win11 22H2+ per-process loopback, so notification
dings from other apps can be excluded.

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
