// Unit tests for the auto-reconnect backoff curve.
//
//   cd app && node --test src/devices/reconnect-backoff.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from './reconnect-backoff.ts';

test('the curve doubles from the base', () => {
  assert.equal(reconnectDelay(0), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(1), 4000);
  assert.equal(reconnectDelay(2), 8000);
  assert.equal(reconnectDelay(3), 16000);
});

test('the delay is capped so a long-asleep machine still retries at a sane rate', () => {
  assert.equal(reconnectDelay(4), RECONNECT_MAX_MS);
  assert.equal(reconnectDelay(10), RECONNECT_MAX_MS);
  assert.equal(reconnectDelay(1000), RECONNECT_MAX_MS);
});

test('junk from a render counter is clamped, never trusted', () => {
  assert.equal(reconnectDelay(-3), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(1.9), 4000, 'fractional attempts floor');
  assert.equal(reconnectDelay(Number.NaN), RECONNECT_BASE_MS);
});
