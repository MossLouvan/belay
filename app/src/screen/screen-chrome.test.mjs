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
  immersiveStageOffset,
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

test('rotating back upright from a landscape fullscreen leaves the chrome layout', () => {
  // Landscape IS the fullscreen gesture, so coming back upright must not land
  // in an immersive portrait the user never chose.
  const base = { gaming: false, landscape: false, wasLandscape: true, fullscreen: false };
  assert.equal(shouldClearFullscreen(base), false, 'nothing was toggled: nothing to clear');
  assert.equal(isImmersive({ gaming: false, fullscreen: false, landscape: false }), false);
  // And if a Full choice somehow survived the trip sideways (gaming held it),
  // the portrait it returns to is immersive — which is the state framed below.
  assert.equal(isImmersive({ gaming: false, fullscreen: true, landscape: false }), true);
});

test('an immersive stage shorter than the safe area is centered in it, not pinned to the top', () => {
  // The founder's bug: fullscreen, phone upright, 16:9 desktop — the picture
  // used to sit at y=0 with its top slice behind the Dynamic Island and 600pt
  // of black under it.
  const box = { boxH: 844, stageH: 252, insetTop: 59, insetBottom: 34 };
  const offset = immersiveStageOffset({ immersive: true, ...box });
  const safeH = 844 - 59 - 34;
  assert.equal(offset, 59 + (safeH - 252) / 2);
  assert.ok(offset >= 59, 'clear of the status bar and the notch');
  assert.ok(offset + 252 <= 844 - 34, 'and clear of the home indicator');
});

test('the chrome layout is never offset — the panel stays top-aligned', () => {
  // Centering the PORTRAIT CHROME panel is the "tap → screen on bottom half"
  // bug: its pills and pad are positioned off stage.h from the panel's top.
  assert.equal(immersiveStageOffset({ immersive: false, boxH: 600, stageH: 220, insetTop: 59, insetBottom: 34 }), 0);
});

test('a stage that already fills the safe area is left edge to edge', () => {
  // Every landscape one: the picture is meant to bleed under the notch.
  assert.equal(
    immersiveStageOffset({ immersive: true, boxH: 390, stageH: 390, insetTop: 0, insetBottom: 21 }),
    0,
  );
  assert.equal(
    immersiveStageOffset({ immersive: true, boxH: 844, stageH: 900, insetTop: 59, insetBottom: 34 }),
    0,
    'a taller-than-safe stage is never pushed further down',
  );
});

test('an unmeasured panel or stage offsets by nothing', () => {
  // The first frame after a rotation, before onLayout has reported the new box.
  assert.equal(immersiveStageOffset({ immersive: true, boxH: 0, stageH: 0, insetTop: 59, insetBottom: 34 }), 0);
  assert.equal(immersiveStageOffset({ immersive: true, boxH: 844, stageH: 0, insetTop: 59, insetBottom: 34 }), 0);
  assert.equal(immersiveStageOffset({ immersive: true, boxH: 0, stageH: 252, insetTop: 59, insetBottom: 34 }), 0);
});

test('insets are never allowed to pull the stage upward', () => {
  // A negative inset (a bad measurement) must not become a negative margin
  // that hides the picture off the top of the display.
  const offset = immersiveStageOffset({ immersive: true, boxH: 844, stageH: 252, insetTop: -20, insetBottom: -20 });
  assert.ok(offset >= 0);
  assert.equal(offset, (844 - 252) / 2);
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
