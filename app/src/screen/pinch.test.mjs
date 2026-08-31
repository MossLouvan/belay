// Unit tests for the two-finger gesture's pure maths: the pan that rides on
// a pinch, scale-about-focal, the translate clamp, and what a two-finger
// drag means at each zoom level.
//
//   cd app && node --test src/screen/pinch.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE } from './model.ts';
import { clampTranslate, classifyTwoFinger, panBy, zoomAbout } from './pinch.ts';

const W = 390;
const H = 700;

/** Stage point -> normalized host coordinate, mirroring viewport's toHost. */
const toHost = (view, x, y) => ({
  x: (x - W / 2 - view.tx) / view.scale / W + 0.5,
  y: (y - H / 2 - view.ty) / view.scale / H + 0.5,
});

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} vs ${b}`);

// --- pan during pinch -------------------------------------------------------

test('an unchanged pinch distance is the identity — the drag must come from the pan', () => {
  const view = { scale: 2.5, tx: 30, ty: -40 };
  const same = zoomAbout(view, 2.5, 60, 500, W, H, GESTURE);
  assert.deepEqual(same, view, 'this identity collapsing the centroid travel was the bug');
});

test('panBy drags the picture with the fingers, frame after frame', () => {
  let view = { scale: 3, tx: 0, ty: 0 };
  view = panBy(view, 25, -10, W, H);
  view = panBy(view, 25, -10, W, H);
  assert.deepEqual(view, { scale: 3, tx: 50, ty: -20 });
});

test('a pinch frame can scale and drag at once without disturbing the other half', () => {
  // Zoom about a focal point, then apply a centroid delta: the pan lands
  // verbatim on top of whatever translate the pinch maths produced.
  const pinched = zoomAbout({ scale: 2, tx: 10, ty: 10 }, 2.4, 100, 200, W, H, GESTURE);
  const dragged = panBy(pinched, 15, 20, W, H);
  assert.equal(dragged.scale, pinched.scale);
  close(dragged.tx, pinched.tx + 15, 'pan x adds to the pinch translate');
  close(dragged.ty, pinched.ty + 20, 'pan y adds to the pinch translate');
});

// --- scale about the focal point --------------------------------------------

test('the picture point under the fingers stays under the fingers as scale changes', () => {
  const view = { scale: 2, tx: 10, ty: -20 };
  const focal = { x: 100, y: 200 };
  const before = toHost(view, focal.x, focal.y);
  const after = toHost(zoomAbout(view, 3, focal.x, focal.y, W, H, GESTURE), focal.x, focal.y);
  close(before.x, after.x, 'focal x is invariant');
  close(before.y, after.y, 'focal y is invariant');
});

test('zoomAbout honours the scale limits', () => {
  const view = { scale: 2, tx: 0, ty: 0 };
  assert.equal(zoomAbout(view, 100, 0, 0, W, H, GESTURE).scale, GESTURE.maxScale);
  assert.equal(zoomAbout(view, 0.1, 0, 0, W, H, GESTURE).scale, GESTURE.minScale);
});

// --- the clamp ---------------------------------------------------------------

test('clampTranslate bounds the picture to half its overhang on each side', () => {
  const maxX = ((3 - 1) * W) / 2;
  const maxY = ((3 - 1) * H) / 2;
  assert.deepEqual(clampTranslate(1e6, -1e6, 3, W, H), { tx: maxX, ty: -maxY });
  assert.deepEqual(clampTranslate(maxX - 1, 5, 3, W, H), { tx: maxX - 1, ty: 5 }, 'inside the bound passes through');
});

test('panning into the edge sticks at the edge instead of showing empty stage', () => {
  const edge = { scale: 2, tx: ((2 - 1) * W) / 2, ty: 0 };
  const pushed = panBy(edge, 500, 0, W, H);
  assert.deepEqual(pushed, edge);
});

test('zoomAbout keeps a corner-focused zoom-out inside the clamp', () => {
  // Zooming out from a far corner would otherwise leave the translate beyond
  // the shrunken bounds for a frame.
  const view = { scale: 6, tx: ((6 - 1) * W) / 2, ty: ((6 - 1) * H) / 2 };
  const out = zoomAbout(view, 1.5, 0, 0, W, H, GESTURE);
  assert.ok(Math.abs(out.tx) <= ((out.scale - 1) * W) / 2 + 1e-9);
  assert.ok(Math.abs(out.ty) <= ((out.scale - 1) * H) / 2 + 1e-9);
});

// --- scale 1: nothing to pan -------------------------------------------------

test('at scale 1 every pan collapses to exactly (0,0) — still, not jittery', () => {
  const flat = { scale: 1, tx: 0, ty: 0 };
  assert.deepEqual(panBy(flat, 40, -3, W, H), flat);
  assert.deepEqual(panBy(flat, -0.5, 900, W, H), flat);
});

// --- classification ----------------------------------------------------------

test('a distance change past the threshold is a pinch at any zoom', () => {
  const past = 1 + GESTURE.pinchThreshold + 0.01;
  assert.equal(classifyTwoFinger(past, 0, 1, GESTURE), 'zoom');
  assert.equal(classifyTwoFinger(1 / past, 0, 4, GESTURE), 'zoom');
});

test('a plain two-finger drag scrolls at 1x, pans when zoomed in', () => {
  const moved = GESTURE.scrollThresholdPx + 1;
  assert.equal(classifyTwoFinger(1, moved, 1, GESTURE), 'scroll', 'the wheel keeps its 1x home');
  assert.equal(classifyTwoFinger(1, moved, 2, GESTURE), 'zoom', 'zoomed in, panning is the only way to the rest of the picture');
});

test('under both thresholds the gesture stays pending — a trio still gets its chance', () => {
  assert.equal(classifyTwoFinger(1.01, GESTURE.scrollThresholdPx - 1, 3, GESTURE), 'pendingTwo');
});
