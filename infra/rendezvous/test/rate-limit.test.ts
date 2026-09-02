// Token-bucket rate limiting: the rendezvous's whole anti-abuse surface for
// unauthenticated operations, so its edges are pinned exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../src/rate-limit.js';

function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('allows a burst up to capacity, then refuses', () => {
  const c = clock(1_000_000);
  const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 }, c.now);
  assert.equal(limiter.take('ip1'), true);
  assert.equal(limiter.take('ip1'), true);
  assert.equal(limiter.take('ip1'), true);
  assert.equal(limiter.take('ip1'), false);
});

test('refills at the sustained rate and caps at capacity', () => {
  const c = clock(1_000_000);
  const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 }, c.now);
  for (let i = 0; i < 3; i++) limiter.take('k');
  assert.equal(limiter.take('k'), false);

  c.advance(1000);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), false);

  // A long idle period refills to capacity, never beyond it.
  c.advance(3_600_000);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), false);
});

test('keys are independent', () => {
  const c = clock(1_000_000);
  const limiter = createRateLimiter({ capacity: 1, refillPerSec: 0.1 }, c.now);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), true);
});

test('fails closed when the key table is full', () => {
  const c = clock(1_000_000);
  const limiter = createRateLimiter({ capacity: 2, refillPerSec: 0.001, maxKeys: 2 }, c.now);
  limiter.take('a');
  limiter.take('b');
  // Table full and nothing prunable (both buckets below capacity): refuse.
  assert.equal(limiter.take('c'), false);
});

test('full buckets are pruned so the table recovers', () => {
  const c = clock(1_000_000);
  const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2 }, c.now);
  limiter.take('a');
  limiter.take('b');
  c.advance(2000); // both refill to capacity → prunable
  assert.equal(limiter.take('c'), true);
});

test('rejects a nonsensical configuration', () => {
  assert.throws(() => createRateLimiter({ capacity: 0, refillPerSec: 1 }));
  assert.throws(() => createRateLimiter({ capacity: 1, refillPerSec: 0 }));
});
