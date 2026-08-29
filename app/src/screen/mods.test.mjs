// Unit tests for the sticky-modifier latch on the remote-screen key bar.
//
//   cd app && node --test src/screen/mods.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDLE_MODS,
  DOUBLE_TAP_MS,
  STICKY_MODS,
  tapMod,
  releaseLatched,
  activeMods,
  anyActive,
  modNamesForHost,
} from './mods.ts';

test('a single tap latches; the latch is spent by the next key', () => {
  let s = tapMod(IDLE_MODS, 'ctrl', 1000);
  assert.equal(s.phases.ctrl, 'latched');
  assert.deepEqual(activeMods(s), ['ctrl']);

  s = releaseLatched(s);
  assert.equal(s.phases.ctrl, 'off');
  assert.deepEqual(activeMods(s), []);
});

test('a second slow tap simply un-latches', () => {
  let s = tapMod(IDLE_MODS, 'shift', 1000);
  s = tapMod(s, 'shift', 1000 + DOUBLE_TAP_MS + 1);
  assert.equal(s.phases.shift, 'off');
});

test('a double-tap locks, and a lock survives keys but not a third tap', () => {
  let s = tapMod(IDLE_MODS, 'alt', 1000);
  s = tapMod(s, 'alt', 1000 + DOUBLE_TAP_MS); // exactly on the window edge: still a double
  assert.equal(s.phases.alt, 'locked');

  // Keys are sent while locked: the lock holds.
  s = releaseLatched(s);
  assert.equal(s.phases.alt, 'locked');
  assert.deepEqual(activeMods(s), ['alt']);

  // A third tap always clears.
  s = tapMod(s, 'alt', 5000);
  assert.equal(s.phases.alt, 'off');
});

test('a quick tap on a DIFFERENT modifier is not a double', () => {
  let s = tapMod(IDLE_MODS, 'ctrl', 1000);
  s = tapMod(s, 'shift', 1010);
  // Shift's first tap latches it; a fast follow-up on shift itself locks it.
  assert.equal(s.phases.shift, 'latched');
  s = tapMod(s, 'shift', 1020);
  assert.equal(s.phases.shift, 'locked');
  // Ctrl was untouched throughout.
  assert.equal(s.phases.ctrl, 'latched');
});

test('releaseLatched clears every latch at once but keeps every lock', () => {
  let s = tapMod(IDLE_MODS, 'ctrl', 1000);
  s = tapMod(s, 'ctrl', 1100); // locked
  s = tapMod(s, 'shift', 2000); // latched
  s = tapMod(s, 'win', 3000); // latched
  s = releaseLatched(s);
  assert.deepEqual(s.phases, { ctrl: 'locked', alt: 'off', shift: 'off', win: 'off' });
});

test('releaseLatched with nothing latched returns the SAME object (setState bail-out)', () => {
  assert.equal(releaseLatched(IDLE_MODS), IDLE_MODS);
  // With only a lock in force it must still return a new object only if
  // something actually changed — here lastTap is non-null, so it normalizes.
  let s = tapMod(IDLE_MODS, 'ctrl', 1000);
  s = tapMod(s, 'ctrl', 1100);
  const released = releaseLatched(s);
  assert.equal(released.lastTap, null);
  assert.equal(releaseLatched(released), released, 'a second release is a no-op by identity');
});

test('activeMods reports in the fixed display/send order', () => {
  let s = tapMod(IDLE_MODS, 'win', 1000);
  s = tapMod(s, 'ctrl', 2000);
  assert.deepEqual(activeMods(s), ['ctrl', 'win']);
  assert.equal(anyActive(s), true);
  assert.equal(anyActive(IDLE_MODS), false);
});

test('host wire names: win becomes cmd on macOS only', () => {
  assert.deepEqual(modNamesForHost(['ctrl', 'win'], false), ['ctrl', 'win']);
  assert.deepEqual(modNamesForHost(['ctrl', 'win'], true), ['ctrl', 'cmd']);
  assert.deepEqual(modNamesForHost([], true), []);
});

test('the sticky set is exactly the four OS modifiers', () => {
  assert.deepEqual([...STICKY_MODS], ['ctrl', 'alt', 'shift', 'win']);
});

test('a stale lastTap (clock went backwards) never counts as a double', () => {
  let s = tapMod(IDLE_MODS, 'ctrl', 5000);
  // Second tap "before" the first: treated as a plain tap -> un-latch.
  s = tapMod(s, 'ctrl', 4000);
  assert.equal(s.phases.ctrl, 'off');
});
