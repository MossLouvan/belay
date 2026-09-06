// Beluga motion choreography — the pure math behind the mascot's swim + spin.
//
// Kept free of React/Reanimated imports so `node --test` can exercise the
// numbers directly (beluga-motion.test.mjs). The per-frame functions carry a
// 'worklet' directive so Reanimated can also run them on the UI thread.
//
// The mascot is a transparent PNG cutout (642x537) — no circle, no water —
// so all "swimming" is transform-only: a slow bob plus a subtle sway.
//
// THE SPIN is a fidget toy, not a one-shot clip. Every tap adds angular
// velocity (capped), friction bleeds it off at a constant rate, and the
// landing is steered so the beluga always comes to rest exactly level
// (rotation ≡ 0 mod 360) — the idle sway then continues without a seam.
//
//   one tap from rest      → TAP_IMPULSE² / (2·SPIN_FRICTION) = exactly one
//                            full turn, landing in TAP_IMPULSE/SPIN_FRICTION s
//   rapid taps             → velocity stacks up to MAX_SPIN_VELOCITY
//   stop tapping           → decays; the last turn eases onto a level
//
// The model is a tiny immutable state machine: `SpinState` in, new
// `SpinState` out. Nothing here mutates.

/** Native pixel dimensions of assets/beluga-cutout.png. */
export const CUTOUT_ASPECT_RATIO = 642 / 537;

/** Idle swim: one bob half-cycle (down or up), ms. Full cycle is 2x. */
export const IDLE_BOB_HALF_CYCLE_MS = 1600;
/** Idle swim: bob travel as a fraction of the avatar size (gentle, not jitter). */
export const IDLE_BOB_TRAVEL_FRACTION = 0.04;
/** Idle swim: one sway half-cycle, ms. Deliberately off-beat from the bob. */
export const IDLE_SWAY_HALF_CYCLE_MS = 2100;
/** Idle swim: max sway rotation, degrees, either side of level. */
export const IDLE_SWAY_DEGREES = 2.5;

/** One full turn, degrees. Every landing is a whole number of these. */
export const FULL_TURN_DEGREES = 360;
/** Spin: angular velocity each tap adds, degrees per second. */
export const TAP_IMPULSE = 720;
/** Spin: constant deceleration from friction, degrees per second². */
export const SPIN_FRICTION = 720;
/** Spin: the ceiling on angular velocity, degrees per second (6 turns/s). */
export const MAX_SPIN_VELOCITY = 2160;
/** Spin: a landing closer than this to the current angle is snapped. */
export const LANDING_EPSILON_DEGREES = 0.05;
/**
 * Spin: the slowest the beluga ever crawls toward its landing, degrees per
 * second. Half a degree per frame — invisible, but it bounds every landing
 * to finite time however the numbers were perturbed. The "never stuck" law.
 */
export const MIN_LANDING_VELOCITY = 30;
/** Spin: taps at or past this velocity buzz heavy (the top of the range). */
export const HEAVY_SPIN_VELOCITY = MAX_SPIN_VELOCITY * 0.8;
/**
 * Spin: the longest frame the integrator will honour, seconds. A stall
 * (backgrounding, a JS hiccup) must not teleport the beluga through turns.
 */
export const MAX_FRAME_SECONDS = 1 / 20;

/** Flip: jump height at a turn's apex at single-tap speed, fraction of size. */
export const FLIP_JUMP_FRACTION = 0.35;
/** Flip: how much the beluga swells at the apex at single-tap speed. */
export const FLIP_APEX_SCALE = 1.08;
/** Spin: lift + swell at the velocity cap, as a multiplier on the above. */
export const HOVER_BOOST = 1.6;

export interface BelugaImageBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The image box for a given avatar `size`: width fills the slot, height
 * follows the cutout's native aspect so the beluga is never squashed.
 */
export function belugaImageBox(size: number): BelugaImageBox {
  return Object.freeze({
    width: size,
    height: size / CUTOUT_ASPECT_RATIO,
  });
}

// ---------------------------------------------------------------------------
// Spin physics
// ---------------------------------------------------------------------------

export interface SpinState {
  /** Accumulated rotation, degrees. Unbounded; display it modulo a turn. */
  readonly angle: number;
  /** Angular velocity, degrees per second. Never negative. */
  readonly velocity: number;
  /** The level (multiple of 360) the current spin is steering onto. */
  readonly target: number;
}

/** At rest, level. */
export const SPIN_AT_REST: SpinState = Object.freeze({ angle: 0, velocity: 0, target: 0 });

