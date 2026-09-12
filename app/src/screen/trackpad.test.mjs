// Unit tests for the deadspace trackpad's pure decisions.
//
//   cd app && node --test src/screen/trackpad.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAD_BOTTOM_PX,
  PAD_CURSOR_LINGER_MS,
  PAD_HINT_MIN_PX,
  PAD_MIN_PX,
  PAD_TOP_GAP_PX,
  padGapBelow,
  padMounted,
  padRect,
  showsPadHint,
} from './trackpad.ts';

test('the gap is the panel minus the stage, floored at zero', () => {
  assert.equal(padGapBelow(600, 400), 200);
  assert.equal(padGapBelow(400, 400), 0);
  assert.equal(padGapBelow(300, 400), 0, 'a stage taller than its box is no gap');
  assert.equal(padGapBelow(0, 0), 0, 'pre-layout sizes stay quiet');
});

test('the hint needs a usable gap and a portrait layout', () => {
  assert.equal(showsPadHint(PAD_HINT_MIN_PX, false), true);
  assert.equal(showsPadHint(PAD_HINT_MIN_PX - 1, false), false, 'a sliver of letterbox is not a pad');
  assert.equal(showsPadHint(PAD_HINT_MIN_PX * 4, true), false, 'immersive centers the stage — no hint');
  assert.equal(showsPadHint(0, false), false);
});

test('the tuning keeps its intent', () => {
  assert.ok(PAD_HINT_MIN_PX >= 44, 'at least a touch target tall before it advertises itself');
  assert.ok(PAD_CURSOR_LINGER_MS >= 1000, 'the crosshair must outlive the finger, not blink out');
});

test('the pad is mounted in every state but Gaming', () => {
  assert.equal(padMounted({ gaming: false }), true);
  assert.equal(padMounted({ gaming: true }), false, 'the controller overlay owns every touch');
});

test('the panel-state guidance no longer unmounts the pad', () => {
  // The regression this fixes: the guidance is clipped to the stage rectangle,
  // so the well below it is free — and captureBlocked keeps the guidance up for
  // a whole session, which used to mean no trackpad at all, ever.
  assert.equal(padMounted({ gaming: false }), true);
});

test('the portrait pad sits under the pill row, down to the panel margin', () => {
  assert.deepEqual(padRect(600, 240), { top: 240 + PAD_TOP_GAP_PX, bottom: PAD_BOTTOM_PX });
  assert.equal(padRect(600, 240).top + PAD_MIN_PX <= 600 - PAD_BOTTOM_PX, true);
});

test('a shrinking panel gives up the pill row before it gives up a pad', () => {
  // Inline keyboard open: the dock grows, the panel shrinks, and stageH + gap
  // would otherwise drop below the pad's own bottom and collapse (or invert) it.
  const tight = padRect(200, 180);
  assert.equal(tight.top, 200 - PAD_BOTTOM_PX - PAD_MIN_PX);
  assert.equal(200 - tight.bottom - tight.top, PAD_MIN_PX, 'never thinner than one touch target');

  const nothing = padRect(0, 0);
  assert.equal(nothing.top, 0, 'pre-layout sizes never go negative');
});

test('every pad rect is a rect, not an inversion', () => {
  for (const boxH of [0, 40, 120, 300, 844]) {
    for (const stageH of [0, 60, 244, 400, 900]) {
      const rect = padRect(boxH, stageH);
      assert.ok(rect.top >= 0, `top ${rect.top} for ${boxH}/${stageH}`);
      assert.ok(rect.top <= Math.max(0, boxH - PAD_BOTTOM_PX), `top past the panel for ${boxH}/${stageH}`);
    }
  }
});
