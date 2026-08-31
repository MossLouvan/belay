// Unit tests for monitor selection on the remote-screen tab.
//
//   cd app && node --test src/screen/monitors.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.
//
// Why this exists: the host captures ONE monitor and maps normalized input
// onto that SAME monitor's rect within the virtual desktop. The C# side
// (TetherHost.cs MoveAbsolute) computes, for virtual desktop V and selected
// monitor S:
//
//   vx = S.X + nx * S.W
//   dx = round((vx - V.X) / (V.W - 1) * 65535)
//
// Worked example — two 1920x1080 monitors, primary on the RIGHT:
//   V = { X:0, W:3840 }, S = { X:1920, W:1920 }, tap at nx = 0.5
//   vx = 1920 + 0.5*1920 = 2880
//   dx = round(2880 / 3839 * 65535) = 49164  -> centre of the RIGHT monitor.
// The pre-fix mapping was dx = 0.5*65535 = 32768 — the seam between the
// monitors, one full screen left of what the phone was showing. The app's
// job, tested here, is to always name the monitor it is viewing so the host
// picks the right S.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  screensOf,
  defaultScreenIndex,
  resolveScreenIndex,
  nextScreenIndex,
  monitorLabel,
  monitorDescription,
  virtualScreen,
} from './monitors.ts';

// Primary on the right, matching the worked example above.
const twoMonitors = {
  screens: [
    { index: 0, X: 0, Y: 0, W: 1920, H: 1080, primary: false },
    { index: 1, X: 1920, Y: 0, W: 1920, H: 1080, primary: true },
  ],
};

// ---- the headline behaviour ---------------------------------------------

test('the default monitor is the primary, wherever it sits in the list', () => {
  const screens = screensOf(twoMonitors);
  // The primary is index 1 (the right-hand monitor). Defaulting to 0 here
  // would show one monitor and click on the other — the original bug.
  assert.equal(defaultScreenIndex(screens), 1);
});

test('an old host with no screens list resolves to undefined (send nothing)', () => {
  const screens = screensOf({});
  assert.deepEqual(screens, []);
  assert.equal(defaultScreenIndex(screens), undefined);
  assert.equal(resolveScreenIndex(0, screens), undefined, 'never send an index the host cannot check');
  assert.equal(resolveScreenIndex(undefined, screens), undefined);
});

test('a valid selection is kept; a vanished one falls back to the primary', () => {
  const screens = screensOf(twoMonitors);
  assert.equal(resolveScreenIndex(0, screens), 0, 'the non-primary monitor stays selectable');
  assert.equal(resolveScreenIndex(1, screens), 1);
  // Monitor 2 was unplugged between polls: fall back rather than aim input at
  // a monitor that no longer exists.
  assert.equal(resolveScreenIndex(7, screens), 1);
});

// ---- sanitizing the untrusted list ---------------------------------------

test('screensOf drops malformed entries instead of repairing them', () => {
  const screens = screensOf({
    screens: [
      null,
      'nope',
      { index: -1, W: 100, H: 100, primary: false },
      { index: 1.5, W: 100, H: 100, primary: false },
      { W: 100, H: 100, primary: true }, // no index at all
      { index: 0, X: 0, Y: 0, W: 1920, H: 1080, primary: true },
    ],
  });
  assert.equal(screens.length, 1);
  assert.equal(screens[0].index, 0);
  assert.equal(screens[0].primary, true);
});

test('screensOf ignores duplicate indexes', () => {
  const screens = screensOf({
    screens: [
      { index: 0, W: 800, H: 600, primary: true },
      { index: 0, W: 999, H: 999, primary: false },
    ],
  });
  assert.equal(screens.length, 1);
  assert.equal(screens[0].w, 800, 'first entry wins');
});

test('screensOf zeroes rubbish dimensions rather than passing them through', () => {
  const screens = screensOf({ screens: [{ index: 0, W: NaN, H: -4, primary: true }] });
  assert.deepEqual(screens, [{ index: 0, primary: true, w: 0, h: 0, virtual: false, name: '' }]);
});

test('screensOf carries the host virtual-display verdict and name', () => {
  const screens = screensOf({
    screens: [
      { index: 0, W: 1920, H: 1080, primary: true, label: 'DELL U2720Q' },
      { index: 1, W: 1920, H: 1080, primary: false, virtualDisplay: true, label: 'Parsec Virtual Display Adapter' },
    ],
  });
  assert.deepEqual(screens.map((s) => [s.virtual, s.name]), [
    [false, 'DELL U2720Q'],
    [true, 'Parsec Virtual Display Adapter'],
  ]);
});

test('a host that claims nothing is never read as claiming virtual', () => {
  // An older host sends neither field; a hostile one may send junk in them.
  const screens = screensOf({
    screens: [
      { index: 0, W: 800, H: 600, primary: true },
      { index: 1, W: 800, H: 600, primary: false, virtualDisplay: 'yes', label: 42 },
    ],
  });
  assert.deepEqual(screens.map((s) => [s.virtual, s.name]), [[false, ''], [false, '']]);
  assert.equal(virtualScreen(screens), undefined);
});

