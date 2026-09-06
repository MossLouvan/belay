// Unit tests for the mascot's orientation latch — the pure toggle and the
// spoken contract on the avatar.
//
//   cd app && node --test src/screen/orientation-lock.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules (the expo-screen-orientation side effect lives apart in
// orientation-native.ts precisely so this file can run under node).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ORIENTATION_LOCK,
  mascotAccessibilityLabel,
  nextOrientationLock,
} from './orientation-lock.ts';

test('the app starts free — rotation belongs to the device', () => {
  assert.equal(DEFAULT_ORIENTATION_LOCK, 'free');
});

test('the latch is a two-state toggle', () => {
  assert.equal(nextOrientationLock('free'), 'portrait');
  assert.equal(nextOrientationLock('portrait'), 'free');
});

test('two taps land back where they started', () => {
  assert.equal(nextOrientationLock(nextOrientationLock('free')), 'free');
  assert.equal(nextOrientationLock(nextOrientationLock('portrait')), 'portrait');
});

test('the label names the NEXT action, not the current state', () => {
  // Free: the tap will pin the view upright.
  assert.match(mascotAccessibilityLabel('free'), /keep the view upright/);
  // Pinned: the tap will free rotation again.
  assert.match(mascotAccessibilityLabel('portrait'), /rotate again/);
});

test('both labels name the mascot and its flip', () => {
  for (const state of ['free', 'portrait']) {
    const label = mascotAccessibilityLabel(state);
    assert.match(label, /Belay mascot/, state);
    assert.match(label, /flip/, state);
  }
});
