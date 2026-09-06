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
  MASCOT_TAP_BURST_GAP_MS,
  mascotAccessibilityLabel,
  mascotTapLatches,
  nextOrientationLock,
} from './orientation-lock.ts';

test('the first tap of a burst latches; the rapid taps that spin the beluga up do not', () => {
  const gap = MASCOT_TAP_BURST_GAP_MS;
  assert.equal(mascotTapLatches(null, 1_000), true, 'the very first tap always latches');
  assert.equal(mascotTapLatches(1_000, 1_000 + gap - 1), false, 'a quick follow-up is spin, not a toggle');
  assert.equal(mascotTapLatches(1_000, 1_000 + gap), true, 'a pause ends the burst');
  assert.equal(mascotTapLatches(1_000, 5_000), true);
});

test('a sustained burst never flaps the latch, however long it runs', () => {
  const taps = Array.from({ length: 40 }, (_, i) => 1_000 + i * 150);
  const latched = taps.filter((at, i) => mascotTapLatches(i === 0 ? null : taps[i - 1], at));
  assert.deepEqual(latched, [1_000], 'exactly one latch for the whole burst');
});

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
