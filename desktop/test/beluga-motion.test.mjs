import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_TURN_DEGREES, MAX_SPIN_VELOCITY, SPIN_AT_REST, TAP_IMPULSE,
  belugaTransform, idleSwim, isSpinIdle, landingLevel, spinJumpOffset, spinRotation, spinScale, stepSpin, tapSpin,
} from '../src/beluga-motion.js';

const FRAME = 1 / 60;
function settle(state, maxFrames = 2000) {
  let s = state, frames = 0;
  while (!isSpinIdle(s) && frames < maxFrames) { s = stepSpin(s, FRAME); frames += 1; }
  return { state: s, frames };
}

test('one tap from rest is exactly one full turn, landing level', () => {
  const { state, frames } = settle(tapSpin(SPIN_AT_REST));
  assert.equal(state.angle, FULL_TURN_DEGREES);
  assert.equal(state.velocity, 0);
  assert.equal(spinRotation(state), 0);
  assert.ok(frames > 30 && frames < 90, `landed in ${frames} frames`);
});

test('taps stack velocity up to the cap and never rewind', () => {
  let s = tapSpin(SPIN_AT_REST);
  for (let i = 0; i < 10; i += 1) s = tapSpin(stepSpin(s, FRAME));
  assert.equal(s.velocity, MAX_SPIN_VELOCITY);
  assert.ok(s.target > s.angle);
  const { state } = settle(s);
  assert.equal(state.angle % FULL_TURN_DEGREES, 0);
});

test('a mid-spin tap adds instead of resetting', () => {
  const first = tapSpin(SPIN_AT_REST);
  const mid = stepSpin(first, 0.2);
  const second = tapSpin(mid);
  assert.ok(second.velocity > TAP_IMPULSE);
  assert.ok(second.target >= 2 * FULL_TURN_DEGREES);
});

test('landing level is never behind the current angle', () => {
  assert.equal(landingLevel(359.9, 1), FULL_TURN_DEGREES);
  assert.equal(landingLevel(0, 0), FULL_TURN_DEGREES);
});

test('a stalled frame is clamped, and stepping never mutates', () => {
  const s = tapSpin(SPIN_AT_REST);
  const before = { ...s };
  const next = stepSpin(s, 5);
  assert.deepEqual({ ...s }, before);
  assert.ok(next.angle - s.angle < FULL_TURN_DEGREES);
  assert.ok(Object.isFrozen(next));
});

test('lift and swell are flat at rest and positive mid-turn', () => {
  assert.equal(Math.abs(spinJumpOffset(SPIN_AT_REST, 120)), 0);
  assert.equal(spinScale(SPIN_AT_REST), 1);
  const apex = stepSpin(tapSpin(SPIN_AT_REST), 0.25);
  assert.ok(spinJumpOffset(apex, 120) < 0);
  assert.ok(spinScale(apex) > 1);
});

test('idle swim starts at the bottom of the bob and stays within bounds', () => {
  const start = idleSwim(0, 120);
  assert.ok(start.bob < 0 && start.sway < 0);
  for (let t = 0; t < 10000; t += 97) {
    const { bob, sway } = idleSwim(t, 120);
    assert.ok(Math.abs(bob) <= 120 * 0.04 + 1e-9);
    assert.ok(Math.abs(sway) <= 2.5 + 1e-9);
  }
});

test('reduced motion renders no transform at all', () => {
  assert.equal(belugaTransform(tapSpin(SPIN_AT_REST), 500, 120, true), 'none');
  assert.match(belugaTransform(SPIN_AT_REST, 0, 120, false), /rotate\(0\.000deg\) scale\(1\.0000\)$/);
});
