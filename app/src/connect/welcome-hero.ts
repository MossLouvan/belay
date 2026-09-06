// Geometry and choreography for the welcome hero — the beluga's water.
//
// The welcome screen floats the transparent cutout over concentric translucent
// "glow" circles — soft ambient light behind the beluga, never a hard edge or
// a porthole around it. The circle math and the entrance stagger are pure
// numbers, so they live here where node can test them; the screen itself only
// maps the results onto Views.

/** One translucent circle behind the mascot. Drawn largest-first. */
export interface HaloLayer {
  /** Circle diameter in pt. */
  readonly diameter: number;
  /** Opacity multiplier applied on top of the `heroGlow` token's own alpha. */
  readonly opacity: number;
}

// The halo steps out from the avatar in two rings. Offsets are even numbers on
// the 4pt grid; the outer ring fades so the glow dissolves into the page
// rather than ending on a visible edge.
const HALO_STEPS: readonly HaloLayer[] = Object.freeze([
  Object.freeze({ diameter: 64, opacity: 1 }),
  Object.freeze({ diameter: 152, opacity: 0.45 }),
]);

/**
 * The glow circles for a mascot of `avatarSize` pt, largest first so the
 * screen can stack them back-to-front. Throws on a non-positive or non-finite
 * size — a broken size here means a broken layout, and failing fast beats
 * rendering an invisible halo.
 */
export function haloLayers(avatarSize: number): readonly HaloLayer[] {
  if (!Number.isFinite(avatarSize) || avatarSize <= 0) {
    throw new Error(`haloLayers: avatarSize must be a positive finite number, received ${String(avatarSize)}`);
  }
  return HALO_STEPS.map((step) => ({
    diameter: avatarSize + step.diameter,
    opacity: step.opacity,
  }))
    .sort((a, b) => b.diameter - a.diameter);
}

/**
 * The entrance choreography: mascot first, words next, the way forward last.
 * One duration (the sanctioned 400ms hero draw — docs/DESIGN.md §10 allows
 * exactly one hero animation per surface), one 8pt rise (the translation cap),
 * three staggered starts. Reduced motion skips the whole sequence.
 */
export const HERO_ENTRANCE = Object.freeze({
  /** Shared fade/rise duration, ms. Matches `motion.draw`. */
  durationMs: 400,
  /** How far each block rises into place, pt. The motion-doctrine cap. */
  riseDistancePt: 8,
  mascotDelayMs: 0,
  headlineDelayMs: 140,
  ctaDelayMs: 280,
});
