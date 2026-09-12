// Unit tests for the landscape controls tab's geometry and visibility.
//
//   cd app && node --test src/screen/controls-tab.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROLS_TAB_SIZE,
  controlsTabCoverage,
  controlsTabFrame,
  controlsTabVisible,
  frameContains,
} from './controls-tab.ts';

// An iPhone 14 Pro on its side, notch to the left.
const LANDSCAPE = Object.freeze({ width: 844, height: 390 });
const INSETS = Object.freeze({ top: 0, left: 59 });

test('the tab shows only while immersive, outside gaming, with the bar away', () => {
  assert.equal(controlsTabVisible({ immersive: true, gaming: false, dockShown: false }), true);
  assert.equal(controlsTabVisible({ immersive: true, gaming: false, dockShown: true }), false, 'bar already up');
  assert.equal(controlsTabVisible({ immersive: false, gaming: false, dockShown: false }), false, 'portrait docks the bar');
  assert.equal(controlsTabVisible({ immersive: true, gaming: true, dockShown: false }), false, 'gaming owns the screen');
});

test('it is one full touch target — reachable, not a hairline', () => {
  assert.ok(CONTROLS_TAB_SIZE.height >= 44, 'height clears the 44pt HIG target');
  assert.ok(CONTROLS_TAB_SIZE.width >= 44, 'width clears it too');
});

test('it sits top-left: flush to the safe left edge, in the top half', () => {
  const frame = controlsTabFrame(INSETS);
  assert.equal(frame.left, INSETS.left, 'flush against the safe-area left edge');
  assert.ok(frame.top + frame.height < LANDSCAPE.height / 2, 'entirely in the top half');
  assert.ok(frame.left + frame.width < LANDSCAPE.width / 2, 'entirely in the left half');
});

test('it clears the immersive HUD row above it', () => {
  // The HUD's Connected pill and mascot own the band right under the top inset.
  const HUD_ROW_BOTTOM = 48;
  assert.ok(controlsTabFrame({ top: 0, left: 0 }).top >= HUD_ROW_BOTTOM);
});

test('it does NOT cover the middle of the picture, where a pad drag lives', () => {
  const frame = controlsTabFrame(INSETS);
  assert.equal(frameContains(frame, LANDSCAPE.width / 2, LANDSCAPE.height / 2), false, 'centre');
  assert.equal(frameContains(frame, LANDSCAPE.width - 40, LANDSCAPE.height - 40), false, 'bottom right');
  assert.equal(frameContains(frame, LANDSCAPE.width / 2, frame.top + 10), false, 'same band, middle of the screen');
  assert.equal(frameContains(frame, frame.left + 10, LANDSCAPE.height - 10), false, 'same column, near the bottom');
});

test('a tap in the corner it owns does hit it', () => {
  const frame = controlsTabFrame(INSETS);
  assert.equal(frameContains(frame, frame.left + 5, frame.top + 5), true);
  assert.equal(frameContains(frame, frame.left + frame.width / 2, frame.top + frame.height / 2), true);
});

test('its footprint over the picture stays under 5%', () => {
  const coverage = controlsTabCoverage(controlsTabFrame(INSETS), LANDSCAPE.width, LANDSCAPE.height);
  assert.ok(coverage > 0 && coverage < 0.05, `coverage ${coverage}`);
});

test('coverage of a zero-sized screen is zero, not a division blow-up', () => {
  assert.equal(controlsTabCoverage(controlsTabFrame(INSETS), 0, 0), 0);
});
