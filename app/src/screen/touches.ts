// Touch bookkeeping for the remote stage: stage-local coordinates, the record
// that carries a gesture from grant to release, and identity tracking for the
// fingers driving a pinch/scroll pair or a three-finger swipe.
//
// Split out of `viewport.ts` so that file keeps only the transform, momentum and
// input-dispatch logic.

// Type-only, and marked as such: erased before Node ever resolves it — this
// file is exercised by swipe.test.mjs under Node's type stripping, which can
// follow no local module (or react-native) by value.
import type { NativeTouchEvent } from 'react-native';

/** Private copy of model's numberOf, for the node-importability above. */
const numberOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export type GestureKind =
  | 'none'
  | 'pending'
  | 'pendingTwo'
  | 'pendingThree'
  | 'pan'
  | 'hostDrag'
  | 'cursor'
  | 'zoom'
  /** Two fingers sending the wheel — any pointer mode. */
  | 'scroll'
  /** One finger sending the wheel — scroll mode's drag. */
  | 'wheel'
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
  /**
   * The pair's centroid at the last zoom frame, so the fingers' shared travel
   * can be paid out as a pan on top of the pinch maths. Reset whenever the
   * pair re-anchors — measuring the pan across a change of fingers would
   * jump the view exactly the way `pinchDistance` would jump the zoom.
   */
  twoLastX: number;
  twoLastY: number;
  /**
   * Scroll anchor. For the two-finger gesture: the pair's center at the last
   * send. For a one-finger 'wheel' drag: the portion of the responder's
   * cumulative dx/dy already paid out as wheel notches, so the unsent
   * remainder survives between throttled sends instead of being dropped.
   */
  scrollX: number;
  scrollY: number;
  /** Centroid anchor of a three-finger swipe, set when the trio is adopted. */
  threeStartX: number;
  threeStartY: number;
  /** Date.now() at the grant — the two-finger tap's clock starts here, so a
   *  finger that rested before the second one joined can never tap. */
  startAt: number;
  /**
   * The farthest the pair's centroid has drifted from its anchor, in px,
   * carried as a maximum ACROSS re-anchors: a re-baseline resets the anchor
   * (twoStartX/Y) for the pinch/scroll maths, and without this a pair that
   * wandered, swapped a finger and lifted could still read as "still".
   */
  twoMovedPx: number;
  /**
   * Whether a release of this pair may become the two-finger tap (the Mac
   * trackpad's secondary click). Armed at the grant, kept only while the
   * pair was adopted from a clean 'pending'/'pendingTwo' state — a second
   * finger joining mid-drag must never turn the release into a right-click.
   */
  twoTapEligible: boolean;
  /**
   * `identifier`s of the fingers currently driving a multi-finger gesture.
   * Tracked by identity rather than by array position: `touches[0]`/`touches[1]`
   * silently point at a different physical finger the moment another finger
   * lands or one of the set lifts, which would jump the pinch/scroll/swipe
   * baseline. `touchC` joins only for the three-finger swipe.
   */
  touchA: number | null;
  touchB: number | null;
  touchC: number | null;
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
  twoLastX: 0,
  twoLastY: 0,
  scrollX: 0,
  scrollY: 0,
  threeStartX: 0,
  threeStartY: 0,
  startAt: 0,
  twoMovedPx: 0,
  twoTapEligible: false,
  touchA: null,
  touchB: null,
  touchC: null,
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

/**
 * The three touches a swipe is already following, or `null` to re-anchor —
 * the same identity discipline as `trackedPair`, extended by one finger. A
 * fourth finger landing changes `touches`' order without breaking the trio,
 * so the swipe carries on and the stray finger is simply ignored.
 */
export const trackedTriple = (
  touches: readonly NativeTouchEvent[],
  gesture: Readonly<GestureRecord>
): readonly [NativeTouchEvent, NativeTouchEvent, NativeTouchEvent] | null => {
  const a = findById(touches, gesture.touchA);
  const b = findById(touches, gesture.touchB);
  const c = findById(touches, gesture.touchC);
  return a && b && c ? [a, b, c] : null;
};

// --- the two-finger tap -----------------------------------------------------

/** The slice of GESTURE the two-finger tap reads. Structural, so GESTURE fits. */
export interface TwoFingerTapTuning {
  /** Both fingers down and up inside this window (from the grant), or it is
   *  a rest, not a tap. */
  readonly twoFingerTapMs: number;
  /** Centroid drift the tap forgives. At least `scrollThresholdPx`, so no
   *  movement band exists where a touch is too still to scroll yet too
   *  travelled to tap. */
  readonly twoFingerTapSlopPx: number;
}

/**
 * Whether a pair being (re)adopted may still end in a tap. Only a clean
 * arrival — fresh 'pending' touch or an already-armed 'pendingTwo' finger
 * swap — keeps the flag; a pair formed mid-drag (cursor, pan, wheel, a
 * broken trio…) is a grip change, not a secondary click. One-way: lost
 * eligibility is never regained within a gesture.
 */
export const pairTapEligible = (kind: GestureKind, wasEligible: boolean): boolean =>
  wasEligible && (kind === 'pending' || kind === 'pendingTwo');

/**
 * The release-time verdict: a two-finger touch that stayed 'pendingTwo'
 * (so the classifier never saw a pinch or a scroll in it), arrived cleanly,
 * lifted inside the tap window and never really travelled is the Mac
 * trackpad's secondary click. Negative elapsed time (clock skew) refuses —
 * a phantom right-click is worse than a missed one.
 */
export const isTwoFingerTap = (
  kind: GestureKind,
  eligible: boolean,
  elapsedMs: number,
  movedPx: number,
  t: TwoFingerTapTuning
): boolean =>
  kind === 'pendingTwo' &&
  eligible &&
  elapsedMs >= 0 &&
  elapsedMs <= t.twoFingerTapMs &&
  movedPx <= t.twoFingerTapSlopPx;

/** Mean position of any number of stage-local points. */
export const centroidOf = (points: readonly Point[]): Point => {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
};
