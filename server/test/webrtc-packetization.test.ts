// RTP packetization math: the tested reference for the native transport's
// fragment budget, timestamp mapping and pacing model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RTP_VIDEO_CLOCK_HZ,
  MAX_RTP_PAYLOAD_BYTES,
  FU_OVERHEAD_BYTES,
  RTP_HEADER_BYTES,
  ptsMsToRtpTimestamp,
  packetsForNal,
  costOfAccessUnit,
  paceSchedule,
  frameBudget,
} from '../src/webrtc/packetization.js';

test('constants match the native transport (belay_transport.cpp)', () => {
  // BELAY_MAX_FRAGMENT_SIZE = 1188 — if either side changes, both must.
  assert.equal(MAX_RTP_PAYLOAD_BYTES, 1188);
  assert.equal(RTP_VIDEO_CLOCK_HZ, 90_000);
});

test('ptsMsToRtpTimestamp: 90 kHz mapping, anchored, wraps at 2^32', () => {
  assert.equal(ptsMsToRtpTimestamp(1000, 0), 90_000);
  assert.equal(ptsMsToRtpTimestamp(1016.6667, 1000), 1500); // one 60fps frame
  assert.equal(ptsMsToRtpTimestamp(500, 500, 12345), 12345); // base maps to start
  // Wraps modulo 2^32 like the wire field.
  const nearWrap = ptsMsToRtpTimestamp(1000, 0, 0xffffffff - 45_000);
  assert.equal(nearWrap, 45_000 - 1);
  assert.throws(() => ptsMsToRtpTimestamp(0, 1000), RangeError); // pts before base
  assert.throws(() => ptsMsToRtpTimestamp(Number.NaN, 0), RangeError);
});

test('packetsForNal: single-packet vs fragmented, per-codec overhead', () => {
  assert.equal(packetsForNal(1, 'h264'), 1);
  assert.equal(packetsForNal(MAX_RTP_PAYLOAD_BYTES, 'h264'), 1);
  // One byte over the budget fragments, and each fragment loses FU overhead.
  const perFragH264 = MAX_RTP_PAYLOAD_BYTES - FU_OVERHEAD_BYTES.h264;
  assert.equal(packetsForNal(MAX_RTP_PAYLOAD_BYTES + 1, 'h264'), Math.ceil((MAX_RTP_PAYLOAD_BYTES + 1) / perFragH264));
  // HEVC pays one more byte per fragment.
  const big = 100_000;
  assert.ok(packetsForNal(big, 'hevc') >= packetsForNal(big, 'h264'));
  assert.throws(() => packetsForNal(0, 'h264'), RangeError);
  assert.throws(() => packetsForNal(10, 'h264', FU_OVERHEAD_BYTES.h264), RangeError);
});

test('costOfAccessUnit sums packets and wire bytes', () => {
  // Two small NALs: 2 packets, no FU overhead, 2 RTP headers.
  const small = costOfAccessUnit([100, 200], 'h264');
  assert.equal(small.packets, 2);
  assert.equal(small.wireBytes, 300 + 2 * RTP_HEADER_BYTES);

  // A 30 KB IDR slice fragments; wire bytes include per-fragment overhead.
  const idr = costOfAccessUnit([30_000], 'h264');
  const perFrag = MAX_RTP_PAYLOAD_BYTES - FU_OVERHEAD_BYTES.h264;
  const frags = Math.ceil(30_000 / perFrag);
  assert.equal(idr.packets, frags);
  assert.equal(idr.wireBytes, 30_000 + frags * FU_OVERHEAD_BYTES.h264 + frags * RTP_HEADER_BYTES);

  assert.throws(() => costOfAccessUnit([], 'h264'), RangeError);
});

test('paceSchedule spreads packets over a bounded slice of the interval', () => {
  assert.deepEqual(paceSchedule(1, 16.667), [0]);
  const offsets = paceSchedule(5, 16.667); // default 50% spread
  assert.equal(offsets.length, 5);
  assert.equal(offsets[0], 0);
  // Monotonic and within the spread window.
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1]);
  assert.ok(offsets[offsets.length - 1] <= 16.667 * 0.5 + 1e-9);
  assert.throws(() => paceSchedule(0, 16.667), RangeError);
  assert.throws(() => paceSchedule(3, -1), RangeError);
  assert.throws(() => paceSchedule(3, 16.667, 1.5), RangeError);
});

test('frameBudget ties the ABR setpoint to per-frame wire pressure', () => {
  // 6 Mbps at 60 fps = 12.5 KB/frame ≈ 11 packets.
  const b = frameBudget(6_000_000, 60);
  assert.equal(b.bytesPerFrame, 12_500);
  assert.equal(b.packetsPerFrame, Math.ceil(12_500 / MAX_RTP_PAYLOAD_BYTES));
  // A starved link still sends at least one packet per frame.
  assert.equal(frameBudget(50_000, 60).packetsPerFrame, 1);
  assert.throws(() => frameBudget(0, 60), RangeError);
  assert.throws(() => frameBudget(1000, 0), RangeError);
});
