// Loss-lab conformance for the ABR control law (docs/PERFORMANCE-PLAN.md §5, M2).
// Deterministic, network-free: drive congestion.ts against a synthetic
// bottleneck through congestion-driven, cellular-jitter and heavy-random-loss
// profiles and assert the plan's acceptance bar — the controller CONVERGES to
// within ±15% of link capacity on congestion-driven traces and STAYS BOUNDED
// (no runaway oscillation) everywhere, including the heavy-loss traces where a
// loss-based law is honestly, provably conservative.
//
//   cd app && node --test src/stream/webrtc/loss-lab.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ABR_CONFIG } from './congestion.ts';
import {
  runTrace, tail, mean, coefficientOfVariation, maxStepRatio,
} from './loss-lab.ts';

const CAP = 8_000_000; // 8 Mbps bottleneck
const TAIL = 0.4; // the last 40% of a trace is "converged"

/** The plan's control-law step bound: a single interval can cut at most 50%
 *  (heavy multiplicative decrease) and add at most 8% (additive increase). Any
 *  step bigger than that is a runaway the law does not permit. */
const MAX_ALLOWED_STEP = 0.5 + 1e-9;

function tailStats(result, capacityIndex = result.capacities.length - 1) {
  const capacity = result.capacities[capacityIndex];
  const tb = tail(result.bitrates, TAIL);
  return {
    capacity,
    meanFraction: mean(tb) / capacity,
    minFraction: Math.min(...tb) / capacity,
    maxFraction: Math.max(...tb) / capacity,
    cov: coefficientOfVariation(tb),
  };
}

test('congestion-driven trace: converges to within ±15% of capacity, no runaway', () => {
  const result = runTrace(
    { capacityBps: CAP, baseRttMs: 20, jitterMs: 5, backgroundLoss: 0.01 },
    { intervals: 300, startBps: 1_000_000, seed: 7 },
  );
  const s = tailStats(result);

  // Converged near capacity: the ±15% acceptance bar.
  assert.ok(s.meanFraction >= 0.85 && s.meanFraction <= 1.15,
    `tail mean ${(s.meanFraction * 100).toFixed(1)}% of capacity is outside ±15%`);
  // Every converged sample is bounded — the sawtooth never runs away.
  assert.ok(s.minFraction >= 0.75, `tail dipped to ${(s.minFraction * 100).toFixed(0)}%`);
  assert.ok(s.maxFraction <= 1.25, `tail spiked to ${(s.maxFraction * 100).toFixed(0)}%`);
  // The band is tight: this is convergence, not oscillation.
  assert.ok(s.cov < 0.12, `coefficient of variation ${s.cov.toFixed(3)} too high (oscillating)`);
  // No single interval exceeded the control law's step bound.
  assert.ok(maxStepRatio(result.bitrates) <= MAX_ALLOWED_STEP);

  // The operating-point loss is the plan's 1–5% band, not a collapse or a flood.
  const tailLoss = mean(tail(result.feedback.map((f) => f.lossRatio), TAIL));
  assert.ok(tailLoss > 0 && tailLoss < 0.06, `tail loss ${(tailLoss * 100).toFixed(2)}% off-band`);
});

test('cellular jitter (30–80ms) does not derail convergence or cause a runaway', () => {
  const result = runTrace(
    { capacityBps: CAP, baseRttMs: 40, jitterMs: 80, backgroundLoss: 0.01 },
    { intervals: 500, startBps: 1_000_000, seed: 7 },
  );
  const s = tailStats(result);
  assert.ok(s.meanFraction >= 0.85 && s.meanFraction <= 1.15,
    `tail mean ${(s.meanFraction * 100).toFixed(1)}% outside ±15% under jitter`);
  assert.ok(s.cov < 0.12, `jitter drove CoV to ${s.cov.toFixed(3)}`);
  assert.ok(s.minFraction >= 0.75 && s.maxFraction <= 1.25);
  assert.ok(maxStepRatio(result.bitrates) <= MAX_ALLOWED_STEP);
});

