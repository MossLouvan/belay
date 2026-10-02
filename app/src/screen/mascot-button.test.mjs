// Unit tests for the movable mascot button's geometry: tap-vs-drag, the
// edge snap, and the clamp that keeps it off the HUD and inside the safe area.
//
//   cd app && node --test src/screen/mascot-button.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampMascot,
  defaultMascotPlacement,
  isMascotDrag,
  MASCOT_BUTTON_SIZE,
  MASCOT_DRAG_THRESHOLD_PX,
  MASCOT_EDGE_MARGIN_PX,
  mascotX,
  snapMascot,
} from './mascot-button.ts';
import { REVEAL_EDGE_PX } from './autohide.ts';

// An iPhone 14 Pro on its side, notch to the left; HUD row at the top.
const LANDSCAPE = Object.freeze({
  width: 844,
  height: 390,
  insets: { top: 0, left: 59, right: 59, bottom: 21 },
  hudTop: 8,
  hudBottom: 8 + 48,
});

test('a tap is any touch that moves less than the threshold', () => {
  assert.equal(isMascotDrag(0, 0), false);
  assert.equal(isMascotDrag(MASCOT_DRAG_THRESHOLD_PX - 1, 0), false);
  assert.equal(isMascotDrag(MASCOT_DRAG_THRESHOLD_PX, 0), true);
  assert.equal(isMascotDrag(4, 5), true, 'diagonal distance counts');
});

test('the default home is the top-right slot the mascot always had', () => {
  const home = defaultMascotPlacement(LANDSCAPE);
  assert.deepEqual(home, { side: 'right', y: LANDSCAPE.hudTop });
  assert.equal(mascotX('right', LANDSCAPE), 844 - 59 - MASCOT_EDGE_MARGIN_PX - MASCOT_BUTTON_SIZE);
  assert.equal(mascotX('left', LANDSCAPE), 59 + MASCOT_EDGE_MARGIN_PX);
});

test('a drop snaps to whichever edge the button centre is nearer', () => {
  assert.equal(snapMascot(100, 200, LANDSCAPE).side, 'left');
  assert.equal(snapMascot(700, 200, LANDSCAPE).side, 'right');
  assert.equal(snapMascot(844 / 2 - MASCOT_BUTTON_SIZE / 2 - 1, 200, LANDSCAPE).side, 'left', 'just left of centre');
});

test('on the left it never covers the Connected pill or the recording strip', () => {
  const dropped = snapMascot(100, 0, LANDSCAPE);
  assert.equal(dropped.y, LANDSCAPE.hudBottom, 'pushed under the HUD block');
  assert.equal(clampMascot({ side: 'left', y: LANDSCAPE.hudTop }, LANDSCAPE).y, LANDSCAPE.hudBottom);
});

test('on the right it may sit in its own HUD slot, but not half over the strip', () => {
  assert.equal(clampMascot({ side: 'right', y: 0 }, LANDSCAPE).y, LANDSCAPE.hudTop, 'not above the row');
  assert.equal(clampMascot({ side: 'right', y: LANDSCAPE.hudTop }, LANDSCAPE).y, LANDSCAPE.hudTop, 'the slot is allowed');
  assert.equal(clampMascot({ side: 'right', y: LANDSCAPE.hudTop + 20 }, LANDSCAPE).y, LANDSCAPE.hudTop, 'inside the band → back to the slot');
  assert.equal(clampMascot({ side: 'right', y: LANDSCAPE.hudBottom }, LANDSCAPE).y, LANDSCAPE.hudBottom, 'just under is fine');
});

test('it never leaves the safe area or sits on the bottom-edge reveal strip', () => {
  const low = clampMascot({ side: 'left', y: 10_000 }, LANDSCAPE);
  const floor = 390 - Math.max(21, REVEAL_EDGE_PX) - MASCOT_EDGE_MARGIN_PX - MASCOT_BUTTON_SIZE;
  assert.equal(low.y, floor);
  // No bottom inset (web): the reveal strip still owns its 24pt band.
  const web = { ...LANDSCAPE, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  assert.equal(clampMascot({ side: 'left', y: 10_000 }, web).y, 390 - REVEAL_EDGE_PX - MASCOT_EDGE_MARGIN_PX - MASCOT_BUTTON_SIZE);
});

test('a screen too short for the rules still yields a finite, in-bounds y', () => {
  const tiny = { ...LANDSCAPE, height: 60 };
  const y = clampMascot({ side: 'left', y: 500 }, tiny).y;
  assert.ok(Number.isFinite(y) && y >= 0);
});

test('one touch target, as the old Controls tab was', () => {
  assert.ok(MASCOT_BUTTON_SIZE >= 44);
});
