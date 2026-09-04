// Timing decisions for auto-hiding stage overlays (the fullscreen dock and the
// zoom pill). Pure functions only — exercised by autohide.test.mjs under
// Node's type stripping — the React side lives in useAutoHide.ts.

/** Fullscreen control dock: gone after 4s of no interaction. */
export const AUTO_HIDE_MS = 4000;

/** Zoom pill: dims (never disappears) a little sooner — it is pure chrome. */
export const ZOOM_DIM_MS = 2500;

/** Opacity of a dimmed-but-present overlay (the corner handle, the zoom pill). */
export const DIMMED_OPACITY = 0.35;

// --- the bottom-edge reveal -------------------------------------------------
//
// While the immersive control bar is hidden, a thin strip pinned to the very
// bottom edge of the screen is the ONE way touch brings it back. Stage touches
// are remote input and must never double as "reveal the controls"; an edge
// swipe cannot be a remote click or scroll because it starts off the desktop's
// useful surface and must commit upward before the strip claims it.

/** Height of the reveal strip, px. Thin: an edge affordance, not a dead band. */
export const REVEAL_EDGE_PX = 24;

/** Upward travel (px) that commits the reveal. Jitter alone must not reveal. */
export const REVEAL_SWIPE_PX = 12;

/**
 * The strip's claim rule, from the responder's cumulative dx/dy: committed
 * upward (dy past the threshold, negative is up) and more vertical than
 * horizontal. Anything else — a tap, a rest, a sideways or downward drag —
 * is refused, so the strip never argues with input it cannot serve.
 */
export const isRevealSwipe = (dx: number, dy: number): boolean =>
  dy <= -REVEAL_SWIPE_PX && Math.abs(dy) > Math.abs(dx);

/** Whether an overlay last poked at `lastPokeAt` should still be shown at `now`. */
export function stillVisible(now: number, lastPokeAt: number, delayMs: number): boolean {
  return now - lastPokeAt < delayMs;
}

/**
 * How long a freshly (re)armed timer should wait before hiding. Never negative
 * — an overdue overlay hides on the next tick rather than throwing setTimeout
 * a nonsense delay. A poke in the future (clock skew) is treated as "just now".
 */
export function hideDelayRemaining(now: number, lastPokeAt: number, delayMs: number): number {
  if (lastPokeAt > now) return delayMs;
  return Math.max(0, lastPokeAt + delayMs - now);
}
