// Unit tests for the beluga mascot's swim + momentum-spin choreography math.
//
//   cd app && node --test src/ui/beluga-motion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTOUT_ASPECT_RATIO,
  FLIP_APEX_SCALE,
  FLIP_JUMP_FRACTION,
  FULL_TURN_DEGREES,
  HEAVY_SPIN_VELOCITY,
  HOVER_BOOST,
  MAX_FRAME_SECONDS,
  MAX_SPIN_VELOCITY,
  MIN_LANDING_VELOCITY,
  SPIN_AT_REST,
  SPIN_FRICTION,
  TAP_IMPULSE,
  belugaImageBox,
  hoverWeight,
  isSpinIdle,
  landingLevel,
  spinEnvelope,
  spinHapticTier,
  spinJumpOffset,
  spinRotation,
  spinScale,
  stepSpin,
  tapSpin,
} from './beluga-motion.ts';

const FRAME = 1 / 60;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** Run the integrator at 60fps until it rests; returns every state visited. */
const settle = (start, maxFrames = 100_000) => {
  const trail = [start];
  let state = start;
  for (let i = 0; i < maxFrames && !isSpinIdle(state); i += 1) {
    state = stepSpin(state, FRAME);
    trail.push(state);
  }
  return trail;
};

test('the image box fills the slot width and keeps the cutout aspect — the beluga is never squashed', () => {
  const box = belugaImageBox(48);
  assert.equal(box.width, 48);
  assert.ok(close(box.height, 48 / CUTOUT_ASPECT_RATIO));
  assert.ok(box.height < box.width, 'the 642x537 cutout is wider than it is tall');
  assert.ok(Object.isFrozen(box), 'the box is immutable');
});

test('a single tap from rest is exactly one clean flip, landing level in about a second', () => {
  assert.ok(close(TAP_IMPULSE ** 2 / (2 * SPIN_FRICTION), FULL_TURN_DEGREES), 'the numbers are tuned to one turn');
  const trail = settle(tapSpin(SPIN_AT_REST));
  const last = trail[trail.length - 1];
  assert.equal(last.angle, FULL_TURN_DEGREES);
  assert.equal(last.velocity, 0);
  assert.equal(spinRotation(last) % FULL_TURN_DEGREES, 0, 'lands level');
  const seconds = (trail.length - 1) * FRAME;
  assert.ok(seconds > 0.8 && seconds < 1.2, `one flip takes ~1s, got ${seconds.toFixed(2)}s`);
});

test('the spin only ever moves forward, and velocity never climbs without a tap', () => {
  const trail = settle(tapSpin(tapSpin(tapSpin(SPIN_AT_REST))));
  for (let i = 1; i < trail.length; i += 1) {
    assert.ok(trail[i].angle >= trail[i - 1].angle, 'never rewinds');
    assert.ok(trail[i].velocity <= Math.max(trail[i - 1].velocity, MIN_LANDING_VELOCITY) + 1e-9, 'friction only');
    assert.ok(trail[i].velocity >= 0, 'never negative');
  }
});

test('taps add momentum instead of resetting — rapid taps spin faster and further', () => {
  const one = tapSpin(SPIN_AT_REST);
  const mid = stepSpin(stepSpin(one, FRAME), FRAME);
  const two = tapSpin(mid);
  assert.ok(two.velocity > mid.velocity, 'the second tap adds to what was left');
  assert.ok(close(two.velocity, mid.velocity + TAP_IMPULSE));
  assert.equal(two.angle, mid.angle, 'a tap never yanks the angle');
  const oneTurn = settle(one).length;
  const fiveTaps = [1, 2, 3, 4].reduce((s) => tapSpin(stepSpin(s, FRAME)), one);
  assert.ok(fiveTaps.velocity > one.velocity * 2, 'five quick taps are visibly faster');
  assert.ok(settle(fiveTaps).length > oneTurn * 2, 'and take much longer to wind down');
});

test('velocity is capped, so the beluga can never be wound up without limit', () => {
  const wound = Array.from({ length: 50 }).reduce((s) => tapSpin(s), SPIN_AT_REST);
  assert.equal(wound.velocity, MAX_SPIN_VELOCITY);
  assert.equal(tapSpin(wound).velocity, MAX_SPIN_VELOCITY);
});

test('every spin, however fast, lands on a level and comes to rest — it can never get stuck', () => {
  const starts = [
    tapSpin(SPIN_AT_REST),
    Array.from({ length: 50 }).reduce((s) => tapSpin(s), SPIN_AT_REST),
    tapSpin({ angle: 123.4, velocity: 40, target: 360 }),
    tapSpin({ angle: 359.99, velocity: 5, target: 360 }),
    { angle: 700, velocity: 1e-3, target: 720 },
    { angle: 0, velocity: 1e-3, target: 720 },
  ];
  for (const start of starts) {
    const trail = settle(start, 5_000);
    const last = trail[trail.length - 1];
    assert.ok(isSpinIdle(last), `rests within 5000 frames from ${JSON.stringify(start)}`);
    assert.equal(last.angle % FULL_TURN_DEGREES, 0, 'rests exactly level');
    assert.equal(spinRotation(last), 0);
    assert.ok(last.angle >= start.angle, 'never lands behind where it was');
  }
});

