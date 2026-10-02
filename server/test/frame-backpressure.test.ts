import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRAME_BUFFER_CAP, FRAME_DRAIN_POLL_MS, frameBackedUp } from '../src/frame-backpressure.js';

test('the cap is about two frames, not a quarter megabyte', () => {
  assert.equal(FRAME_BUFFER_CAP, 64 * 1024);
  assert.ok(FRAME_DRAIN_POLL_MS <= 10);
});

test('a backed-up socket skips the capture; a draining one proceeds', () => {
  assert.equal(frameBackedUp(0), false);
  assert.equal(frameBackedUp(FRAME_BUFFER_CAP), false);
  assert.equal(frameBackedUp(FRAME_BUFFER_CAP + 1), true);
});
