import test from 'node:test';
import assert from 'node:assert/strict';

import { HERO_ENTRANCE, haloLayers } from './welcome-hero.ts';

test('halo layers step outward from the avatar, largest first', () => {
  const layers = haloLayers(168);
  assert.ok(layers.length >= 2, 'at least two glow rings');
  for (const layer of layers) {
    assert.ok(layer.diameter > 168, 'every ring clears the avatar');
  }
  for (let i = 1; i < layers.length; i += 1) {
    assert.ok(layers[i].diameter < layers[i - 1].diameter, 'sorted largest first');
  }
});

test('outer rings fade instead of ending on a hard edge', () => {
  const layers = haloLayers(120);
  // Largest-first order means opacity must not decrease going inward.
  for (let i = 1; i < layers.length; i += 1) {
    assert.ok(layers[i].opacity >= layers[i - 1].opacity, 'inner rings are at least as strong');
  }
  for (const layer of layers) {
    assert.ok(layer.opacity > 0 && layer.opacity <= 1, 'opacity stays a sane multiplier');
  }
});

test('halo offsets scale with the avatar, not absolute sizes', () => {
  const small = haloLayers(48);
  const large = haloLayers(200);
  assert.equal(small.length, large.length);
  for (let i = 0; i < small.length; i += 1) {
    assert.equal(large[i].diameter - small[i].diameter, 200 - 48, 'same offset either size');
  }
});

test('rejects sizes that could never draw a halo', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => haloLayers(bad), /positive finite/);
  }
});

test('entrance choreography obeys the motion doctrine', () => {
  assert.ok(HERO_ENTRANCE.riseDistancePt <= 8, 'translations are capped at 8pt');
  assert.ok(HERO_ENTRANCE.durationMs <= 400, 'nothing outlasts the hero draw');
  assert.ok(
    HERO_ENTRANCE.mascotDelayMs < HERO_ENTRANCE.headlineDelayMs
      && HERO_ENTRANCE.headlineDelayMs < HERO_ENTRANCE.ctaDelayMs,
    'mascot first, words next, the way forward last',
  );
});
