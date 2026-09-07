# Negotiated parity experiment

Status: implementation under evaluation, opt-in via streamer configuration
`"fec": true`; omitted configuration keeps the existing transport behavior.
The probe explicitly enables it unless `--no-fec` is passed. This is not yet a
verified game-streaming quality win.

The sender negotiates encrypted `FEC?` / `FEC!` control messages before marking
video shards for XOR repair. Groups contain at most eight 1120-byte shards.
Parity is authenticated and paced within the wire budget. The encoder receives
a reduced picture budget to reserve repair overhead. Unextended peers continue
receiving ordinary video. One lost shard per group is repairable; two missing
shards in the same group are not.

September 7, 2026: rebuilt release streamer and receiver on RTX 2070 SUPER,
synthetic 1080p source, 15 seconds, seeded network proxy with 20–25 ms delay
in each direction and independent 1% configured loss for video AND parity.

| Measurement | Parity enabled | Disabled |
| --- | ---: | ---: |
| Delivered frames | 805 | 790 |
| Keyframes | 6 | 16 |
| P95 arrival gap | 28.27 ms | 24.12 ms |
| Maximum arrival gap | 107.96 ms | 240.62 ms |
| Host-to-client wire bytes | 4,290,521 | 2,123,547 |
| Video packets | 3,124 | 2,099 |
| Parity packets | 963 | 0 |
| Dropped media packets | 39 | 14 |

The longest stall improved in this pair, but P95 spacing worsened and total
traffic roughly doubled. Encoded output also differed substantially, so this
does not isolate parity overhead or establish equal visual quality. The same
seed does not produce an identical packet-loss trace when packet counts differ.
Startup pacing was slower with parity. Do not claim a general performance win
or Parsec-equivalent quality from these measurements.

Validation so far: 59 wire tests; 37 network tests plus one doctest. New session
tests exercise authenticated packet loss, parity-first ordering, repeated packet
delivery, an unsolicited capability acknowledgement, and a capability-disabled
peer. Both release binaries build.

Before choosing the shipping default: investigate startup picture-budget/pacer
behavior; repeat trials; exercise burst loss and parity loss; verify UI decoding
and installed receiver; measure quality and real-game latency separately.

Follow-up: bitrate update failures are now surfaced rather than silently ignored.
The encoder updates its recorded bitrate only after the codec API accepts it.
A second parity trial delivered 852 frames, five keyframes, P95 spacing 24.60 ms,
maximum gap 69.69 ms and 4,020,621 wire bytes. All 204 bitrate updates were accepted.
That rules out rejected API calls in this trial, but does not prove exact bitrate
compliance or visual quality. Variation reinforces the need for repeated trials.

Network tests now total 38 plus one doctest. They additionally verify that two
missing shards, or a missing shard plus lost parity, suppress dependent frames
until a complete keyframe arrives. An existing UDP test's ephemeral-port reuse
race was fixed after it failed with Windows address-in-use during parallel tests.
The encoder's 18 ordinary tests pass; two hardware tests were not rerun in this
check (the real GPU streaming probe above exercises actual hardware encoding).

Astra integration review identified a reorder limitation: if a newer
frame completes before an older frame's parity arrives, the existing newest-frame
reassembler discards the older frame. This triggers keyframe recovery even when
late parity could otherwise repair it. A bounded reorder policy needs evaluation
before claiming robust FEC under jitter. The implementation now separates video
reassembly completion from delivery: a negotiated receiver holds at most three
completed dependent frames for an 8 ms grace period, checked during polling.
Normal in-order frames are delivered immediately. A regression feeds a newer
complete frame before the older frame's parity and verifies ordered delivery
of both; an unrecoverable gap expires into keyframe recovery. Network tests total
39 plus one doctest after this change. Real-network timing still needs retesting.

The review also found that at a 300 kbps wire budget an eight-shard group takes
about 239 ms to serialize, longer than the fixed 200 ms repair-cache lifetime.
Low-rate repair policy needs adjustment and deterministic timing tests. The
budget formula is conservative, but its fixed tail reserve reduces a 1.5 Mbps
wire budget to approximately 803 kbps for pictures at 60 FPS.

Cache timing fix: groups now expire after 200 ms without new valid data/parity,
with a two-second hard frame lifetime. Duplicates cannot refresh the deadline;
expired payloads are freed and bounded tombstones prevent late restarts. A
deterministic 300 kbps serialization test repairs a lost shard at 248 ms and
completes real reassembly. The wire suite passes 63 tests, including 11 FEC tests.

Combined timing-fix GPU trial: 764 frames/15 seconds, five keyframes, P95 arrival
gap 32.78 ms, maximum gap 78.50 ms, 5,407,887 wire bytes, 49 dropped packets out of
4,050 video plus 1,021 parity packets. All 243 codec bitrate updates were accepted.
Host FPS temporarily fell to 25.7 while average send time reached 30.8 ms.
This demonstrates a remaining encoder-output/pacer mismatch under the changing
budget. Cache correctness fixes do not establish sustained 60 FPS. Keep parity
opt-in while investigating that mismatch; do not promote this trial as a win.

