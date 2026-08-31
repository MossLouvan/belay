// The pure maths behind scroll mode: what a one-finger drag means in each
// pointer mode, and how raw pixel deltas become the notched, throttled
// `/input/scroll` calls the host expects.
//
// Exercised by scroll-mode.test.mjs under Node's type stripping, so — like
// keybar.ts — nothing here may import React, JSX, or (by value) any other
// local module; the tunables are passed IN by the caller instead, and the
// viewport hands over `GESTURE` while the tests do the same.

// Type-only, and marked as such: erased before Node ever resolves it.
import type { GestureKind } from './touches';

/**
 * The three answers to "what does one finger do": touch taps and drags the
 * host mouse, trackpad nudges a visible cursor, and scroll moves the page
 * under your finger the way every other surface on a phone does.
 */
export type PointerMode = 'touch' | 'trackpad' | 'scroll';

/** The slice of GESTURE this module reads. Structural, so GESTURE just fits. */
export interface ScrollTuning {
  readonly tapSlopPx: number;
  readonly pxPerScrollNotch: number;
  readonly scrollGain: number;
  readonly maxNotchesPerSend: number;
  readonly scrollThrottleMs: number;
  readonly friction: number;
  readonly minMomentumPx: number;
  readonly frameMs: number;
}

/**
 * Finger px that buy one wheel notch once `scrollGain` has had its say. The
 * gain lives in model.ts with the other tunables; it is applied here, once,
 * so drags, flicks and the two-finger gesture all speed up together.
 */
export const pxPerNotch = (t: ScrollTuning): number => t.pxPerScrollNotch / t.scrollGain;

/**
 * Classifies a one-finger gesture from its drift since the grant.
 *
 * Staying 'pending' under the tap slop is the load-bearing branch: only a
 * release that never left 'pending' clicks, so it is what keeps a tap a
 * click in every mode — scroll mode included, where you must still be able
 * to tap the link you just scrolled to. A gesture already classified keeps
 * its intent; the mode is consulted exactly once.
 */
export const classifyOneFinger = (
  kind: GestureKind,
  dx: number,
  dy: number,
  mode: PointerMode,
  scale: number,
  t: ScrollTuning
): GestureKind => {
  if (kind !== 'pending') return kind;
  if (Math.hypot(dx, dy) < t.tapSlopPx) return 'pending';
  if (mode === 'scroll') return 'wheel';
  if (mode === 'trackpad') return 'cursor';
  // At 1x there is nothing to pan, so a drag is a drag on the host.
  return scale > 1 ? 'pan' : 'hostDrag';
};

/** One send's worth of scroll: whole notches out, the unsent px owed back. */
export interface ScrollBatch {
  readonly dy: number;
  readonly dx: number;
  readonly restY: number;
  readonly restX: number;
}

const notchOf = (px: number, t: ScrollTuning): { readonly notches: number; readonly rest: number } => {
  const per = pxPerNotch(t);
  // `+ 0` launders Math.trunc's negative zero so a "nothing to send" batch
  // compares equal to 0 whichever side of zero the drag came from.
  const raw = Math.trunc(px / per) + 0;
  const notches = Math.max(-t.maxNotchesPerSend, Math.min(t.maxNotchesPerSend, raw)) + 0;
  // The sub-notch remainder carries to the next send so a slow drag still
  // adds up to real scrolling; anything beyond the per-send clamp is
  // discarded instead — a wild flick must not bank a scroll debt that keeps
  // paying out after the finger has stopped.
  return { notches, rest: raw === notches ? px - notches * per : 0 };
};

/**
 * Converts accumulated pixel deltas into one wheel send. Finger deltas pass
 * through sign-unchanged: the two-finger gesture already sends them that way,
 * so the content follows the finger under both gestures — and if the host's
 * own natural-scrolling setting inverts synthetic wheel events, it inverts
 * both identically rather than splitting them.
 */
export const batchScroll = (dyPx: number, dxPx: number, t: ScrollTuning): ScrollBatch => {
  const y = notchOf(dyPx, t);
  const x = notchOf(dxPx, t);
  return { dy: y.notches, dx: x.notches, restY: y.rest, restX: x.rest };
};

/** Whether enough time has passed since the last send to scroll again. */
export const scrollDue = (now: number, lastAt: number, t: ScrollTuning): boolean =>
  now - lastAt >= t.scrollThrottleMs;

/** First momentum step in px/frame, from a release velocity in px/ms. */
export const flickStep = (velocity: number, t: ScrollTuning): number => velocity * t.frameMs;

/** One frame of friction. */
export const decayStep = (px: number, t: ScrollTuning): number => px * t.friction;

/**
 * A flick is over when the per-frame step has decayed to nothing AND the
 * carried remainder can never reach another notch — stopping on velocity
 * alone would strand up to a notch of owed scroll, stopping on the remainder
 * alone would run forever.
 */
export const flickSpent = (px: number, py: number, accX: number, accY: number, t: ScrollTuning): boolean =>
  Math.abs(px) < t.minMomentumPx &&
  Math.abs(py) < t.minMomentumPx &&
  Math.abs(accX) < pxPerNotch(t) &&
  Math.abs(accY) < pxPerNotch(t);
