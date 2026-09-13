// Segment-control metrics, in one place.
//
// Two components draw the same control: `ui/controls.tsx` (the generic
// SegmentedControl) and `screen/mode-strip.tsx` (Trackpad · Keyboard ·
// Controller). Both were independently computing `look.controlRadius + 4` for
// the track, `+ 1` for the selected chip, a 3pt track inset and a 14pt label —
// four magic numbers duplicated across two files, which is exactly how the two
// strips drift apart. They live here instead, as pure data and pure functions:
// no React, no react-native, so this module is directly unit-testable.

/**
 * Inset between the track's edge and the chips inside it. Sub-4pt on purpose:
 * this is the optical seam of a nested rectangle, not layout spacing — a 4pt
 * inset makes a 34pt chip read as a floating button rather than a segment.
 */
export const SEGMENT_TRACK_INSET = 3;

/**
 * Visual height of one segment. Shorter than the 44pt minimum so the strip
 * stays chrome-dense; callers top the effective target up with vertical
 * hitSlop via {@link segmentHitSlop}.
 */
export const SEGMENT_HEIGHT = 34;

/**
 * The segment label's size. One step under `theme.type.button` (15pt): three
 * words have to fit side by side on a 375pt phone without truncating, and the
 * strip is chrome rather than a primary action.
 */
export const SEGMENT_LABEL_SIZE = 14;

/** How much rounder the track is than the control radius it is built from. */
const TRACK_RADIUS_STEP = 4;
/** The selected chip sits one step tighter than the track that holds it. */
const CHIP_RADIUS_STEP = 1;

const assertRadius = (controlRadius: number, fn: string): void => {
  if (!Number.isFinite(controlRadius) || controlRadius < 0) {
    throw new Error(`${fn}: expected a finite radius >= 0, received ${String(controlRadius)}`);
  }
};

/** Corner radius of the segment track (the recessed rail). */
export function segmentTrackRadius(controlRadius: number): number {
  assertRadius(controlRadius, 'segmentTrackRadius');
  return controlRadius + TRACK_RADIUS_STEP;
}

/** Corner radius of one segment chip, nested inside the track. */
export function segmentChipRadius(controlRadius: number): number {
  assertRadius(controlRadius, 'segmentChipRadius');
  return controlRadius + CHIP_RADIUS_STEP;
}

/** Vertical-only touch slop. */
export interface SegmentHitSlop {
  readonly top: number;
  readonly bottom: number;
}

/**
 * Slop that tops a short segment up to the minimum touch target. Split evenly
 * above and below so the effective target stays centred on the chip, clamped
 * at 0 in case the constants ever cross over. Horizontal slop is deliberately
 * omitted: segments are adjacent, so widening them sideways would make
 * neighbouring targets overlap.
 */
export function segmentHitSlop(minTouch: number, height: number = SEGMENT_HEIGHT): SegmentHitSlop {
  if (!Number.isFinite(minTouch) || !Number.isFinite(height)) {
    throw new Error(`segmentHitSlop: expected finite numbers, received (${String(minTouch)}, ${String(height)})`);
  }
  const slop = Math.max(0, Math.round((minTouch - height) / 2));
  return Object.freeze({ top: slop, bottom: slop });
}