test('starting far ABOVE capacity, the controller backs off and converges', () => {
  const result = runTrace(
    { capacityBps: CAP, baseRttMs: 20, jitterMs: 5, backgroundLoss: 0.01 },
    { intervals: 300, startBps: 18_000_000, seed: 7 }, // ~2.25x capacity
  );
  const s = tailStats(result);
  assert.ok(s.meanFraction >= 0.85 && s.meanFraction <= 1.15,
    `did not converge after overshoot: ${(s.meanFraction * 100).toFixed(1)}%`);
  // It must actually have come DOWN from the start.
  assert.ok(result.finalState.bitrateBps < 18_000_000);
});

test('a capacity step-down is tracked: the controller re-converges to the new capacity', () => {
  const stepAt = 250;
  const result = runTrace(
    { capacityBps: (i) => (i < stepAt ? CAP : CAP / 2), baseRttMs: 20, jitterMs: 5, backgroundLoss: 0.01 },
    { intervals: 500, startBps: 1_000_000, seed: 7 },
  );
  // Analyse only the post-step tail against the reduced capacity.
  const s = tailStats(result); // final capacity is CAP/2
  assert.equal(s.capacity, CAP / 2);
  assert.ok(s.meanFraction >= 0.85 && s.meanFraction <= 1.15,
    `did not re-converge to the halved capacity: ${(s.meanFraction * 100).toFixed(1)}%`);
  // The post-step tail itself is stable (no runaway after the shock).
  assert.ok(maxStepRatio(tail(result.bitrates, 0.3)) <= MAX_ALLOWED_STEP);
});

test('heavy random loss (5%): stays bounded and conservative, never runs away', () => {
  // Persistent 5% wireless loss is above the loss floor, so a loss-based law
  // MUST back off and operate below capacity — this asserts the honest
  // limitation (§6) is a stable, bounded floor, not a collapse or an oscillation.
  const result = runTrace(
    { capacityBps: CAP, baseRttMs: 40, jitterMs: 80, backgroundLoss: 0.05 },
    { intervals: 500, startBps: 1_000_000, seed: 7 },
  );
  const tb = tail(result.bitrates, TAIL);
  // Never exceeds capacity (safe) and never drops below the configured floor.
  assert.ok(Math.max(...tb) <= CAP, 'exceeded capacity under heavy loss');
  assert.ok(Math.min(...tb) >= DEFAULT_ABR_CONFIG.minBps, 'fell below the min bitrate floor');
  // Bounded oscillation — the amplitude does not grow without limit.
  assert.ok(coefficientOfVariation(tb) < 0.3, 'heavy-loss operating point is oscillating');
  assert.ok(maxStepRatio(result.bitrates) <= MAX_ALLOWED_STEP);
});

test('the setpoint is always clamped inside [min, max] across every profile', () => {
  const profiles = [
    { capacityBps: CAP, baseRttMs: 20, jitterMs: 5, backgroundLoss: 0.01 },
    { capacityBps: CAP, baseRttMs: 40, jitterMs: 80, backgroundLoss: 0.03 },
    { capacityBps: CAP, baseRttMs: 40, jitterMs: 80, backgroundLoss: 0.05 },
  ];
  for (const profile of profiles) {
    const result = runTrace(profile, { intervals: 400, startBps: 500_000, seed: 3 });
    for (const b of result.bitrates) {
      assert.ok(b >= DEFAULT_ABR_CONFIG.minBps && b <= DEFAULT_ABR_CONFIG.maxBps,
        `setpoint ${b} left the clamp band`);
    }
  }
});

test('the lab is deterministic: same seed, identical trace', () => {
  const profile = { capacityBps: CAP, baseRttMs: 40, jitterMs: 80, backgroundLoss: 0.03 };
  const opts = { intervals: 200, startBps: 1_000_000, seed: 42 };
  const a = runTrace(profile, opts);
  const b = runTrace(profile, opts);
  assert.deepEqual(a.bitrates, b.bitrates);
  // A different seed produces a different trace (the RNG is actually wired in).
  const c = runTrace(profile, { ...opts, seed: 43 });
  assert.notDeepEqual(a.bitrates, c.bitrates);
});
