import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyLatch, offer, settle } from '../src/frame-latch.js';

test('an idle latch decodes the first frame straight away', () => {
  const { latch, decode } = offer(emptyLatch(), 'a');
  assert.equal(decode, 'a');
  assert.equal(latch.busy, true);
  assert.equal(latch.pending, null);
});

test('frames arriving mid-decode park behind the one in flight; only the newest survives', () => {
  const first = offer(emptyLatch(), 'a');
  const second = offer(first.latch, 'b');
  assert.equal(second.decode, null);
  assert.equal(second.latch.pending, 'b');
  const third = offer(second.latch, 'c');
  assert.equal(third.decode, null);
  assert.equal(third.latch.pending, 'c');
  assert.equal(third.latch.dropped, 1);
});

test('settling a decode hands out the parked frame and stays busy for it', () => {
  const { latch } = offer(offer(emptyLatch(), 'a').latch, 'b');
  const settled = settle(latch);
  assert.equal(settled.decode, 'b');
  assert.equal(settled.latch.busy, true);
  assert.equal(settled.latch.pending, null);
});

test('settling with nothing parked returns to idle', () => {
  const { latch } = offer(emptyLatch(), 'a');
  const settled = settle(latch);
  assert.equal(settled.decode, null);
  assert.equal(settled.latch.busy, false);
});

test('settle never mutates its input', () => {
  const { latch } = offer(emptyLatch(), 'a');
  const snapshot = { ...latch };
  settle(latch);
  assert.deepEqual(latch, snapshot);
});

test('the latch is bounded: a thousand offers during one decode leave one pending frame', () => {
  let { latch } = offer(emptyLatch(), 0);
  for (let i = 1; i <= 1000; i += 1) latch = offer(latch, i).latch;
  assert.equal(latch.pending, 1000);
  assert.equal(latch.dropped, 999);
  assert.equal(settle(latch).decode, 1000);
});
