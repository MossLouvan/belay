// Timing decisions for auto-hiding stage overlays (the fullscreen dock and the
// zoom pill). Pure functions only — exercised by autohide.test.mjs under
// Node's type stripping — the React side lives in useAutoHide.ts.

/** Fullscreen control dock: gone after 4s of no interaction. */
export const AUTO_HIDE_MS = 4000;

/** Zoom pill: dims (never disappears) a little sooner — it is pure chrome. */
export const ZOOM_DIM_MS = 2500;

/** Opacity of a dimmed-but-present overlay (the corner handle, the zoom pill). */
export const DIMMED_OPACITY = 0.35;

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
