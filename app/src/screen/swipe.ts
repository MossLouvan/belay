// Multi-finger swipe detection: maps finger travel to OS trackpad gestures.
// Exercised by swipe.test.mjs under Node's type stripping, so — like keybar.ts
// — nothing here may import React, JSX, or (by value) any other local module;
// tunables come in from the caller.
//
// The host cannot receive "a trackpad gesture" — it receives key events — so
// each swipe becomes the keystroke the OS already binds to it. The chords
// live as KeySpecs in model.ts (DeskPrev/DeskNext/Overview/etc), shared with the
// key bar's last page, so the gesture and its visible twin can never drift
// apart; the screen tab resolves the id through the usual keyFor/modsFor.

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Direction of finger travel -> which KeySpec fires. Swiping LEFT shows the
 * desktop on the RIGHT: the desktops move with the fingers, exactly as the
 * Mac trackpad gesture this imitates works.
 */
export const SWIPE_ACTION_ID: Record<SwipeDirection, string> = Object.freeze({
  left: 'DeskNext',
  right: 'DeskPrev',
  up: 'Overview',
  down: 'ShowDesktop',
});

/** The slice of GESTURE the detector reads. Structural, so GESTURE fits. */
export interface SwipeTuning {
  readonly swipeThresholdPx: number;
  readonly swipeAxisRatio: number;
}

/**
 * Classifies centroid travel since the trio was adopted. `null` means "not
 * yet": under the threshold, or a diagonal where neither axis has beaten the
 * other by `swipeAxisRatio` — a sloppy swipe waits until it commits to one
 * axis rather than ever firing two actions. Now supports all four cardinal
 * directions to match full OS trackpad behavior (show desktop, notification
 * center, desktop switching, mission control/task view).
 */
export const detectSwipe = (dx: number, dy: number, t: SwipeTuning): SwipeDirection | null => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < t.swipeThresholdPx) return null;
  if (ax >= ay * t.swipeAxisRatio) return dx < 0 ? 'left' : 'right';
  if (ay >= ax * t.swipeAxisRatio) return dy < 0 ? 'up' : 'down';
  return null;
};
