// Beluga motion choreography — the pure math behind the mascot's swim + flip.
//
// Kept free of React/Reanimated imports so `node --test` can exercise the
// numbers directly (beluga-motion.test.mjs). The arc functions carry a
// 'worklet' directive so Reanimated can also run them on the UI thread.
//
// The mascot is a transparent PNG cutout (642x537) — no circle, no water —
// so all "swimming" is transform-only: a slow bob plus a subtle sway. The
// flip is a one-shot 360 with a jump arc, driven by a single 0..1 progress.

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

/** Flip: one-shot duration, ms. */
export const FLIP_DURATION_MS = 900;
/** Flip: total rotation, degrees (a single full flip). */
export const FLIP_DEGREES = 360;
/** Flip: jump height at the arc's apex, as a fraction of the avatar size. */
export const FLIP_JUMP_FRACTION = 0.35;
/** Flip: how much the beluga swells at the apex (1 = no swell). */
export const FLIP_APEX_SCALE = 1.08;

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

/**
 * Vertical offset of the flip's jump arc at `progress` in [0, 1]: zero at
 * both ends, peaking (negative = up) at the midpoint. A plain sine arc.
 */
export function flipJumpOffset(progress: number, size: number): number {
  'worklet';
  return -Math.sin(Math.PI * progress) * size * FLIP_JUMP_FRACTION;
}

/**
 * Scale of the beluga during the flip at `progress` in [0, 1]: 1 at both
 * ends, swelling to FLIP_APEX_SCALE at the apex.
 */
export function flipScale(progress: number): number {
  'worklet';
  return 1 + Math.sin(Math.PI * progress) * (FLIP_APEX_SCALE - 1);
}

/**
 * Rotation (degrees) of the flip at `progress` in [0, 1]. Ends exactly on a
 * full turn so the settle back into the idle sway is seamless.
 */
export function flipRotation(progress: number): number {
  'worklet';
  return progress * FLIP_DEGREES;
}
