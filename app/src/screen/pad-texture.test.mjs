import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAD_DOT_LIMIT, PAD_DOT_PITCH, padDots } from './pad-texture.ts';

test('padDots: a pad smaller than one pitch gets no grid at all', () => {
  assert.deepEqual(padDots(0, 0), []);
  assert.deepEqual(padDots(PAD_DOT_PITCH, 100), []);
  assert.deepEqual(padDots(100, PAD_DOT_PITCH), []);
  assert.deepEqual(padDots(-50, -50), []);
});

test('padDots: NaN and Infinity from an unmeasured layout produce no dots', () => {
  assert.deepEqual(padDots(Number.NaN, 100), []);
  assert.deepEqual(padDots(100, Number.NaN), []);
  assert.deepEqual(padDots(Number.POSITIVE_INFINITY, 100).length <= PAD_DOT_LIMIT, true);
});

test('padDots: the grid is inset by half a pitch so it clears rounded corners', () => {
  const dots = padDots(200, 200);
  const inset = PAD_DOT_PITCH / 2;
  assert.equal(dots[0].x, inset);
  assert.equal(dots[0].y, inset);
  for (const dot of dots) {
    assert.equal(dot.x >= inset, true);
    assert.equal(dot.y >= inset, true);
    assert.equal(dot.x < 200, true);
    assert.equal(dot.y < 200, true);
  }
});

test('padDots: dots sit on a regular lattice', () => {
  const dots = padDots(100, 60);
  for (const dot of dots) {
    assert.equal((dot.x - PAD_DOT_PITCH / 2) % PAD_DOT_PITCH, 0);
    assert.equal((dot.y - PAD_DOT_PITCH / 2) % PAD_DOT_PITCH, 0);
  }
  const xs = new Set(dots.map((d) => d.x));
  const ys = new Set(dots.map((d) => d.y));
  assert.equal(dots.length, xs.size * ys.size);
});

test('padDots: a huge pad is capped rather than mounting thousands of views', () => {
  assert.equal(padDots(4000, 4000).length, PAD_DOT_LIMIT);
});
