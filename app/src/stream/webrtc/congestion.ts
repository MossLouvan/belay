// Adaptive-bitrate control for the WebRTC video path — the pure control law.
//
// WebRTC hands the sender a loss ratio and an RTT every feedback interval; the
// encoder wants a single number back: its target AverageBitRate. This module is
// that translation and nothing else. It holds no sockets and no encoder — the
// device layer feeds it feedback and applies the returned setpoint to the
// VideoToolbox / Media Foundation session — so the control law is exercised
// under the test runner and against the loss-lab traces (docs/PERFORMANCE-PLAN.md
// §5, M2) with zero hardware.
//
// The law is loss-based AIMD with an RTT-gradient guard, the shape that behaves
// on a lossy cellular link:
//   * real loss  -> multiplicative DECREASE (back off fast, proportional to how
//     bad it is), because loss means the bottleneck is already overrun;
//   * low loss but RTT climbing above its floor -> HOLD, because a growing queue
//     is congestion arriving before loss does, and pushing harder makes the very
//     latency this product exists to minimise worse;
//   * low loss and RTT near its floor -> additive INCREASE, probing for more
//     headroom in small steps that a single overshoot can cheaply give back.
//
// Everything is immutable: `next()` returns a NEW state, never mutating the one
// passed in, so a caller can keep a history of setpoints for free.

/** One feedback interval's link report. */
export interface LinkFeedback {
  /** Fraction of packets lost this interval, 0..1. */
  readonly lossRatio: number;
  /** Smoothed round-trip time this interval, ms. */
  readonly rttMs: number;
}

/** Fixed tuning for a controller. Bitrates in bits per second. */
export interface AbrConfig {
  readonly minBps: number;
  readonly maxBps: number;
  /** Additive-increase step per interval, as a fraction of current bitrate. */
  readonly increaseFraction: number;
  /** Loss below this counts as "clean" and permits an increase. */
  readonly lossFloor: number;
  /** Loss at or above this triggers heavy multiplicative backoff. */
  readonly lossCeiling: number;
  /** RTT is "climbing" once it exceeds baseRtt * this + a small constant. */
  readonly rttGradient: number;
}

/** Evolving controller state. `baseRttMs` is the running minimum RTT — the
 *  empty-queue latency the gradient guard measures swelling against. */
export interface AbrState {
  readonly bitrateBps: number;
  readonly baseRttMs: number;
}

export const DEFAULT_ABR_CONFIG: AbrConfig = Object.freeze({
  minBps: 300_000, // 300 kbps — below this the picture is not worth sending
  maxBps: 20_000_000, // 20 Mbps — a generous ceiling for 1080p60
  increaseFraction: 0.08, // +8% per interval when clean
  lossFloor: 0.02, // <=2% loss is tolerable, keep probing up
  lossCeiling: 0.1, // >=10% loss is a real problem, cut hard
  rttGradient: 1.5, // queue is building once RTT > 1.5*base + 20ms
});

/** A fresh controller starting at `startBps`, clamped into the config band. */
export function initialAbrState(startBps: number, config: AbrConfig = DEFAULT_ABR_CONFIG): AbrState {
  return {
    bitrateBps: clamp(startBps, config.minBps, config.maxBps),
    baseRttMs: Number.POSITIVE_INFINITY,
  };
}

/**
 * Compute the next state from one feedback report. Pure: returns a new object.
 * Malformed feedback (non-finite, negative) is treated as "no information" and
 * the state is returned unchanged rather than corrupting the setpoint — the
 * same never-trust-the-producer discipline as latency.ts.
 */
export function nextAbrState(
  state: AbrState,
  feedback: LinkFeedback,
  config: AbrConfig = DEFAULT_ABR_CONFIG,
): AbrState {
  if (!Number.isFinite(feedback.lossRatio) || feedback.lossRatio < 0) return state;
  if (!Number.isFinite(feedback.rttMs) || feedback.rttMs <= 0) return state;

  const loss = Math.min(feedback.lossRatio, 1);
  const baseRttMs = Math.min(state.baseRttMs, feedback.rttMs);

  let next: number;
  if (loss >= config.lossCeiling) {
    // Heavy loss: multiplicative decrease, scaled by severity. At the ceiling
    // this is a ~-50% cut (loss>=0.1 -> factor 0.55..); worse loss cuts more.
    next = state.bitrateBps * (1 - Math.min(0.5, loss));
  } else if (loss > config.lossFloor) {
    // Moderate loss: a mild, fixed backoff — enough to relieve the link without
    // the sawtooth a full multiplicative cut would cause at low loss.
    next = state.bitrateBps * 0.85;
  } else if (rttIsClimbing(feedback.rttMs, baseRttMs, config)) {
    // Clean of loss but the queue is filling: hold, do not add to it.
    next = state.bitrateBps;
  } else {
    // Clean and drained: probe upward in a small additive step.
    next = state.bitrateBps * (1 + config.increaseFraction);
  }

  return {
    bitrateBps: clamp(Math.round(next), config.minBps, config.maxBps),
    baseRttMs,
  };
}

/** RTT is meaningfully above the empty-queue floor (queue building)? Until a
 *  base RTT is known (first interval), nothing is "climbing". */
function rttIsClimbing(rttMs: number, baseRttMs: number, config: AbrConfig): boolean {
  if (!Number.isFinite(baseRttMs)) return false;
  return rttMs > baseRttMs * config.rttGradient + 20;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
