// Unit tests for the three-finger swipe: axis commitment, thresholds,
// fire-once bookkeeping primitives, and the per-platform chords.
//
//   cd app && node --test src/screen/swipe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE, KEYS, keyFor, modsFor } from './model.ts';
import { centroidOf, newGesture, trackedTriple } from './touches.ts';
import { detectSwipe, SWIPE_ACTION_ID } from './swipe.ts';

// The chord resolution the screen tab performs, reproduced with the same
// helpers so the assertions pin what actually reaches the host.
const swipeChord = (direction, mac) => {
  const spec = KEYS.find((key) => key.id === SWIPE_ACTION_ID[direction]);
  assert.ok(spec, `no KeySpec for ${direction}`);
  return { key: keyFor(spec, mac), mods: modsFor(spec, mac) };
};

const T = GESTURE.swipeThresholdPx;

// --- detection --------------------------------------------------------------

test('under the threshold nothing fires, in any direction', () => {
  assert.equal(detectSwipe(T - 1, 0, GESTURE), null);
  assert.equal(detectSwipe(-(T - 1), 0, GESTURE), null);
  assert.equal(detectSwipe(0, -(T - 1), GESTURE), null);
  assert.equal(detectSwipe(0, 0, GESTURE), null);
});

test('a committed horizontal swipe reports where the fingers went', () => {
  assert.equal(detectSwipe(-T, 0, GESTURE), 'left');
  assert.equal(detectSwipe(T, 0, GESTURE), 'right');
  assert.equal(detectSwipe(T, T / GESTURE.swipeAxisRatio, GESTURE), 'right', 'a modest slope is still horizontal');
});

test('three fingers up is the overview; down is deliberately unbound', () => {
  assert.equal(detectSwipe(0, -T, GESTURE), 'up');
  assert.equal(detectSwipe(0, T * 3, GESTURE), null);
});

test('a sloppy diagonal commits to no axis and never fires two actions', () => {
  // Both components past the threshold, neither dominant: keep waiting.
  assert.equal(detectSwipe(T * 2, -T * 2, GESTURE), null);
  assert.equal(detectSwipe(-T * 2, T * 1.9, GESTURE), null);
});

test('scroll- and pinch-sized two-finger movement is far under the swipe threshold', () => {
  // The gestures are separated by finger COUNT in the responder, but the
  // threshold must still dwarf the two-finger classifiers so a swipe is
  // always a deliberate travel, never a twitch.
  assert.ok(GESTURE.swipeThresholdPx > GESTURE.scrollThresholdPx * 3);
  assert.ok(GESTURE.swipeThresholdPx > GESTURE.tapSlopPx * 3);
});

// --- identity tracking ------------------------------------------------------

const touch = (identifier, pageX, pageY) => ({ identifier, pageX, pageY });

test('trackedTriple follows fingers by identity, not array position', () => {
  const g = { ...newGesture(), kind: 'pendingThree', touchA: 7, touchB: 3, touchC: 9 };
  // A fourth finger lands and the array order scrambles: the trio holds.
  const touches = [touch(3, 10, 0), touch(11, 99, 99), touch(9, 20, 0), touch(7, 0, 0)];
  const trio = trackedTriple(touches, g);
  assert.ok(trio);
  assert.deepEqual(trio.map((t) => t.identifier), [7, 3, 9]);
});

test('trackedTriple demands all three — a lifted finger means re-anchor', () => {
  const g = { ...newGesture(), kind: 'pendingThree', touchA: 7, touchB: 3, touchC: 9 };
  assert.equal(trackedTriple([touch(7, 0, 0), touch(3, 0, 0)], g), null);
  assert.equal(trackedTriple([], g), null);
});

test('centroidOf averages and survives the empty case', () => {
  const c = centroidOf([{ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 60, y: 0 }]);
  assert.deepEqual(c, { x: 30, y: 20 });
  assert.deepEqual(centroidOf([]), { x: 0, y: 0 });
});

// --- chords -----------------------------------------------------------------

test('macOS chords use LITERAL Control, dodging the ctrl→cmd remap', () => {
  assert.deepEqual(swipeChord('left', true), { key: 'right', mods: ['rawctrl'] });
  assert.deepEqual(swipeChord('right', true), { key: 'left', mods: ['rawctrl'] });
  assert.deepEqual(swipeChord('up', true), { key: 'up', mods: ['rawctrl'] });
});

test('Windows chords are the virtual-desktop and Task View bindings', () => {
  assert.deepEqual(swipeChord('left', false), { key: 'right', mods: ['win', 'ctrl'] });
  assert.deepEqual(swipeChord('right', false), { key: 'left', mods: ['win', 'ctrl'] });
  assert.deepEqual(swipeChord('up', false), { key: 'tab', mods: ['win'] });
});

test('swiping left travels to the NEXT desktop — content moves with the fingers', () => {
  // The chord for a left swipe presses the RIGHT arrow on both platforms.
  assert.equal(swipeChord('left', true).key, 'right');
  assert.equal(swipeChord('left', false).key, 'right');
});
