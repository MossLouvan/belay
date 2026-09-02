// Adaptive-bitrate control law — the loss-lab-facing tests (PERFORMANCE-PLAN §5).
//
//   cd app && node --test src/stream/webrtc/congestion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ABR_CONFIG,
  initialAbrState,
  nextAbrState,
} from './congestion.ts';

const cfg = DEFAULT_ABR_CONFIG;

test('initial state clamps the start bitrate into the band', () => {
  assert.equal(initialAbrState(50).bitrateBps, cfg.minBps);
  assert.equal(initialAbrState(1e12).bitrateBps, cfg.maxBps);
  assert.equal(initialAbrState(5_000_000).bitrateBps, 5_000_000);
});

test('clean link with drained queue increases additively', () => {
  const s0 = initialAbrState(5_000_000);
  // First interval establishes the base RTT; nothing is "climbing" yet.
  const s1 = nextAbrState(s0, { lossRatio: 0, rttMs: 20 }, cfg);
  assert.ok(s1.bitrateBps > s0.bitrateBps, 'should probe upward when clean');
  assert.equal(s1.bitrateBps, Math.round(5_000_000 * 1.08));
  assert.equal(s1.baseRttMs, 20);
});

test('heavy loss cuts hard, proportional to severity', () => {
  const s0 = initialAbrState(5_000_000);
  const mild = nextAbrState(s0, { lossRatio: 0.1, rttMs: 20 }, cfg); // at ceiling
  const severe = nextAbrState(s0, { lossRatio: 0.4, rttMs: 20 }, cfg);
  assert.equal(mild.bitrateBps, Math.round(5_000_000 * 0.9));
  assert.equal(severe.bitrateBps, Math.round(5_000_000 * 0.6));
  assert.ok(severe.bitrateBps < mild.bitrateBps, 'worse loss cuts more');
});

test('moderate loss applies a mild fixed backoff', () => {
  const s0 = initialAbrState(4_000_000);
  const s1 = nextAbrState(s0, { lossRatio: 0.05, rttMs: 20 }, cfg);
  assert.equal(s1.bitrateBps, Math.round(4_000_000 * 0.85));
});

test('RTT climbing above the floor holds instead of increasing', () => {
  let s = initialAbrState(4_000_000);
  s = nextAbrState(s, { lossRatio: 0, rttMs: 20 }, cfg); // base RTT = 20ms, increased
  const held = nextAbrState(s, { lossRatio: 0, rttMs: 120 }, cfg); // queue building
  assert.equal(held.bitrateBps, s.bitrateBps, 'a building queue must not push harder');
  assert.equal(held.baseRttMs, 20, 'base RTT is the running minimum');
});

test('malformed feedback is ignored, never corrupts the setpoint', () => {
  const s0 = initialAbrState(3_000_000);
  for (const bad of [
    { lossRatio: NaN, rttMs: 20 },
    { lossRatio: -0.1, rttMs: 20 },
    { lossRatio: 0.01, rttMs: 0 },
    { lossRatio: 0.01, rttMs: -5 },
    { lossRatio: 0.01, rttMs: Infinity },
  ]) {
    assert.deepEqual(nextAbrState(s0, bad, cfg), s0);
  }
});

test('bitrate never leaves the configured band under sustained loss', () => {
  let s = initialAbrState(1_000_000);
  for (let i = 0; i < 200; i++) {
    s = nextAbrState(s, { lossRatio: 0.5, rttMs: 200 }, cfg);
    assert.ok(s.bitrateBps >= cfg.minBps, 'floor holds');
    assert.ok(s.bitrateBps <= cfg.maxBps, 'ceiling holds');
  }
  assert.equal(s.bitrateBps, cfg.minBps, 'sustained heavy loss pins to the floor');
});

// The loss-lab convergence assertion (M2): under a steady low-loss link the
// controller must settle near a capacity, not oscillate unboundedly. We model a
// link whose "capacity" produces 3% loss above it and 0% below, and check the
// setpoint stabilises into a bounded band rather than diverging.
test('converges into a bounded band on a 1-5% loss link, no runaway oscillation', () => {
  const capacityBps = 6_000_000;
  let s = initialAbrState(1_000_000);
  const tail = [];
  for (let i = 0; i < 400; i++) {
    const over = s.bitrateBps > capacityBps;
    const lossRatio = over ? 0.03 : 0; // moderate loss when over capacity
    const rttMs = over ? 90 : 25; // queue swells over capacity
    s = nextAbrState(s, { lossRatio, rttMs }, cfg);
    if (i >= 380) tail.push(s.bitrateBps);
  }
  const min = Math.min(...tail);
  const max = Math.max(...tail);
  // Settles in the neighbourhood of capacity...
  assert.ok(max <= capacityBps * 1.2, `max ${max} should stay near capacity`);
  assert.ok(min >= capacityBps * 0.6, `min ${min} should not collapse`);
  // ...and the steady-state swing is bounded (no divergence).
  assert.ok((max - min) / capacityBps < 0.4, 'steady-state oscillation is bounded');
});
