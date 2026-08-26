// Unit tests for restart pacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDelay, isHealthyRun, DEFAULT_BACKOFF, BackoffPolicy } from '../src/backoff.js';

const policy: BackoffPolicy = { initialMs: 100, maxMs: 1000, factor: 2, healthyAfterMs: 5000 };

test('the first restart is immediate', () => {
  // A helper that died once should come back now — the user is looking at a
  // black screen, not reading logs.
  assert.equal(backoffDelay(0, policy), 0);
});

test('delay grows with consecutive failures', () => {
  assert.equal(backoffDelay(1, policy), 100);
  assert.equal(backoffDelay(2, policy), 200);
  assert.equal(backoffDelay(3, policy), 400);
  assert.equal(backoffDelay(4, policy), 800);
});

test('delay is capped', () => {
  // The point of the cap: a permanently broken helper retries a few times a
  // minute rather than thousands, without ever giving up entirely.
  assert.equal(backoffDelay(5, policy), 1000);
  assert.equal(backoffDelay(50, policy), 1000);
  assert.equal(backoffDelay(1000, policy), 1000);
});

test('a negative count is treated as no delay', () => {
  assert.equal(backoffDelay(-1, policy), 0);
});

test('delays are finite and non-negative for any input', () => {
  for (const n of [0, 1, 10, 100, 10_000]) {
    const d = backoffDelay(n, policy);
    assert.ok(Number.isFinite(d) && d >= 0, `bad delay ${d} for ${n}`);
  }
});

test('a long run counts as healthy and resets the count', () => {
  assert.equal(isHealthyRun(5000, policy), true);
  assert.equal(isHealthyRun(60_000, policy), true);
});

test('a short run does not count as healthy', () => {
  // A helper that dies instantly on every launch must keep backing off; only a
  // run that lasted long enough is evidence that it works.
  assert.equal(isHealthyRun(0, policy), false);
  assert.equal(isHealthyRun(4999, policy), false);
});

test('the shipped defaults recover fast but cannot spin', () => {
  assert.equal(backoffDelay(0), 0, 'first restart is immediate');
  assert.ok(backoffDelay(1) <= 1000, 'second attempt is still prompt');
  assert.ok(backoffDelay(20) <= DEFAULT_BACKOFF.maxMs);
  assert.ok(DEFAULT_BACKOFF.maxMs >= 5000, 'a broken helper must not be respawned in a tight loop');
});
