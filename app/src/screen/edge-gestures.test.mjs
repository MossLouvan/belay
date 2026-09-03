// Unit tests for edge gesture detection: 2-finger swipes from screen edges
// that trigger OS-level actions like Notification Center.
//
//   cd app && node --test src/screen/edge-gestures.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectEdgeZone, detectEdgeGesture, edgeGestureToAction } from './edge-gestures.ts';
import { GESTURE, KEYS, keyFor, modsFor } from './model.ts';

const STAGE_W = 400;
const STAGE_H = 800;

const TUNING = {
  edgeThresholdPx: GESTURE.edgeThresholdPx,
  cornerThresholdPx: GESTURE.cornerThresholdPx,
  edgeSwipeThresholdPx: GESTURE.edgeSwipeThresholdPx,
};

// --- edge zone detection ----------------------------------------------------

test('detectEdgeZone identifies top edge when within threshold', () => {
  assert.equal(detectEdgeZone(200, 30, STAGE_W, STAGE_H, TUNING), 'top');
  assert.equal(detectEdgeZone(200, 59, STAGE_W, STAGE_H, TUNING), 'top');
});

test('detectEdgeZone identifies corners when within corner threshold', () => {
  assert.equal(detectEdgeZone(40, 40, STAGE_W, STAGE_H, TUNING), 'top-left');
  assert.equal(detectEdgeZone(360, 40, STAGE_W, STAGE_H, TUNING), 'top-right');
});

test('detectEdgeZone identifies left and right edges', () => {
  assert.equal(detectEdgeZone(30, 400, STAGE_W, STAGE_H, TUNING), 'left');
  assert.equal(detectEdgeZone(370, 400, STAGE_W, STAGE_H, TUNING), 'right');
});

test('detectEdgeZone returns none for center touches', () => {
  assert.equal(detectEdgeZone(200, 400, STAGE_W, STAGE_H, TUNING), 'none');
  assert.equal(detectEdgeZone(200, 100, STAGE_W, STAGE_H, TUNING), 'none');
});

test('corners take precedence over edges', () => {
  // A touch at (50, 50) is within both corner and edge thresholds
  // but should be classified as corner
  assert.equal(detectEdgeZone(50, 50, STAGE_W, STAGE_H, TUNING), 'top-left');
});

// --- edge gesture detection -------------------------------------------------

test('edge gesture requires minimum travel distance', () => {
  const startX = 30;
  const startY = 30;
  
  // Under threshold - should not trigger
  const tooShort = detectEdgeGesture(startX, startY, 0, 20, STAGE_W, STAGE_H, TUNING);
  assert.equal(tooShort, null);
  
  // Above threshold - should trigger
  const longEnough = detectEdgeGesture(startX, startY, 0, 50, STAGE_W, STAGE_H, TUNING);
  assert.ok(longEnough);
  assert.equal(longEnough.zone, 'top-left');
  assert.equal(longEnough.direction, 'down');
});

test('edge gesture from top detects downward swipe', () => {
  const result = detectEdgeGesture(200, 30, 0, 80, STAGE_W, STAGE_H, TUNING);
  assert.ok(result);
  assert.equal(result.zone, 'top');
  assert.equal(result.direction, 'down');
});

test('edge gesture detects primary direction', () => {
  // Primarily horizontal
  const horizontal = detectEdgeGesture(30, 400, 80, 20, STAGE_W, STAGE_H, TUNING);
  assert.ok(horizontal);
  assert.equal(horizontal.direction, 'right');
  
  // Primarily vertical
  const vertical = detectEdgeGesture(30, 30, 20, 80, STAGE_W, STAGE_H, TUNING);
  assert.ok(vertical);
  assert.equal(vertical.direction, 'down');
});

test('non-edge touches never produce edge gestures', () => {
  const result = detectEdgeGesture(200, 400, 0, 100, STAGE_W, STAGE_H, TUNING);
  assert.equal(result, null);
});

// --- action mapping ---------------------------------------------------------

test('edgeGestureToAction maps top edge downward swipe to notification center', () => {
  const gesture = { zone: 'top', direction: 'down' };
  assert.equal(edgeGestureToAction(gesture), 'NotifyCenter');
});

test('edgeGestureToAction maps top-left corner downward swipe to notification center', () => {
  const gesture = { zone: 'top-left', direction: 'down' };
  assert.equal(edgeGestureToAction(gesture), 'NotifyCenter');
});

test('edgeGestureToAction maps top-right corner downward swipe to notification center', () => {
  const gesture = { zone: 'top-right', direction: 'down' };
  assert.equal(edgeGestureToAction(gesture), 'NotifyCenter');
});

test('edgeGestureToAction returns null for unmapped gestures', () => {
  // Upward from top edge - not mapped
  assert.equal(edgeGestureToAction({ zone: 'top', direction: 'up' }), null);
  
  // From left edge - not mapped yet
  assert.equal(edgeGestureToAction({ zone: 'left', direction: 'right' }), null);
});

// --- keyboard chord resolution ----------------------------------------------

const actionChord = (actionId, mac) => {
  const spec = KEYS.find((key) => key.id === actionId);
  assert.ok(spec, `no KeySpec for ${actionId}`);
  return { key: keyFor(spec, mac), mods: modsFor(spec, mac) };
};

test('NotifyCenter maps to Win+A on Windows', () => {
  const chord = actionChord('NotifyCenter', false);
  assert.equal(chord.key, 'a');
  assert.deepEqual(chord.mods, ['win']);
});

test('NotifyCenter maps to Ctrl+Cmd+Up on macOS', () => {
  const chord = actionChord('NotifyCenter', true);
  assert.equal(chord.key, 'up');
  assert.deepEqual(chord.mods, ['rawctrl', 'cmd']);
});

test('ShowDesktop maps correctly on both platforms', () => {
  // Windows: Win+D
  const winChord = actionChord('ShowDesktop', false);
  assert.equal(winChord.key, 'd');
  assert.deepEqual(winChord.mods, ['win']);
  
  // macOS: F11
  const macChord = actionChord('ShowDesktop', true);
  assert.equal(macChord.key, 'f11');
  assert.deepEqual(macChord.mods, []);
});

// --- integration with swipe detection --------------------------------------

test('edge swipe threshold is smaller than 3-finger swipe threshold', () => {
  // Edge gestures should be easier to trigger than desktop-switching swipes
  // because they're anchored to a physical edge (no accidental triggers)
  assert.ok(GESTURE.edgeSwipeThresholdPx < GESTURE.swipeThresholdPx);
});

test('edge detection threshold is reasonable for phone screens', () => {
  // 60px should be about 15% of a typical 400px phone width
  // Enough to clearly be "from the edge" but not so large as to be hard to trigger
  assert.ok(GESTURE.edgeThresholdPx >= 40);
  assert.ok(GESTURE.edgeThresholdPx <= 80);
});
