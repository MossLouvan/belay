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
