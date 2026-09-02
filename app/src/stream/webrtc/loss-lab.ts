// A deterministic loss-lab for the ABR control law (docs/PERFORMANCE-PLAN.md §5,
// M2). It is a pure, network-free simulator: a synthetic bottleneck link whose
// loss and RTT are a function of how hard the sender is pushing it, driven by a
// seeded PRNG so every trace is byte-for-byte reproducible. It exists to answer
// the one question that is pure risk and needs no GPU — does congestion.ts
// converge near a link's capacity and stay there without oscillating out of
// control — before any encoder or transport is turned on.
//
// The link model is deliberately simple and honest about two DIFFERENT kinds of
// loss, because the control law reacts to them the same way and only one of them
// it can actually fix by slowing down:
//
//   * CONGESTION loss — caused by the sender exceeding the bottleneck. This is
//     the loss AIMD exists to control: back off and it goes away. In the model
//     it is zero below capacity and grows past it, alongside a queueing-delay
//     term so the RTT-gradient guard has something real to see.
//   * BACKGROUND loss — random wireless loss independent of rate (a lossy
//     cellular link drops packets whether you slow down or not). Slowing down
//     does NOT fix it, so a loss-based controller under heavy background loss
//     necessarily operates conservatively (below capacity). That is a real,
//     known limitation the plan calls out (§6, "GCC is conservative … we will
//     tend to under-shoot"), not a bug — so the loss-lab asserts CONVERGENCE on
//     congestion-driven traces and only STABILITY (bounded, non-oscillating) on
//     heavy-background-loss traces.

import {
  DEFAULT_ABR_CONFIG, initialAbrState, nextAbrState,
  type AbrConfig, type AbrState, type LinkFeedback,
} from './congestion.ts';

/** A small, fast, seedable PRNG (mulberry32). Deterministic across runs so a
 *  failing trace is always the same trace. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Capacity may be constant or vary per interval, so a trace can script a
 *  bandwidth step (a link that suddenly halves) and prove the controller
 *  re-converges. */
export type Capacity = number | ((intervalIndex: number) => number);

export interface LinkProfile {
  readonly capacityBps: Capacity;
  /** Empty-queue round-trip time, ms. */
  readonly baseRttMs: number;
  /** Peak additive RTT noise per interval, ms (0 = none). Cellular jitter. */
  readonly jitterMs: number;
  /** Peak random background loss per interval, 0..1 (0 = a clean link). */
  readonly backgroundLoss: number;
}

export interface TraceOptions {
  readonly intervals: number;
  readonly startBps: number;
  readonly config?: AbrConfig;
  readonly seed?: number;
}

export interface TraceResult {
  /** The setpoint the controller chose after each interval's feedback. */
  readonly bitrates: readonly number[];
  /** The link report the controller saw each interval. */
  readonly feedback: readonly LinkFeedback[];
  /** Capacity at each interval (so a stepped trace can be analysed per-phase). */
  readonly capacities: readonly number[];
  readonly finalState: AbrState;
}

function capacityAt(capacity: Capacity, i: number): number {
  return typeof capacity === 'function' ? capacity(i) : capacity;
}

/**
 * The bottleneck's response to one interval of sending at `bitrateBps`. Pure
 * given the RNG draw. Loss is congestion loss (from overshoot) plus a random
 * background draw; RTT is the base plus jitter plus a queueing term that grows
 * once the sender is over capacity.
 */
export function linkFeedback(
  bitrateBps: number,
  capacityBps: number,
  profile: LinkProfile,
  rng: () => number,
): LinkFeedback {
  const over = bitrateBps / capacityBps;
  // Congestion loss: none below capacity; at 2x capacity it is a hard 50%.
  const congestionLoss = over <= 1 ? 0 : Math.min(0.5, over - 1);
  const background = profile.backgroundLoss > 0 ? rng() * profile.backgroundLoss : 0;
  const lossRatio = Math.min(1, congestionLoss + background);

  // Standing queue builds only past capacity; below it the link drains and the
  // gradient guard sees the floor. Jitter is bounded, rate-independent noise.
  const queueMs = over <= 1 ? 0 : (over - 1) * profile.baseRttMs * 4;
  const jitter = profile.jitterMs > 0 ? rng() * profile.jitterMs : 0;
  const rttMs = profile.baseRttMs + jitter + queueMs;

  return { lossRatio, rttMs };
}

/** Run the controller against a profile for `intervals` steps. */
export function runTrace(profile: LinkProfile, options: TraceOptions): TraceResult {
  const config = options.config ?? DEFAULT_ABR_CONFIG;
  const rng = makeRng(options.seed ?? 1);
  let state = initialAbrState(options.startBps, config);

  const bitrates: number[] = [];
  const feedback: LinkFeedback[] = [];
  const capacities: number[] = [];

  for (let i = 0; i < options.intervals; i++) {
    const capacity = capacityAt(profile.capacityBps, i);
    const fb = linkFeedback(state.bitrateBps, capacity, profile, rng);
    state = nextAbrState(state, fb, config);
    bitrates.push(state.bitrateBps);
    feedback.push(fb);
    capacities.push(capacity);
  }

  return { bitrates, feedback, capacities, finalState: state };
}

// ── analysis helpers (pure) ───────────────────────────────────────────────

/** The last `fraction` (0..1) of a series — the converged tail. */
export function tail<T>(values: readonly T[], fraction: number): T[] {
  const n = Math.max(1, Math.floor(values.length * fraction));
  return values.slice(values.length - n);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** Coefficient of variation (stdev/mean): a scale-free measure of how much the
 *  setpoint jitters. A runaway oscillation drives this up; a controller sitting
 *  in a tight band keeps it small. */
export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);
  return m === 0 ? 0 : stdev(values) / m;
}

/** The largest single-interval fractional change, |v[i+1]/v[i] - 1|. Bounds the
 *  step size so a test can prove no interval made a wild jump. */
export function maxStepRatio(values: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === 0) continue;
    max = Math.max(max, Math.abs(values[i] / values[i - 1] - 1));
  }
  return max;
}
