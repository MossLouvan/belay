// The System header's staleness rule (#69): a poll that is overdue is stale
// even before it fails, so a hung host does not read "Connected" for 15 s.
//
//   cd app && node --test src/system/format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isStale } from './history.ts';

test('an error is always stale', () => {
  assert.equal(isStale('boom', 1000, 2000, 1001), true);
});

test('nothing received yet is not stale (still connecting)', () => {
  assert.equal(isStale(null, null, 2000, 99999), false);
});

test('an overdue poll is stale; one within its interval plus grace is not', () => {
  assert.equal(isStale(null, 0, 2000, 2000), false);
  assert.equal(isStale(null, 0, 2000, 6000), true);
});

test('paused polling never goes stale on its own', () => {
  assert.equal(isStale(null, 0, null, 999999), false);
});
