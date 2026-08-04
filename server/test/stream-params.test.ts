// Unit tests for screen-stream parameter validation.
//
// The regression these exist to prevent: a value that *looks* clamped but is
// NaN, which makes the loop's pacing comparison false and removes the frame
// rate limit entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampToRange, resolveStreamParams, STREAM_LIMITS } from '../src/stream-params.js';

test('clampToRange keeps an in-range value', () => {
  assert.equal(clampToRange(800, STREAM_LIMITS.width), 800);
  assert.equal(clampToRange(50, STREAM_LIMITS.quality), 50);
  assert.equal(clampToRange(12, STREAM_LIMITS.fps), 12);
});

test('clampToRange pins values outside the range to the bounds', () => {
  assert.equal(clampToRange(100_000, STREAM_LIMITS.fps), STREAM_LIMITS.fps.max);
  assert.equal(clampToRange(-5, STREAM_LIMITS.width), STREAM_LIMITS.width.min);
  assert.equal(clampToRange(0, STREAM_LIMITS.quality), STREAM_LIMITS.quality.min);
});

test('clampToRange never returns NaN, whatever it is given', () => {
  // This is the bug. Math.max(1, Math.min(30, NaN)) is NaN, and `elapsed < NaN`
  // is false, so the pacing sleep was skipped forever.
  for (const bad of ['abc', NaN, Infinity, -Infinity, {}, [], null, undefined, 'fps']) {
    const out = clampToRange(bad, STREAM_LIMITS.fps);
    assert.ok(Number.isFinite(out), `expected a finite number for ${String(bad)}, got ${out}`);
    assert.equal(out, STREAM_LIMITS.fps.fallback);
  }
});

test('clampToRange accepts numeric strings, which is how query params arrive', () => {
  assert.equal(clampToRange('720', STREAM_LIMITS.width), 720);
  assert.equal(clampToRange('30', STREAM_LIMITS.fps), 30);
});

test('clampToRange rounds fractional values', () => {
  assert.equal(clampToRange(12.7, STREAM_LIMITS.fps), 13);
  assert.equal(clampToRange(800.4, STREAM_LIMITS.width), 800);
});

test('resolveStreamParams falls back on every field when given nothing', () => {
  const params = resolveStreamParams({});
  assert.deepEqual(params, {
    width: STREAM_LIMITS.width.fallback,
    quality: STREAM_LIMITS.quality.fallback,
    fps: STREAM_LIMITS.fps.fallback,
  });
});

test('resolveStreamParams keeps current values for absent fields', () => {
  const current = { width: 1280, quality: 70, fps: 20 };
  const params = resolveStreamParams({ fps: 5 }, current);
  assert.equal(params.fps, 5);
  assert.equal(params.width, 1280, 'width untouched by a fps-only update');
  assert.equal(params.quality, 70, 'quality untouched by a fps-only update');
});

test('resolveStreamParams clamps a hostile query string', () => {
  // The exact shape that produced an uncapped capture loop: ?fps=100000&w=99999
  const params = resolveStreamParams({ fps: '100000', w: '99999', q: '100000' });
  assert.equal(params.fps, STREAM_LIMITS.fps.max);
  assert.equal(params.width, STREAM_LIMITS.width.max);
  assert.equal(params.quality, STREAM_LIMITS.quality.max);
});

test('resolveStreamParams clamps a hostile control message', () => {
  const current = { width: 1024, quality: 50, fps: 12 };
  const params = resolveStreamParams({ fps: 'abc', w: NaN, q: null }, current);
  assert.equal(params.fps, STREAM_LIMITS.fps.fallback, 'rubbish resets to a safe default');
  assert.equal(params.width, STREAM_LIMITS.width.fallback);
  // null is treated as absent, so the negotiated quality survives.
  assert.equal(params.quality, 50);
});

test('resolveStreamParams treats a negative width as the minimum, not a passthrough', () => {
  const params = resolveStreamParams({ w: -5 });
  assert.equal(params.width, STREAM_LIMITS.width.min);
});

test('every resolved parameter is always finite and within its range', () => {
  const hostile = [
    {}, { fps: 'x' }, { w: Infinity }, { q: -Infinity }, { fps: [] },
    { w: {}, q: 'nope', fps: null }, { fps: 1e308 }, { w: '0x10' },
  ];
  for (const input of hostile) {
    const p = resolveStreamParams(input);
    assert.ok(Number.isFinite(p.fps) && p.fps >= STREAM_LIMITS.fps.min && p.fps <= STREAM_LIMITS.fps.max);
    assert.ok(Number.isFinite(p.width) && p.width >= STREAM_LIMITS.width.min && p.width <= STREAM_LIMITS.width.max);
    assert.ok(Number.isFinite(p.quality) && p.quality >= STREAM_LIMITS.quality.min && p.quality <= STREAM_LIMITS.quality.max);
  }
});
