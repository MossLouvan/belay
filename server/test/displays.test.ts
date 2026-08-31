// Unit tests for monitor classification.
//
// The cases that matter are the two directions of mistake: calling a monitor
// somebody is using "virtual" (a remote client is then offered a screen it will
// steal), and failing to spot a real virtual display (the feature silently has
// nothing to offer). The fixtures below are real strings from both platforms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyScreens, isVirtualDisplay, screenLabel, type RawScreen } from '../src/displays.js';

function screen(overrides: Partial<RawScreen> = {}): RawScreen {
  return { index: 0, X: 0, Y: 0, W: 1920, H: 1080, primary: true, ...overrides };
}

test('a physical Windows monitor is not virtual', () => {
  const real = screen({
    device: '\\.\DISPLAY1',
    adapter: 'NVIDIA GeForce RTX 2070 SUPER',
    monitor: 'Generic PnP Monitor',
    id: '\\?\DISPLAY#MSI3CA7#5&5ea0c6&0&UID4354#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}',
  });
  assert.equal(isVirtualDisplay(real), false);
});

test('the ROOT# enumerator marks a Windows software display', () => {
  const vdd = screen({
    adapter: 'IddSampleDriver Device',
    monitor: 'Generic PnP Monitor',
    id: '\\?\ROOT#iddsampledriver#0000#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}',
  });
  assert.equal(isVirtualDisplay(vdd), true);
});

test('a virtual display adapter is caught by name when the path is missing', () => {
  // macOS reports no enumerator at all, so the name is the only signal.
  assert.equal(isVirtualDisplay(screen({ adapter: 'Parsec Virtual Display Adapter' })), true);
  assert.equal(isVirtualDisplay(screen({ monitor: 'BetterDisplay Virtual Screen', builtin: false })), true);
});

test('the macOS virtual-display tools are recognised by name', () => {
  // Their exact display names, which is all macOS gives us to go on.
  assert.equal(isVirtualDisplay(screen({ monitor: 'DeskPad Display', builtin: false })), true);
  assert.equal(isVirtualDisplay(screen({ monitor: 'BetterDisplay Dummy', builtin: false })), true);
});

test('the built-in laptop panel is never virtual', () => {
  // Guards the plausible mislabel: "Built-in Retina Display" on a Mac whose
  // adapter string mentions a virtual device would otherwise match by name.
  const builtin = screen({ builtin: true, monitor: 'Built-in Retina Display', adapter: 'Virtual Display Bridge' });
  assert.equal(isVirtualDisplay(builtin), false);
});

test('screens people are actually looking at are not offered for takeover', () => {
  // DisplayLink docks and AirPlay/Sidecar targets are real, visible screens.
  assert.equal(isVirtualDisplay(screen({ monitor: 'DisplayLink Display' })), false);
  assert.equal(isVirtualDisplay(screen({ monitor: 'iPad Pro (AirPlay)' })), false);
});

test('labels prefer the panel name and drop the meaningless default', () => {
  assert.equal(screenLabel(screen({ monitor: 'DELL U2720Q' })), 'DELL U2720Q');
  assert.equal(screenLabel(screen({ index: 1, monitor: 'Generic PnP Monitor' })), 'Display 2');
  assert.equal(screenLabel(screen({ index: 0 })), 'Display 1');
});

test('a virtual display falls back to its adapter name, not a bare number', () => {
  const vdd = screen({ adapter: 'Parsec Virtual Display Adapter', monitor: 'Generic PnP Monitor' });
  assert.equal(screenLabel(vdd), 'Parsec Virtual Display Adapter');
});

test('classifyScreens annotates every entry', () => {
  const info = {
    screens: [
      screen({ index: 0, monitor: 'DELL U2720Q' }),
      screen({ index: 1, primary: false, adapter: 'IddSampleDriver Device' }),
    ],
  };
  const out = classifyScreens(info);
  assert.deepEqual(
    out.screens?.map((s) => [s.index, s.virtualDisplay, s.label]),
    [
      [0, false, 'DELL U2720Q'],
      [1, true, 'IddSampleDriver Device'],
    ],
  );
});

test('a helper that reports no screens passes through untouched', () => {
  // "Cannot enumerate monitors" must stay distinguishable from "has none".
  const info = { primary: { X: 0, Y: 0, W: 1920, H: 1080 } };
  assert.equal(classifyScreens(info as never).screens, undefined);
});
