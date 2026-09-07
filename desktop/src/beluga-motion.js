// Beluga motion choreography — the desktop port of app/src/ui/beluga-motion.ts.
//
// Same numbers, same immutable state machine, so the mascot on the Mac
// behaves exactly like the one on the phone: a slow bob + off-beat sway
// while idle, and a fidget-toy spin on click. Every tap adds angular
// velocity (capped), friction bleeds it off, and the landing is steered so
// the beluga always comes to rest level (rotation ≡ 0 mod 360).
//
//   one tap from rest → TAP_IMPULSE² / (2·SPIN_FRICTION) = exactly one turn
//   rapid taps        → velocity stacks up to MAX_SPIN_VELOCITY
//   stop tapping      → decays; the last turn eases onto a level
//
// Pure functions only: no DOM, so `node --test` exercises the numbers.

export const IDLE_BOB_HALF_CYCLE_MS = 1600;
export const IDLE_BOB_TRAVEL_FRACTION = 0.04;
export const IDLE_SWAY_HALF_CYCLE_MS = 2100;
export const IDLE_SWAY_DEGREES = 2.5;

export const FULL_TURN_DEGREES = 360;
export const TAP_IMPULSE = 720;
export const SPIN_FRICTION = 720;
export const MAX_SPIN_VELOCITY = 2160;
export const LANDING_EPSILON_DEGREES = 0.05;
export const MIN_LANDING_VELOCITY = 30;
export const MAX_FRAME_SECONDS = 1 / 20;

export const FLIP_JUMP_FRACTION = 0.35;
export const FLIP_APEX_SCALE = 1.08;
export const HOVER_BOOST = 1.6;

/** @typedef {{ readonly angle: number, readonly velocity: number, readonly target: number }} SpinState */

/** @type {SpinState} */
export const SPIN_AT_REST = Object.freeze({ angle: 0, velocity: 0, target: 0 });

/** @param {SpinState} state */
export function isSpinIdle(state) {
  return state.velocity <= 0;
}

/**
 * Where a spin at `velocity` from `angle` would stop under plain friction,
 * rounded to the nearest level — never a level behind the beluga.
 * @param {number} angle @param {number} velocity
 */
export function landingLevel(angle, velocity) {
  const naturalStop = angle + (velocity * velocity) / (2 * SPIN_FRICTION);
  const nearest = Math.round(naturalStop / FULL_TURN_DEGREES) * FULL_TURN_DEGREES;
  if (nearest > angle + LANDING_EPSILON_DEGREES) return nearest;
  return Math.ceil((angle + LANDING_EPSILON_DEGREES) / FULL_TURN_DEGREES) * FULL_TURN_DEGREES;
}

/** A tap: adds TAP_IMPULSE (capped) and re-aims the landing. @param {SpinState} state @returns {SpinState} */
export function tapSpin(state) {
  const velocity = Math.min(state.velocity + TAP_IMPULSE, MAX_SPIN_VELOCITY);
  return Object.freeze({ angle: state.angle, velocity, target: landingLevel(state.angle, velocity) });
}

/**
 * Advance by `dtSeconds`. Friction is retuned each frame so the remaining
 * velocity is spent exactly on reaching `target`: always level, finite time.
 * @param {SpinState} state @param {number} dtSeconds @returns {SpinState}
 */
export function stepSpin(state, dtSeconds) {
  if (state.velocity <= 0) return state;
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_FRAME_SECONDS);
  const remaining = state.target - state.angle;
  if (remaining <= LANDING_EPSILON_DEGREES) {
    return Object.freeze({ angle: state.target, velocity: 0, target: state.target });
  }
  const deceleration = (state.velocity * state.velocity) / (2 * remaining);
  const velocity = Math.max(state.velocity - deceleration * dt, MIN_LANDING_VELOCITY);
  const travel = ((Math.max(state.velocity, MIN_LANDING_VELOCITY) + velocity) / 2) * dt;
  if (travel >= remaining - LANDING_EPSILON_DEGREES) {
    return Object.freeze({ angle: state.target, velocity: 0, target: state.target });
  }
  return Object.freeze({ angle: state.angle + travel, velocity, target: state.target });
}

/** @param {SpinState} state */
export function spinRotation(state) {
  return state.angle % FULL_TURN_DEGREES;
}

/** How far past single-tap speed, 0..1. @param {number} velocity */
export function hoverWeight(velocity) {
  const span = MAX_SPIN_VELOCITY - TAP_IMPULSE;
  return Math.min(Math.max((velocity - TAP_IMPULSE) / span, 0), 1);
}

/** Lift/swell envelope: a per-turn arc blending into a hover with speed. @param {SpinState} state */
export function spinEnvelope(state) {
  if (state.velocity <= 0) return 0;
  const turnFraction = (state.angle % FULL_TURN_DEGREES) / FULL_TURN_DEGREES;
  const arc = Math.sin(Math.PI * turnFraction);
  const hover = hoverWeight(state.velocity);
  return (arc * (1 - hover) + hover) * (1 + hover * (HOVER_BOOST - 1));
}

/** Vertical offset (negative = up), px. @param {SpinState} state @param {number} size */
export function spinJumpOffset(state, size) {
  return -spinEnvelope(state) * size * FLIP_JUMP_FRACTION;
}

/** Scale: 1 at rest, swelling with speed. @param {SpinState} state */
export function spinScale(state) {
  return 1 + spinEnvelope(state) * (FLIP_APEX_SCALE - 1);
}

/**
 * The idle swim at time `t` (ms): a sine bob and an off-beat sine sway,
 * matching the phone's two mirrored withRepeat loops.
 * @param {number} t @param {number} size
 * @returns {{ readonly bob: number, readonly sway: number }}
 */
export function idleSwim(t, size) {
  const bob = -Math.cos((Math.PI * t) / IDLE_BOB_HALF_CYCLE_MS) * size * IDLE_BOB_TRAVEL_FRACTION;
  const sway = -Math.cos((Math.PI * t) / IDLE_SWAY_HALF_CYCLE_MS) * IDLE_SWAY_DEGREES;
  return Object.freeze({ bob, sway });
}

/**
 * The CSS transform for one frame: the swim on the outside, the spin inside,
 * so a flip launches from wherever the bob is and lands back into it.
 * @param {SpinState} spin @param {number} t @param {number} size @param {boolean} reducedMotion
 */
export function belugaTransform(spin, t, size, reducedMotion) {
  if (reducedMotion) return 'none';
  const swim = idleSwim(t, size);
  return `translateY(${swim.bob.toFixed(2)}px) rotate(${swim.sway.toFixed(3)}deg) `
    + `translateY(${spinJumpOffset(spin, size).toFixed(2)}px) `
    + `rotate(${spinRotation(spin).toFixed(3)}deg) scale(${spinScale(spin).toFixed(4)})`;
}
