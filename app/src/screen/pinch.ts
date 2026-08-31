// The pure maths of the two-finger gesture: how a pinch scales the picture
// about the fingers, how the pair's drifting centroid drags it, where the
// picture is allowed to sit, and when a two-finger drag means "pan the view"
// rather than "send the wheel".
//
// Exercised by pinch.test.mjs under Node's type stripping, so — like
// scroll-mode.ts — nothing here may import React, JSX, or (by value) any
// other local module; the tunables are passed IN by the caller, and the
// viewport hands over `GESTURE` while the tests do the same.

/** The view transform: scale about the stage centre, then translate. */
export interface ViewTransform {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

/** The slice of GESTURE this module reads. Structural, so GESTURE just fits. */
export interface PinchTuning {
  readonly minScale: number;
  readonly maxScale: number;
  readonly pinchThreshold: number;
  readonly scrollThresholdPx: number;
}

export interface Translate {
  readonly tx: number;
  readonly ty: number;
}

// `+ 0` launders the negative zero a zero limit produces, so "pinned to the
// centre" is the same value whichever side the pan came from.
const bound = (value: number, limit: number): number => Math.min(limit, Math.max(-limit, value)) + 0;

/**
 * Keeps the picture covering the stage: at scale s it overhangs by (s-1)
 * stage-widths in total, half on each side, and a translate beyond that
 * would drag it off into empty space. At scale 1 both limits are zero, so a
 * pan or a flick collapses to exactly (0,0) — still, not stuck-and-jittery.
 */
export const clampTranslate = (tx: number, ty: number, scale: number, w: number, h: number): Translate => ({
  tx: bound(tx, Math.max(0, ((scale - 1) * w) / 2)),
  ty: bound(ty, Math.max(0, ((scale - 1) * h) / 2)),
});

/**
 * Scales about a focal point in stage coordinates: the picture point under
 * the fingers stays under the fingers as the scale changes. When the scale
 * does NOT change this is the identity — the centroid's own travel never
 * translates anything here, which was the "zoom in but cannot move the
 * focus" bug; that travel is `panBy`'s job, applied on top each frame.
 */
export const zoomAbout = (
  view: ViewTransform,
  nextScale: number,
  focalX: number,
  focalY: number,
  w: number,
  h: number,
  t: PinchTuning
): ViewTransform => {
  const scale = Math.min(t.maxScale, Math.max(t.minScale, nextScale));
  const ratio = scale / view.scale;
  const tx = (focalX - w / 2) * (1 - ratio) + view.tx * ratio;
  const ty = (focalY - h / 2) * (1 - ratio) + view.ty * ratio;
  return { scale, ...clampTranslate(tx, ty, scale, w, h) };
};

/** Drags the picture with the fingers, no further than the clamp allows. */
export const panBy = (view: ViewTransform, dx: number, dy: number, w: number, h: number): ViewTransform => ({
  scale: view.scale,
  ...clampTranslate(view.tx + dx, view.ty + dy, view.scale, w, h),
});

/**
 * Classifies a still-pending two-finger gesture, called with the pair's
 * distance ratio and centroid travel since the anchor.
 *
 * A distance change past the threshold is a pinch wherever it happens. A
 * drag that never pinches depends on the zoom: at 1x it sends the wheel, as
 * it always has; zoomed in it pans the view instead — panning is the only
 * way to reach the rest of the picture, and the wheel remains a two-finger
 * drag at 1x, scroll mode's one-finger drag, and available again the moment
 * you zoom back out. 'zoom' covers both halves of the manipulation — a
 * classified gesture may scale, drag, or both at once, like Photos or Maps.
 */
export const classifyTwoFinger = (
  ratio: number,
  movedPx: number,
  scale: number,
  t: PinchTuning
): 'zoom' | 'scroll' | 'pendingTwo' => {
  if (Math.abs(ratio - 1) > t.pinchThreshold) return 'zoom';
  if (movedPx > t.scrollThresholdPx) return scale > 1 ? 'zoom' : 'scroll';
  return 'pendingTwo';
};
