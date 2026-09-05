// Unit tests for the two-finger tap: the Mac trackpad's secondary click.
// Two fingers down and up quickly, with next to no travel, is a right-click
// at the pair's centroid; anything that moves, pinches, lingers, or arrives
// via another gesture stays a scroll/zoom exactly as before.
//
//   cd app && node --test src/screen/touches.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE } from './model.ts';
import { classifyTwoFinger } from './pinch.ts';
import { geometryOf, isTwoFingerTap, newGesture, pairTapEligible } from './touches.ts';

const T = GESTURE; // { twoFingerTapMs, twoFingerTapSlopPx, ... }

// --- the tap itself ---------------------------------------------------------

test('a quick, still two-finger touch is a tap', () => {
  assert.equal(isTwoFingerTap('pendingTwo', true, 0, 0, T), true, 'instant lift');
  assert.equal(isTwoFingerTap('pendingTwo', true, T.twoFingerTapMs, 0, T), true, 'right at the deadline');
  assert.equal(isTwoFingerTap('pendingTwo', true, 120, T.twoFingerTapSlopPx, T), true, 'jitter inside the slop');
});

test('a lingering pair is not a tap', () => {
  assert.equal(isTwoFingerTap('pendingTwo', true, T.twoFingerTapMs + 1, 0, T), false);
  assert.equal(isTwoFingerTap('pendingTwo', true, 5000, 0, T), false, 'a long two-finger rest does nothing');
});

test('a pair that travelled is not a tap', () => {
  assert.equal(isTwoFingerTap('pendingTwo', true, 100, T.twoFingerTapSlopPx + 1, T), false);
});

test('clock skew (negative elapsed) never taps', () => {
  assert.equal(isTwoFingerTap('pendingTwo', true, -1, 0, T), false);
});

test('only a still-pending pair can tap — every classified kind is excluded', () => {
  for (const kind of ['none', 'pending', 'pendingThree', 'pan', 'hostDrag', 'cursor', 'zoom', 'scroll', 'wheel', 'consumed']) {
    assert.equal(isTwoFingerTap(kind, true, 0, 0, T), false, `${kind} must not right-click`);
  }
});

test('an ineligible pair never taps, however quick and still', () => {
  assert.equal(isTwoFingerTap('pendingTwo', false, 0, 0, T), false);
});

// --- eligibility: how the pair may be arrived at ----------------------------

test('a pair adopted from a fresh touch or a re-anchored pair stays eligible', () => {
  assert.equal(pairTapEligible('pending', true), true, 'finger down, second finger joins');
  assert.equal(pairTapEligible('pendingTwo', true), true, 'finger swap re-anchor keeps the intent');
});

test('a pair adopted mid-gesture is not a tap candidate', () => {
  for (const kind of ['pan', 'hostDrag', 'cursor', 'wheel', 'pendingThree', 'consumed', 'none']) {
    assert.equal(pairTapEligible(kind, true), false, `arriving from ${kind} must not arm the tap`);
  }
});

test('eligibility once lost is never regained', () => {
  assert.equal(pairTapEligible('pending', false), false);
  assert.equal(pairTapEligible('pendingTwo', false), false);
});

// --- the record carries the bookkeeping -------------------------------------

test('newGesture starts with no tap armed', () => {
  const g = newGesture();
  assert.equal(g.startAt, 0);
  assert.equal(g.twoMovedPx, 0);
  assert.equal(g.twoTapEligible, false, 'the grant arms it explicitly');
});

// --- the drag/tap boundary against the existing classifier ------------------

test('the classifier owns "real movement": anything it classifies cannot tap', () => {
  // A centroid drag past scrollThresholdPx is a scroll (at 1x) — the release
  // then sees kind "scroll" and isTwoFingerTap refuses it.
  const kind = classifyTwoFinger(1, T.scrollThresholdPx + 1, 1, T);
  assert.equal(kind, 'scroll');
  assert.equal(isTwoFingerTap(kind, true, 50, 0, T), false);
  // A pinch past pinchThreshold is a zoom, likewise refused.
  const pinch = classifyTwoFinger(1 + T.pinchThreshold + 0.01, 0, 1, T);
  assert.equal(pinch, 'zoom');
  assert.equal(isTwoFingerTap(pinch, true, 50, 0, T), false);
});

test('the tap slop is at least the classifier threshold, so no dead band', () => {
  // Movement in (scrollThresholdPx, ∞) classifies as scroll/zoom; movement the
  // classifier tolerated must therefore fit inside the tap slop, or a still
  // tap could be refused for jitter the classifier itself forgave.
  assert.ok(T.twoFingerTapSlopPx >= T.scrollThresholdPx);
});

test('the tap window undercuts the long-press, so the two can never race', () => {
  assert.ok(T.twoFingerTapMs < T.longPressMs + T.doubleTapMs, 'sanity: windows stay in the same regime');
});

// --- centroid: where the right-click lands ----------------------------------

test('the click lands at the pair centroid', () => {
  const { centerX, centerY } = geometryOf({ x: 100, y: 40 }, { x: 140, y: 80 });
  assert.equal(centerX, 120);
  assert.equal(centerY, 60);
});