test('virtualScreen finds the first virtual display, or none', () => {
  const screens = screensOf({
    screens: [
      { index: 0, W: 800, H: 600, primary: true },
      { index: 1, W: 800, H: 600, primary: false, virtualDisplay: true, label: 'Virtual Display' },
      { index: 2, W: 800, H: 600, primary: false, virtualDisplay: true, label: 'Second Virtual' },
    ],
  });
  assert.equal(virtualScreen(screens)?.index, 1);
});

test('monitorDescription names the display, falling back to the terse label', () => {
  const [named, unnamed, bare] = screensOf({
    screens: [
      { index: 0, W: 1, H: 1, primary: true, label: 'DELL U2720Q' },
      { index: 1, W: 1, H: 1, primary: false, virtualDisplay: true },
      { index: 2, W: 1, H: 1, primary: false },
    ],
  });
  assert.equal(monitorDescription(named), '1 (main) · DELL U2720Q');
  assert.equal(monitorDescription(unnamed), '2 · Virtual display');
  assert.equal(monitorDescription(bare), '3');
});

test('screensOf handles a null info and a non-array screens field', () => {
  assert.deepEqual(screensOf(null), []);
  assert.deepEqual(screensOf({ screens: 'all of them' }), []);
});

test('a list without any primary still yields a default (the first entry)', () => {
  const screens = screensOf({
    screens: [
      { index: 2, W: 1024, H: 768, primary: false },
      { index: 3, W: 1024, H: 768, primary: false },
    ],
  });
  assert.equal(defaultScreenIndex(screens), 2);
  assert.equal(resolveScreenIndex(undefined, screens), 2);
});

// ---- tap-to-cycle ----------------------------------------------------------

test('nextScreenIndex cycles through the list in order and wraps', () => {
  const screens = screensOf(twoMonitors);
  assert.equal(nextScreenIndex(0, screens), 1);
  assert.equal(nextScreenIndex(1, screens), 0, 'wraps back to the first listed');
});

test('nextScreenIndex resolves a stale or absent selection before stepping', () => {
  const screens = screensOf(twoMonitors);
  // No selection resolves to the primary (index 1), so the next is 0.
  assert.equal(nextScreenIndex(undefined, screens), 0);
  // A vanished monitor also resolves to the primary first.
  assert.equal(nextScreenIndex(7, screens), 0);
});

test('nextScreenIndex on one monitor stays there; on none stays undefined', () => {
  const one = screensOf({ screens: [{ index: 0, W: 800, H: 600, primary: true }] });
  assert.equal(nextScreenIndex(0, one), 0);
  assert.equal(nextScreenIndex(undefined, screensOf({})), undefined);
});

// ---- labels ---------------------------------------------------------------

test('monitor labels are 1-based and mark the primary', () => {
  const screens = screensOf(twoMonitors);
  assert.equal(monitorLabel(screens[0]), '1');
  assert.equal(monitorLabel(screens[1]), '2 (main)');
});

// ---- the coordinate formula, mirrored in JS -------------------------------

test('the host absolute-coordinate formula lands on the selected monitor', () => {
  // Mirrors TetherHost.cs MoveAbsolute so the mapping can be reasoned about
  // (and reviewed) without a Windows box.
  const toAbsolute = (n, S, V, axis) => {
    const [pos, size] = axis === 'x' ? [S.X, S.W] : [S.Y, S.H];
    const [vpos, vsize] = axis === 'x' ? [V.X, V.W] : [V.Y, V.H];
    const v = pos + n * size;
    const d = Math.round(((v - vpos) / (vsize - 1)) * 65535);
    return Math.max(0, Math.min(65535, d)); // C# clamps the same way
  };
  const V = { X: 0, Y: 0, W: 3840, H: 1080 };
  const left = { X: 0, Y: 0, W: 1920, H: 1080 };
  const right = { X: 1920, Y: 0, W: 1920, H: 1080 }; // the primary

  // Centre tap while viewing the right (primary) monitor: 49164, NOT the
  // pre-fix 32768 which was the seam between the monitors.
  assert.equal(toAbsolute(0.5, right, V, 'x'), 49164);
  // Left edge of the viewed frame is that monitor's left edge, not virtual 0.
  assert.equal(toAbsolute(0, right, V, 'x'), Math.round((1920 / 3839) * 65535));
  // The same taps aimed at the left monitor stay on the left monitor.
  assert.equal(toAbsolute(0, left, V, 'x'), 0);
  assert.equal(toAbsolute(0.5, left, V, 'x'), Math.round((960 / 3839) * 65535));
  // Vertical axis: n=1 maps one past the last pixel row and is clamped to
  // 65535, the desktop's bottom edge — never wrapped or rejected.
  assert.equal(toAbsolute(1, right, V, 'y'), 65535);
});