/** Whether the spin has come to rest (nothing left to animate). */
export function isSpinIdle(state: SpinState): boolean {
  'worklet';
  return state.velocity <= 0;
}

/**
 * Where a spin at `velocity` from `angle` would naturally stop under plain
 * friction, rounded to the nearest level — but never a level behind the
 * beluga, so it never rewinds to land.
 */
export function landingLevel(angle: number, velocity: number): number {
  'worklet';
  const naturalStop = angle + (velocity * velocity) / (2 * SPIN_FRICTION);
  const nearest = Math.round(naturalStop / FULL_TURN_DEGREES) * FULL_TURN_DEGREES;
  if (nearest > angle + LANDING_EPSILON_DEGREES) return nearest;
  return Math.ceil((angle + LANDING_EPSILON_DEGREES) / FULL_TURN_DEGREES) * FULL_TURN_DEGREES;
}

/**
 * A tap: adds TAP_IMPULSE of angular velocity (capped), and re-aims the
 * landing. Mid-spin taps ADD — nothing resets.
 */
export function tapSpin(state: SpinState): SpinState {
  'worklet';
  const velocity = Math.min(state.velocity + TAP_IMPULSE, MAX_SPIN_VELOCITY);
  return { angle: state.angle, velocity, target: landingLevel(state.angle, velocity) };
}

/**
 * Advance the spin by `dtSeconds`. Friction is constant, but retuned each
 * frame so the remaining velocity is spent exactly on reaching `target` —
 * which is how the beluga always lands level, and lands in finite time.
 */
export function stepSpin(state: SpinState, dtSeconds: number): SpinState {
  'worklet';
  if (state.velocity <= 0) return state;
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_FRAME_SECONDS);
  const remaining = state.target - state.angle;
  if (remaining <= LANDING_EPSILON_DEGREES) {
    return { angle: state.target, velocity: 0, target: state.target };
  }
  const deceleration = (state.velocity * state.velocity) / (2 * remaining);
  const velocity = Math.max(state.velocity - deceleration * dt, MIN_LANDING_VELOCITY);
  const travel = ((Math.max(state.velocity, MIN_LANDING_VELOCITY) + velocity) / 2) * dt;
  if (travel >= remaining - LANDING_EPSILON_DEGREES) {
    return { angle: state.target, velocity: 0, target: state.target };
  }
  return { angle: state.angle + travel, velocity, target: state.target };
}

/** The rotation to draw for a spin state: within one turn, level at rest. */
export function spinRotation(state: SpinState): number {
  'worklet';
  return state.angle % FULL_TURN_DEGREES;
}

/**
 * How far the spin is past single-tap speed, 0..1. Drives the "hover":
 * a lone flip hops once per turn, a fast spin lifts off and stays up.
 */
export function hoverWeight(velocity: number): number {
  'worklet';
  const span = MAX_SPIN_VELOCITY - TAP_IMPULSE;
  return Math.min(Math.max((velocity - TAP_IMPULSE) / span, 0), 1);
}

/**
 * 0..1+ envelope for lift and swell: a per-turn sine arc (zero at every
 * level, so a landing is always flat) that blends into a steady hover as
 * the spin speeds up, then grows with speed up to HOVER_BOOST.
 */
export function spinEnvelope(state: SpinState): number {
  'worklet';
  if (state.velocity <= 0) return 0;
  const turnFraction = (state.angle % FULL_TURN_DEGREES) / FULL_TURN_DEGREES;
  const arc = Math.sin(Math.PI * turnFraction);
  const hover = hoverWeight(state.velocity);
  return (arc * (1 - hover) + hover) * (1 + hover * (HOVER_BOOST - 1));
}

/** Vertical offset (negative = up) of the beluga for a spin state. */
export function spinJumpOffset(state: SpinState, size: number): number {
  'worklet';
  return -spinEnvelope(state) * size * FLIP_JUMP_FRACTION;
}

/** Scale of the beluga for a spin state: 1 at rest, swelling with speed. */
export function spinScale(state: SpinState): number {
  'worklet';
  return 1 + spinEnvelope(state) * (FLIP_APEX_SCALE - 1);
}

export type SpinHapticTier = 'light' | 'medium' | 'heavy';

/**
 * The haptic for a tap that leaves the beluga at `velocity`: a lone flip
 * is light, a stacked spin is medium, the top of the range is heavy.
 */
export function spinHapticTier(velocity: number): SpinHapticTier {
  'worklet';
  if (velocity >= HEAVY_SPIN_VELOCITY) return 'heavy';
  if (velocity > TAP_IMPULSE) return 'medium';
  return 'light';
}
