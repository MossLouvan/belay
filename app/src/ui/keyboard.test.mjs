// Unit tests for the keyboard geometry behind useKeyboardLift.
//
//   cd app && node --test src/ui/keyboard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearsKeyboard, keyboardInset, keyboardOverlap, keyboardShown } from './keyboard.ts';

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

// --- keyboardInset: the lift a surface holds, safe area absorbed -----------

test('no overlap means no inset — a keyboard below the surface changes nothing', () => {
  assert.equal(keyboardInset(0), 0);
  assert.equal(keyboardInset(0, 34), 0);
});

test('without a safe area the inset is the overlap', () => {
  assert.equal(keyboardInset(291), 291);
});

test('the home-indicator inset is absorbed, not stacked — the keyboard covers it', () => {
  // Composer sits ON the keys, not 34pt above them.
  assert.equal(keyboardInset(291, 34), 257);
});

test('a safe area taller than the overlap falls back to zero, never negative', () => {
  assert.equal(keyboardInset(20, 34), 0);
});

test('a negative or nonsense safe area is ignored rather than inflating the lift', () => {
  assert.equal(keyboardInset(291, -50), 291);
  assert.equal(keyboardInset(291, Number.NaN), 291);
});

test('a nonsense overlap yields no inset — the safe default is to leave layout alone', () => {
  assert.equal(keyboardInset(Number.NaN, 34), 0);
  assert.equal(keyboardInset(-10), 0);
});

// --- clearsKeyboard: is that control still tappable? -----------------------

test('a control above the keyboard clears it', () => {
  // Allow / Deny bottom at 500 on a 852pt phone, keyboard top at 506.
  assert.equal(clearsKeyboard(500, 506), true);
});

test('a control resting exactly on the keyboard edge still clears it', () => {
  assert.equal(clearsKeyboard(506, 506), true);
});

test('a control under the keyboard does not clear it — the Allow/Deny bug', () => {
  assert.equal(clearsKeyboard(620, 506), false);
});

test('no keyboard on screen means every control clears', () => {
  assert.equal(clearsKeyboard(620, Number.POSITIVE_INFINITY), true);
});

test('an unmeasurable control is reported as blocked, not as fine', () => {
  assert.equal(clearsKeyboard(Number.NaN, 506), false);
});
