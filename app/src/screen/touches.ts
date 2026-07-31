// Touch bookkeeping for the remote stage: stage-local coordinates, the record
// that carries a gesture from grant to release, and identity tracking for the
// two fingers driving a pinch/scroll.
//
// Split out of `viewport.ts` so that file keeps only the transform, momentum and
// input-dispatch logic.

import { NativeTouchEvent } from 'react-native';
import { numberOf } from './model';

export type GestureKind =
  | 'none'
  | 'pending'
  | 'pendingTwo'
  | 'pan'
  | 'hostDrag'
  | 'cursor'
  | 'zoom'
  | 'scroll'
  | 'consumed';

export interface GestureRecord {
  kind: GestureKind;
  startX: number;
  startY: number;
  baseTx: number;
  baseTy: number;
  baseScale: number;
  lastDx: number;
  lastDy: number;
  pinchDistance: number;
  twoStartX: number;
  twoStartY: number;
  scrollX: number;
  scrollY: number;
  /**
   * `identifier`s of the two fingers currently driving the two-finger gesture.
   * Tracked by identity rather than by array position: `touches[0]`/`touches[1]`
   * silently point at a different physical finger the moment a third finger
   * lands or one of the pair lifts, which would jump the pinch/scroll baseline.
   */
  touchA: number | null;
  touchB: number | null;
  longPress: ReturnType<typeof setTimeout> | undefined;
}

export const newGesture = (): GestureRecord => ({
  kind: 'none',
  startX: 0,
  startY: 0,
  baseTx: 0,
  baseTy: 0,
  baseScale: 1,
  lastDx: 0,
  lastDy: 0,
  pinchDistance: 0,
  twoStartX: 0,
  twoStartY: 0,
  scrollX: 0,
  scrollY: 0,
  touchA: null,
  touchB: null,
  longPress: undefined,
});

export interface Origin {
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Stage-local position of one touch in a multi-touch gesture.
 *
 * Entries in `nativeEvent.touches` carry `locationX`/`locationY` on native but
 * not on react-native-web, so the page coordinate minus the stage's page origin
 * is the only value that is correct on both. `locationX` is the fallback for any
 * runtime that omits `pageX` instead.
 */
export const touchPoint = (touch: NativeTouchEvent, origin: Origin): Point => ({
  x: typeof touch.pageX === 'number' ? touch.pageX - origin.x : numberOf(touch.locationX),
  y: typeof touch.pageY === 'number' ? touch.pageY - origin.y : numberOf(touch.locationY),
});

/** Stable id of a touch. React Native and react-native-web both supply one. */
export const identifierOf = (touch: NativeTouchEvent): number => numberOf(touch.identifier);

/** Geometry of the pair of fingers driving a two-finger gesture. */
export interface PairGeometry {
  readonly distance: number;
  readonly centerX: number;
  readonly centerY: number;
}

export const geometryOf = (a: Point, b: Point): PairGeometry => ({
  distance: Math.hypot(b.x - a.x, b.y - a.y),
  centerX: (a.x + b.x) / 2,
  centerY: (a.y + b.y) / 2,
});

const findById = (
  touches: readonly NativeTouchEvent[],
  id: number | null
): NativeTouchEvent | undefined =>
  id === null ? undefined : touches.find((touch) => identifierOf(touch) === id);

/**
 * The two touches the gesture is already following, or `null` when it is not
 * following a pair yet or one of them has lifted. `null` means "re-baseline":
 * carrying the old pinch distance across a change of fingers is exactly the
 * jump this tracking exists to prevent.
 */
export const trackedPair = (
  touches: readonly NativeTouchEvent[],
  gesture: Readonly<GestureRecord>
): readonly [NativeTouchEvent, NativeTouchEvent] | null => {
  const a = findById(touches, gesture.touchA);
  const b = findById(touches, gesture.touchB);
  return a && b ? [a, b] : null;
};
