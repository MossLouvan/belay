// Glass-to-glass latency math: clock-offset cancellation, percentile window,
// and drop accounting.
//
//   cd app && node --test src/stream/webrtc/latency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateClockOffset, glassToGlassMs, LatencyWindow } from './latency.ts';

test('glass-to-glass subtracts the clock offset between the two devices', () => {
  // Host captured at host-ms 1000; client presented at client-ms 5040; the
  // client clock runs 4000ms ahead → true latency is 40ms.
  const frame = { captureHostMs: 1000, presentClientMs: 5040, seq: 1 };
  assert.equal(glassToGlassMs(frame, 4000), 40);
});

test('clock offset is (client - host) and cancels a symmetric delay', () => {
  // client clock = host + 100. One-way delay 10ms each way.
  // t0 client-send=0, t1 host-recv=(0+10)-100=-90, t2 host-reply=-90, t3 client-recv=0+20=20
  const { offsetMs, rttMs } = estimateClockOffset(0, -90, -90, 20);
  assert.equal(offsetMs, 100, 'client runs 100ms ahead of the host');
  assert.equal(rttMs, 20, 'RTT is the round trip minus host processing');
});

test('estimateClockOffset feeds glassToGlassMs correctly (composition)', () => {
  // The bug the board caught: each function was right alone but composed with
  // an inverted sign. This pins the two together.
  // client = host + 250. A frame captured at host-ms 1000, one-way delay 15ms,
  // is presented at client-ms (1000 + 15) + 250 = 1265 -> true latency 15ms.
  const { offsetMs } = estimateClockOffset(0, -235, -235, 30); // client +250, RTT 30
  assert.equal(offsetMs, 250);
  const latency = glassToGlassMs({ captureHostMs: 1000, presentClientMs: 1265, seq: 1 }, offsetMs);
  assert.equal(latency, 15, 'composed latency is the true one-way present delay');
});

test('window reports percentiles, not a mean that hides spikes', () => {
  const w = new LatencyWindow(100);
  // 19 frames at 30ms, one at 300ms. Mean would be ~43; p50 must stay 30.
  for (let seq = 1; seq <= 19; seq += 1) {
    w.add({ captureHostMs: 0, presentClientMs: 30, seq }, 0);
  }
  w.add({ captureHostMs: 0, presentClientMs: 300, seq: 20 }, 0);
  // Mean would be ~43.5; the median is unmoved by the spike, and the spike
  // itself surfaces at the top of the distribution rather than being averaged away.
  assert.equal(w.percentile(0.5), 30, 'median unmoved by one spike');
  assert.equal(w.percentile(1), 300, 'the spike surfaces at the top percentile');
});

test('window is bounded and evicts oldest', () => {
  const w = new LatencyWindow(3);
  for (let seq = 1; seq <= 5; seq += 1) {
    w.add({ captureHostMs: 0, presentClientMs: seq, seq }, 0);
  }
  assert.equal(w.count, 3);
  // Only seq 3,4,5 (values 3,4,5) remain.
  assert.equal(w.percentile(0), 3);
  assert.equal(w.percentile(1), 5);
});

test('drop accounting counts gaps in the sequence, once', () => {
  const w = new LatencyWindow(100);
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: 1 }, 0);
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: 4 }, 0); // skipped 2,3
  assert.equal(w.dropped, 2);
  // A late frame (seq 3) does not un-drop the visible gap.
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: 3 }, 0);
  assert.equal(w.dropped, 2);
});

test('empty window yields null percentiles, not NaN', () => {
  const w = new LatencyWindow(10);
  assert.equal(w.percentile(0.5), null);
  assert.deepEqual(w.snapshot(), { count: 0, dropped: 0, p50: null, p95: null, p99: null });
});

test('rejects a non-positive capacity instead of misbehaving later', () => {
  assert.throws(() => new LatencyWindow(0), RangeError);
});

test('ignores frames with a bogus seq or non-finite timing (boundary guard)', () => {
  const w = new LatencyWindow(10);
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: 1 }, 0);
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: NaN }, 0);
  w.add({ captureHostMs: 0, presentClientMs: 10, seq: -3 }, 0);
  w.add({ captureHostMs: NaN, presentClientMs: 10, seq: 2 }, 0);
  assert.equal(w.count, 1, 'only the one valid frame is recorded');
  assert.equal(w.dropped, 0, 'garbage never poisons drop accounting');
});
