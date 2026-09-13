// Unit tests for the immersive HUD's orientation latch — the pure toggle and
// the spoken contract on the control.
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
  nextOrientationLock,
  orientationLatchLabel,
  orientationLatchPinned,
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
  assert.match(orientationLatchLabel('free'), /keep the view upright/i);
  assert.match(orientationLatchLabel('portrait'), /rotate/i);
});

test('neither label promises an animation the app no longer has', () => {
  for (const state of ['free', 'portrait']) {
    const label = orientationLatchLabel(state);
    assert.doesNotMatch(label, /flip/i, state);
    assert.doesNotMatch(label, /mascot/i, state);
  }
});

test('pinned is true only while the view is held upright', () => {
  assert.equal(orientationLatchPinned('portrait'), true);
  assert.equal(orientationLatchPinned('free'), false);
});

test('every tap counts — there is no burst guard left to swallow one', async () => {
  const mod = await import('./orientation-lock.ts');
  assert.equal('mascotTapLatches' in mod, false);
  assert.equal('MASCOT_TAP_BURST_GAP_MS' in mod, false);
});
