// The deadspace trackpad's pure decisions. The stage is sized to the remote
// aspect ratio (fitBox), so on a tall phone a black gap opens between the
// picture and the control bar. That gap is a laptop trackpad (the viewport's
// `padHandlers` pin it to relative mode); this module decides only the quiet
// presentation questions — how big the gap is and when the "TRACKPAD" hint
// has room to sit in it.
//
// Exercised by trackpad.test.mjs under Node's type stripping, so — like
// scroll-mode.ts — nothing here may import React, JSX, or (by value) any
// other local module.

/** The gap must at least fit a fingertip before the hint claims it is a pad. */
export const PAD_HINT_MIN_PX = 72;

/** How long the crosshair outlives the last pad touch, in ms — long enough
 *  to lift the finger and read where the next tap will click. */
export const PAD_CURSOR_LINGER_MS = 2500;

/** Height of the deadspace under the top-aligned stage, never negative. */
export const padGapBelow = (boxH: number, stageH: number): number =>
  Math.max(0, boxH - stageH);

/**
 * Whether the centered "TRACKPAD" micro-hint should render. Portrait only
 * (immersive centers the stage, so the gap splits and the label would float
 * ambiguously), and only when the gap could actually be used as a pad —
 * a sliver of letterbox with a label in it reads as a bug, not a feature.
 */
export const showsPadHint = (gapPx: number, immersive: boolean): boolean =>
  !immersive && gapPx >= PAD_HINT_MIN_PX;

/**
 * The pill row (Audio / Fullscreen) rides the stage's bottom edge, so the pad
 * starts below it rather than under it. One constant, named, instead of the
 * magic 72 that used to sit inline in the style.
 */
export const PAD_TOP_GAP_PX = 72;

/** The pad's own bottom margin inside the panel. */
export const PAD_BOTTOM_PX = 8;

/** A pad shorter than one touch target is not a pad. */
export const PAD_MIN_PX = 44;

export interface PadMountInputs {
  /** The controller overlay owns every touch on the panel. */
  readonly gaming: boolean;
}

/**
 * Whether the deadspace trackpad is mounted at all.
 *
 * Gaming is the only state that takes it away: there the controller overlay
 * owns every touch. It used to stand down while the panel-state guidance was
 * up too — correct back when that guidance filled the whole machine panel,
 * wrong since it was clipped to the stage rectangle it explains. The well
 * below the stage then went dead, and on a host whose screen-recording
 * permission is off (`captureBlocked` keeps the guidance up for the whole
 * session) the trackpad never appeared at all. Pointing still works with no
 * picture — the host's cursor moves — so the pad stays.
 */
export const padMounted = ({ gaming }: PadMountInputs): boolean => !gaming;

export interface PadRect {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The portrait pad's inset rect inside the machine panel: under the pill row,
 * down to the panel's bottom margin.
 *
 * Clamped, because `stageH + PAD_TOP_GAP_PX` is not bounded by the panel: with
 * the inline keyboard surface open the dock grows and the panel shrinks, and a
 * top below the bottom collapses the pad to nothing (or inverts it) exactly
 * when the user has a thumb on it. The clamp gives up the pill row's air
 * before it gives up a touchable pad; the pills are rendered after the pad and
 * still win their own touches.
 */
export const padRect = (boxH: number, stageH: number): PadRect => {
  const floor = Math.max(0, boxH - PAD_BOTTOM_PX - PAD_MIN_PX);
  return { top: Math.min(stageH + PAD_TOP_GAP_PX, floor), bottom: PAD_BOTTOM_PX };
};