Isolation run with the same jitter but zero configured loss: 864 frames/15 s,
five keyframes, 4,150,513 wire bytes, and zero dropped packets. The wire budget
still fell from 20 Mbps to 16.66 Mbps while RTT stayed around 50 ms, below the
gradient guard. Astra reproduced the cause deterministically: 10,000 delivered
packets with 20–25 ms jitter generated 54 false-loss reports and 20 bitrate
decreases. Arrival counts and sequence spans crossed report boundaries at
different times. Loss settlement is being corrected independently of parity.

Additional compatibility checks pass for lost capability requests and replies,
and a legacy 1216-byte encrypted datagram. The Electron playtest passes pairing,
actual H.264 presentation, gaming/rapid toggles, compact layout and keyboard
activation, with 46 simulated controller frames. This does not test physical
controller injection or a Mac/phone connection.

Checkpoint before approval-setting change: loss accounting now finalizes gaps
after a 10 ms observation grace, with at most 4096 sequence slots. The deterministic
10,000-packet zero-loss test now produces zero false-loss reports or bitrate cuts.
RTT still follows the newest actual packet; the 20-byte report layout is unchanged.
Session passes monotonic 64-bit elapsed time for local settlement so the 32-bit
wire clock wrapping after about 71 minutes cannot stall accounting.

The rebuilt zero-loss GPU run delivered 870 frames/15 seconds, five keyframes,
P95 gap 23.88 ms, maximum gap 68.31 ms and 3,201,568 wire bytes. It still showed
occasional bitrate decreases despite zero proxy drops. The deterministic bug is
fixed, but OS scheduling, socket/replay drops or reordering beyond the grace
remain to be distinguished with additional telemetry. Do not claim all false
congestion is resolved. The monotonic-clock call-site change was made after this
short run and is covered by the subsequent compile/test checkpoint.

Work is intentionally paused at the user's request. Changes remain uncommitted;
the installed receiver has not been refreshed with these experimental changes.
Next steps: inspect remaining feedback backoffs, repeat comparable loss trials,
review/update protocol report semantics, then commit/push and refresh installation
after validation. Physical controller and Mac/phone end-to-end checks remain open.

Resumed after the approval setting changed. Proxy instrumentation measured timer
lateness up to 12.18 ms in addition to configured 5 ms jitter, exceeding the
initial 10 ms accounting grace. Increased only loss settlement to 25 ms; actual
video delivery is unchanged. Updated deterministic coverage includes 17 ms of
combined network/scheduler variation and still requires zero spurious backoffs.

The subsequent zero-loss GPU run delivered 869 frames/15 s with five keyframes,
3,121,710 wire bytes and P95 arrival gap 23.59 ms. After startup the reported
wire budget stayed at 20 Mbps for every stats sample; only 35 bitrate updates
were emitted, consistent with startup probing rather than repeated reductions.
Timer lateness reached 12.05 ms. This is evidence for this scheduling profile,
not a guarantee against arbitrary jitter. Loss-profile and equal-quality
comparisons still determine whether parity should become the default.

Installed-app validation after commit a280d2f: refreshed the per-user Belay
installation with the rebuilt receiver. The installed executable passed pairing,
H.264 presentation, gaming and rapid toggles, compact layout, keyboard activation
and 48 simulated controller frames. No physical controller or remote Mac was
involved. This updates the earlier installation checkpoint above.

Post-feedback-fix 1% loss comparison (same seed42 model, 15 seconds each):

| Measurement | Parity enabled | Disabled |
| --- | ---: | ---: |
| Delivered frames | 862 | 712 |
| Keyframes | 5 | 20 |
| P95 arrival gap | 24.17 ms | 24.35 ms |
| Maximum arrival gap | 68.24 ms | 426.73 ms |
| Wire bytes | 3,178,557 | 2,289,010 |
| Dropped media packets | 28 / 3185 | 22 / 2226 |

Repair improved delivery in this pair at approximately 39% more total traffic.
It remains opt-in: packet layouts and encoder budgets differ, so equal visual
quality and performance across network conditions are not established. The
feedback correction is enabled for ordinary sessions independently of parity.

Full-screen motion stress source: `--motion` selects `synthetic-motion`, a fixed
detailed world scrolling seven pixels horizontally and three vertically per
frame. It is deliberately harder than the mostly static default scene; it is
not representative game footage or a visual-quality metric. CPU pattern
generation is included in `captureMs` (about 4.7 ms on this machine).

First clean-loopback motion run, parity disabled: 204 frames/8 seconds, three
keyframes, 12,618,879 encoded bytes, steady 28–33 FPS. Encoder observed output
P95 was approximately 7 ms, but synchronous sending occupied 16–22 ms per
sample at the 20 Mbps wire cap. First-second average send time was 491 ms.
This exposes a capture/encode/send scheduling bottleneck hidden by the simpler
scene. The near-60 FPS simple-scene results cannot establish gaming performance.