test('the landing level is the nearest turn to the natural stop, never behind the beluga', () => {
  assert.equal(landingLevel(0, TAP_IMPULSE), 360);
  assert.equal(landingLevel(0, MAX_SPIN_VELOCITY), Math.round(MAX_SPIN_VELOCITY ** 2 / (2 * SPIN_FRICTION) / 360) * 360);
  assert.equal(landingLevel(10, 1), 360, 'a crawl just past level goes on to the next one, not back');
  assert.equal(landingLevel(360, 0), 720, 'at rest on a level, the next tap aims a full turn ahead');
  assert.equal(landingLevel(700, 100), 720);
});

test('a stalled frame is clamped — backgrounding cannot teleport the beluga through turns', () => {
  const start = tapSpin(SPIN_AT_REST);
  const bigStep = stepSpin(start, 5);
  const clampedStep = stepSpin(start, MAX_FRAME_SECONDS);
  assert.deepEqual(bigStep, clampedStep);
  assert.ok(bigStep.angle < 90, 'a single frame moves a fraction of a turn');
  assert.deepEqual(stepSpin(start, -1), start, 'a negative dt is a no-op');
});

test('a crawl is floored — even a near-zero velocity reaches its landing in bounded time', () => {
  const crawl = { angle: 0, velocity: 1e-3, target: 360 };
  const frames = settle(crawl, 5_000).length - 1;
  assert.ok(frames * FRAME <= 360 / MIN_LANDING_VELOCITY + FRAME, `bounded by the floor, took ${frames} frames`);
  assert.equal(settle(crawl, 5_000).at(-1).angle, 360);
});

test('stepping the model never mutates its input', () => {
  const start = Object.freeze(tapSpin(SPIN_AT_REST));
  const startCopy = { ...start };
  stepSpin(start, FRAME);
  tapSpin(start);
  assert.deepEqual(start, startCopy);
  assert.deepEqual(stepSpin(SPIN_AT_REST, FRAME), SPIN_AT_REST, 'rest stays at rest');
});

test('a lone flip hops once per turn: level at take-off, apex mid-turn, flat again on landing', () => {
  const size = 100;
  const start = tapSpin(SPIN_AT_REST);
  assert.ok(close(spinJumpOffset(start, size), 0), 'launches from level');
  assert.ok(close(spinScale(start), 1));
  const halfway = { ...start, angle: 180 };
  assert.ok(close(spinJumpOffset(halfway, size), -size * FLIP_JUMP_FRACTION), 'up is negative translateY');
  assert.ok(close(spinScale(halfway), FLIP_APEX_SCALE));
  const quarter = { ...start, angle: 90 };
  assert.ok(spinJumpOffset(quarter, size) > spinJumpOffset(halfway, size), 'highest at the midpoint');
  const landed = settle(start).at(-1);
  assert.equal(spinJumpOffset(landed, size), -0);
  assert.equal(spinScale(landed), 1);
});

test('a fast spin lifts into a steady hover that grows with speed, and eases back to per-turn hops', () => {
  assert.equal(hoverWeight(0), 0);
  assert.equal(hoverWeight(TAP_IMPULSE), 0, 'single-tap speed is pure flip');
  assert.equal(hoverWeight(MAX_SPIN_VELOCITY), 1);
  assert.equal(hoverWeight(MAX_SPIN_VELOCITY * 2), 1, 'clamped');
  const capped = { angle: 0, velocity: MAX_SPIN_VELOCITY, target: 3600 };
  assert.ok(close(spinEnvelope(capped), HOVER_BOOST), 'at the cap the beluga hovers at full boost, even on a level');
  assert.ok(close(spinEnvelope({ ...capped, angle: 180 }), HOVER_BOOST), 'and the hover is steady across the turn');
  const midSpeed = { angle: 0, velocity: (TAP_IMPULSE + MAX_SPIN_VELOCITY) / 2, target: 3600 };
  const env = spinEnvelope(midSpeed);
  assert.ok(env > 0 && env < HOVER_BOOST, 'in between, part hop and part hover');
  assert.equal(spinEnvelope(SPIN_AT_REST), 0, 'at rest nothing is lifted');
});

test('haptics escalate with speed: light for a flip, medium when stacked, heavy near the cap', () => {
  assert.equal(spinHapticTier(0), 'light');
  assert.equal(spinHapticTier(TAP_IMPULSE), 'light');
  assert.equal(spinHapticTier(TAP_IMPULSE + 1), 'medium');
  assert.equal(spinHapticTier(HEAVY_SPIN_VELOCITY - 1), 'medium');
  assert.equal(spinHapticTier(HEAVY_SPIN_VELOCITY), 'heavy');
  assert.equal(spinHapticTier(MAX_SPIN_VELOCITY), 'heavy');
  const tiers = [];
  let state = SPIN_AT_REST;
  for (let i = 0; i < 6; i += 1) {
    state = tapSpin(state);
    tiers.push(spinHapticTier(state.velocity));
  }
  assert.deepEqual(tiers, ['light', 'medium', 'heavy', 'heavy', 'heavy', 'heavy']);
});
