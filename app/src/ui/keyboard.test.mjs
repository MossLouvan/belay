// Unit tests for the keyboard geometry behind useKeyboardLift.
//
//   cd app && node --test src/ui/keyboard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyboardOverlap, keyboardShown } from './keyboard.ts';

const WINDOW_H = 852; // iPhone 15 Pro points, as a realistic stand-in.

test('a keyboard on screen is shown', () => {
  // iOS keyboardWillChangeFrame, showing: top edge rises above window bottom.
  assert.equal(keyboardShown({ screenY: 506, height: 346 }, WINDOW_H), true);
});

test('the "hidden" frame iOS reports — parked at the window bottom — is not shown', () => {
  assert.equal(keyboardShown({ screenY: WINDOW_H, height: 346 }, WINDOW_H), false);
});

test('a zero-height frame (hardware keyboard attached) is not shown', () => {
  assert.equal(keyboardShown({ screenY: WINDOW_H, height: 0 }, WINDOW_H), false);
});

test('malformed frames count as hidden — the safe default is nothing to avoid', () => {
  assert.equal(keyboardShown(null, WINDOW_H), false);
  assert.equal(keyboardShown(undefined, WINDOW_H), false);
  assert.equal(keyboardShown({ screenY: Number.NaN, height: 346 }, WINDOW_H), false);
  assert.equal(keyboardShown({ screenY: 506, height: Number.NaN }, WINDOW_H), false);
  assert.equal(keyboardShown({ screenY: 506, height: 346 }, Number.NaN), false);
  assert.equal(keyboardShown({ screenY: 506, height: 346 }, 0), false);
});

test('overlap is the intrusion into the view, not the keyboard height', () => {
  // Non-fullscreen screen tab: its bottom edge sits above the tab bar, so
  // the lift is smaller than the keyboard.
  assert.equal(keyboardOverlap(769, 506), 263);
  // Immersive fullscreen: the view reaches the window bottom.
  assert.equal(keyboardOverlap(WINDOW_H, 506), 346);
});

test('a keyboard entirely below the view lifts nothing', () => {
  // Android adjustResize has already shrunk the window above the keyboard.
  assert.equal(keyboardOverlap(506, 506), 0);
  assert.equal(keyboardOverlap(400, 506), 0);
});

test('overlap never goes negative and shrugs off bad numbers', () => {
  assert.equal(keyboardOverlap(Number.NaN, 506), 0);
  assert.equal(keyboardOverlap(769, Number.POSITIVE_INFINITY), 0);
});