Encoder isolation probe (`cargo run --release --bin encode_rate_probe`) submits
180 motion frames at 60 FPS per phase without network pacing. A 20 Mbps target
produced 10,174,685 bytes (27.13 Mbps at 60 FPS), then an 8 Mbps target produced
11,948,001 bytes (31.86 Mbps). All frames drained in about three seconds per
phase. Codec readback reported CBR mode and the requested bitrate in both cases.
Thus property acceptance/readback does not prove output budget compliance.
Moving configuration before media-type setup produced identical encoded totals;
that speculative change was reverted. Longer steady-state measurements and
hardware-specific rate-control behavior remain to investigate.

Longer isolation: a fresh 8 Mbps encoder produced 37,651,302 bytes over 600 frames
in ten seconds (30.12 Mbps at 60 FPS). The selected backend is now identified
explicitly as `NVIDIA H.264 Encoder MFT`. Readback reports minQP 0, maxQP 51,
bufferSize 21993846 and quality 65. A diagnostic request to set buffer size 133333
returned success but readback remained 21993846; no production buffer tuning was
enabled. Units vary by codec, so that experiment does not establish a usable
VBV configuration.

Initial dedicated-sender trial: 226 motion frames/8 seconds versus 204 for the
serialized loop. Steady FPS was 30–38, with average queue wait 8–14 ms in most
intervals. Two total pipeline credits bound encoder submissions plus pending
and active sends; capture skips before encoding when both are occupied.
No arbitrary encoded delta dropping is used. This is a modest throughput gain,
not 60 FPS, and rate-control compliance remains necessary to avoid queue latency.

Sender validation: 17 streamer tests pass, including the two-credit bound,
ordered delivery, latest-cursor mailbox, coalesced feedback, failure/panic
propagation, cancellation, and a two-second deadline on each encoder submission.
Session cancellation is checked during packet pacing and receive draining;
47 network tests plus one doctest pass. The encoder's 18 ordinary tests pass
(two separate hardware tests were not rerun in this check). The rebuilt streamer
also passed the desktop UI test with actual H.264 presentation and 47 simulated
controller frames. Cursor updates are prioritized between access units; they
still cannot interrupt an active access-unit send, a remaining limitation.

## Direct NVENC checkpoint

An independently implemented C++ bridge with Rust ownership can now be selected
with startup `encoder: "nvenc"`. Ordinary sessions still select Media Foundation.
The bridge loads the installed NVIDIA driver from System32 and requires NVENC
API 13.0. It owns GPU input snapshots, limits outstanding submissions to two,
polls completion without waiting, and supports forced IDRs and rate changes.
The vendored API header retains NVIDIA's MIT license; no SDK sample code or
driver binary is bundled. Building on Windows requires the MSVC C++ toolchain.

On this RTX 2070 SUPER, the direct P1 single-pass path delivered 366 motion frames
in eight seconds, versus the prior MFT sender-worker result of 226. The direct
run transmitted 13,654,229 encoded bytes; steady intervals ranged from 48 to
60 FPS, with output p95 about 5.3–6.5 ms. Startup remained slow (four frames in
the first reporting interval), and maximum arrival gap was 296 ms. These are
individual synthetic measurements, not a claim of stable 60 FPS gaming.

The 8 Mbps encoder-only test still exceeded its target. Diagnostic output showed
average QP near 49–51 with no enabled min/max QP clamps. P4 and quarter-resolution
two-pass trials did not reduce output enough and increased encoding latency;
they were reverted. The measurements support quantizer saturation on this stress
source, rather than proving NVENC ignored bitrate updates. Source content changes
between phases, so the 20-to-8 Mbps totals alone cannot prove rate-control failure.
See [the native measurement table](../crates/belay-nvenc/vendor/README.md).

Validation: 17 streamer tests and 18 ordinary encoder tests pass. An opt-in
hardware lifecycle regression passes repeated creation, independent output,
timestamps, forced IDR after rate change, two-frame backpressure, and teardown
with pending work followed by successful recreation. Electron's NVENC playtest
passes actual H.264 decoding/presentation, pairing, gaming and rapid toggles,
compact layout and keyboard activation, with 47 simulated controller messages.
The compact screenshot was visually inspected. The playtest now resolves paths
from its own file and works from the repository root as well as `tests/`.

Reproduce:

```powershell
# From crates/belay-stream:
cargo run --release --bin encode_rate_probe -- --nvenc --initial-rate=8000000 --frames=600
# From crates/belay-encode:
cargo test --lib nvenc_lifecycle_preserves_timestamps_and_forced_idr -- --ignored --test-threads=1
# From the repository root, after building the release streamer:
node scripts/probe-desktop-video.mjs --motion --no-fec --nvenc
$env:BELAY_TEST_ENCODER='nvenc'
node tests/desktop-playtest.mjs
```

Equal-quality comparisons, bandwidth-driven resolution changes, representative
game footage, remote Mac/phone decoding, and physical controller acceptance
remain open. This checkpoint does not switch production sessions to NVENC.
