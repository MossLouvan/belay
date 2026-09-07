// Unit tests for the desktop route's chrome decisions — the pure half of
// app/(home)/screen.tsx.
//
//   cd app && node --test src/screen/screen-chrome.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentBadge,
  crosshairShown,
  dockAutoHides,
  headerTitle,
  hintVisible,
  isImmersive,
  isLandscape,
  normalizedDeviceSize,
  panelStateShown,
  performanceSummary,
  recordKeyAction,
  shouldClearFullscreen,
  toggleArmedButton,
  typeRowFloats,
} from './screen-chrome.ts';

test('device size is the larger side first, in pixels, whichever way the phone is held', () => {
  const portrait = normalizedDeviceSize({ width: 390, height: 844, scale: 3 });
  const landscape = normalizedDeviceSize({ width: 844, height: 390, scale: 3 });
  assert.deepEqual(portrait, { w: 2532, h: 1170 });
  assert.deepEqual(landscape, portrait, 'rotation must not reshape the virtual display');
});

test('a keyboard shrinking the window height leaves the larger side alone', () => {
  // Sideways, the keyboard eats height only; the max side (width) is untouched.
  const open = normalizedDeviceSize({ width: 844, height: 300, scale: 3 });
  const closed = normalizedDeviceSize({ width: 844, height: 390, scale: 3 });
  assert.equal(open.w, closed.w);
});

test('landscape is strictly wider than tall', () => {
  assert.equal(isLandscape(844, 390), true);
  assert.equal(isLandscape(390, 844), false);
  assert.equal(isLandscape(500, 500), false);
});

test('immersive is gaming, the Full toggle, or sideways', () => {
  assert.equal(isImmersive({ gaming: false, fullscreen: false, landscape: false }), false);
  assert.equal(isImmersive({ gaming: true, fullscreen: false, landscape: false }), true);
  assert.equal(isImmersive({ gaming: false, fullscreen: true, landscape: false }), true);
  assert.equal(isImmersive({ gaming: false, fullscreen: false, landscape: true }), true);
});

test('only a fresh rotation into landscape clears portrait fullscreen', () => {
  const base = { gaming: false, landscape: true, wasLandscape: false, fullscreen: true };
  assert.equal(shouldClearFullscreen(base), true);
  assert.equal(shouldClearFullscreen({ ...base, wasLandscape: true }), false, 'already sideways: nothing new');
  assert.equal(shouldClearFullscreen({ ...base, fullscreen: false }), false, 'nothing to clear');
  assert.equal(shouldClearFullscreen({ ...base, gaming: true }), false, 'gaming keeps the previous Full choice');
  assert.equal(shouldClearFullscreen({ ...base, landscape: false }), false);
});

test('the dock auto-hides only while immersive and idle', () => {
  assert.equal(dockAutoHides({ immersive: true, keyboardOpen: false }), true);
  assert.equal(dockAutoHides({ immersive: false, keyboardOpen: false }), false);
  assert.equal(dockAutoHides({ immersive: true, keyboardOpen: true }), false, 'keyboard panel open');
});

test('the armed one-shot button toggles off when pressed again', () => {
  assert.equal(toggleArmedButton('none', 'right'), 'right');
  assert.equal(toggleArmedButton('right', 'right'), 'none');
  assert.equal(toggleArmedButton('double', 'right'), 'right', 'switching arms the other');
  assert.equal(toggleArmedButton('double', 'double'), 'none');
});

test('the first-run hint waits for the stored flag and stays out of immersive', () => {
  assert.equal(hintVisible({ immersive: false, hintSeen: false, connected: true }), true);
  assert.equal(hintVisible({ immersive: false, hintSeen: null, connected: true }), false, 'still loading');
  assert.equal(hintVisible({ immersive: false, hintSeen: true, connected: true }), false);
  assert.equal(hintVisible({ immersive: true, hintSeen: false, connected: true }), false);
  assert.equal(hintVisible({ immersive: false, hintSeen: false, connected: false }), false);
});

test('the header drops the mDNS suffix and falls back to Screen', () => {
  assert.equal(headerTitle('Studio.local'), 'Studio');
  assert.equal(headerTitle('Studio.LOCAL'), 'Studio');
  assert.equal(headerTitle('desk'), 'desk');
  assert.equal(headerTitle(''), 'Screen');
  assert.equal(headerTitle(undefined), 'Screen');
});

test('the agent badge is a count or nothing', () => {
  assert.equal(agentBadge(0), null);
  assert.equal(agentBadge(3), 3);
});

test('the record key runs start, stop, review', () => {
  assert.equal(recordKeyAction('idle'), 'start');
  assert.equal(recordKeyAction('recording'), 'stop');
  assert.equal(recordKeyAction('ready'), 'review');
});

test('the panel state covers the stage until any picture exists, or when capture is blocked', () => {
  assert.equal(panelStateShown({ captureBlocked: false, frameUri: null, bwp: null }), true);
  assert.equal(panelStateShown({ captureBlocked: false, frameUri: 'data:', bwp: null }), false);
  assert.equal(panelStateShown({ captureBlocked: false, frameUri: null, bwp: { port: 1 } }), false, 'H.264 is a picture');
  assert.equal(panelStateShown({ captureBlocked: true, frameUri: 'data:', bwp: null }), true);
});

test('the crosshair shows in trackpad mode or after a pad touch, only over a picture', () => {
  assert.equal(crosshairShown({ gaming: false, mode: 'trackpad', padCursor: false, hasPicture: true }), true);
  assert.equal(crosshairShown({ gaming: false, mode: 'touch', padCursor: true, hasPicture: true }), true);
  assert.equal(crosshairShown({ gaming: false, mode: 'touch', padCursor: false, hasPicture: true }), false);
  assert.equal(crosshairShown({ gaming: false, mode: 'trackpad', padCursor: false, hasPicture: false }), false);
  assert.equal(crosshairShown({ gaming: true, mode: 'trackpad', padCursor: true, hasPicture: true }), false);
});

test('only iOS floats the type row', () => {
  assert.equal(typeRowFloats('ios'), true);
  assert.equal(typeRowFloats('android'), false);
  assert.equal(typeRowFloats('web'), false);
});

test('the performance summary names the ceiling or Auto', () => {
  assert.equal(performanceSummary({ fps: 60, bitrateMbps: 0, audioEnabled: false, codec: 'h264' }), '60 Hz • Auto • H264');
  assert.equal(performanceSummary({ fps: 120, bitrateMbps: 8, audioEnabled: true, codec: 'hevc' }), '120 Hz • 8 Mbps • HEVC');
});
