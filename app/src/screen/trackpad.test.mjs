// Unit tests for the deadspace trackpad's pure decisions.
//
//   cd app && node --test src/screen/trackpad.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PAD_CURSOR_LINGER_MS, PAD_HINT_MIN_PX, padGapBelow, showsPadHint } from './trackpad.ts';

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
