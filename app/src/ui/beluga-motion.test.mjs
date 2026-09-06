// Unit tests for the beluga mascot's flip/swim choreography math.
//
//   cd app && node --test src/ui/beluga-motion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTOUT_ASPECT_RATIO,
  FLIP_APEX_SCALE,
  FLIP_DEGREES,
  FLIP_JUMP_FRACTION,
  belugaImageBox,
  flipJumpOffset,
  flipRotation,
  flipScale,
} from './beluga-motion.ts';

test('the image box fills the slot width and keeps the cutout aspect — the beluga is never squashed', () => {
  const box = belugaImageBox(48);
  assert.equal(box.width, 48);
  assert.ok(Math.abs(box.height - 48 / CUTOUT_ASPECT_RATIO) < 1e-9);
  assert.ok(box.height < box.width, 'the 642x537 cutout is wider than it is tall');
  assert.ok(Object.isFrozen(box), 'the box is immutable');
});

test('the jump arc launches from level, peaks upward at the apex, and lands level', () => {
  assert.equal(flipJumpOffset(0, 100), -0);
  assert.ok(Math.abs(flipJumpOffset(1, 100)) < 1e-9, 'lands back at level');
  const apex = flipJumpOffset(0.5, 100);
  assert.ok(apex < 0, 'up is negative translateY');
  assert.ok(Math.abs(apex - -100 * FLIP_JUMP_FRACTION) < 1e-9, 'apex height is the jump fraction of size');
  assert.ok(flipJumpOffset(0.25, 100) > apex, 'the arc is highest at the midpoint');
});

test('the flip scale swells to the apex value and settles back to exactly 1', () => {
  assert.equal(flipScale(0), 1);
  assert.ok(Math.abs(flipScale(1) - 1) < 1e-9);
  assert.ok(Math.abs(flipScale(0.5) - FLIP_APEX_SCALE) < 1e-9);
});

test('the flip rotation ends on exactly a full turn, so the settle into idle is seamless', () => {
  assert.equal(flipRotation(0), 0);
  assert.equal(flipRotation(1), FLIP_DEGREES);
  assert.equal(FLIP_DEGREES % 360, 0, 'a whole number of turns — 360° ≡ 0°');
});
