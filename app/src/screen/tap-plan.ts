// Tap → click, with no wait. The old planner held every tap for
// GESTURE.doubleTapMs in case a second one upgraded it; now the first tap
// clicks at once and the second, if it comes, is click #2 of the sequence
// (the host posts it with clickState 2, so applications see a double-click).

import { GESTURE } from './model.ts';

export type Point = { readonly x: number; readonly y: number };
/** The last single tap, or null when the next tap starts a fresh sequence. */
export type TapMemory = { readonly x: number; readonly y: number; readonly at: number } | null;

export type TapPlan = {
  /** 1 for a lone click, 2 for the second click of a double. */
  readonly count: 1 | 2;
  /** Where to click: the first tap's point for a double, so both land together. */
  readonly point: Point;
  readonly next: TapMemory;
};

export function planTap(prev: TapMemory, point: Point, now: number): TapPlan {
  if (
    prev &&
    now - prev.at <= GESTURE.doubleTapMs &&
    Math.abs(point.x - prev.x) < GESTURE.doubleTapSlop &&
    Math.abs(point.y - prev.y) < GESTURE.doubleTapSlop
  ) {
    return { count: 2, point: { x: prev.x, y: prev.y }, next: null };
  }
  return { count: 1, point, next: { x: point.x, y: point.y, at: now } };
}
