// Unit tests for the activity chart's "is this a chart yet?" rule.
//
//   cd app && node --test src/system/chart-shape.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHART_MIN_SAMPLES, chartHasShape } from './chart-shape.ts';

test('a chart needs real shape before it is drawn', () => {
  assert.equal(chartHasShape(Array.from({ length: CHART_MIN_SAMPLES }, () => 50)), true);
  assert.equal(chartHasShape(Array.from({ length: CHART_MIN_SAMPLES - 1 }, () => 50)), false);
  assert.equal(chartHasShape([]), false);
});

test('unmeasurable samples do not count toward a chart', () => {
  assert.equal(chartHasShape([1, NaN, Infinity, null, undefined, 'x']), false);
  assert.equal(chartHasShape([1, 2, NaN, 3, 4, 5]), true);
});

test('chartHasShape survives a missing series rather than throwing', () => {
  for (const input of [undefined, null, 0, {}, 'abc']) {
    assert.equal(chartHasShape(input), false, JSON.stringify(input));
  }
});
