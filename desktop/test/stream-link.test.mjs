import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LINK, reconnectDelay, stalled, secondStatus } from '../src/stream-link.js';

test('reconnect delay doubles from the base and stops at the ceiling', () => {
  assert.equal(reconnectDelay(0), 500);
  assert.equal(reconnectDelay(1), 1000);
  assert.equal(reconnectDelay(3), 4000);
  assert.equal(reconnectDelay(4), 8000);
  assert.equal(reconnectDelay(40), 8000);
});

test('a link is stalled once nothing has arrived for the stall window', () => {
  assert.equal(stalled(1000, 1000 + LINK.stallMs - 1), false);
  assert.equal(stalled(1000, 1000 + LINK.stallMs), true);
  assert.equal(stalled(1000, 1000 + LINK.stallMs, 2000), true);
});

test('a second with frames reports the drawn rate and the bytes, and lights the dot', () => {
  const status = secondStatus({ drawn: 12, bytes: 120 * 1024, sinceMessageMs: 40 });
  assert.deepEqual(status, { text: '12 fps · 120 KB/s', live: true, bad: false });
});

test('a brief gap keeps whatever the status already says', () => {
  assert.equal(secondStatus({ drawn: 0, bytes: 0, sinceMessageMs: 1500 }), null);
});

test('a silent link stops claiming a frame rate', () => {
  const status = secondStatus({ drawn: 0, bytes: 0, sinceMessageMs: 3200 });
  assert.deepEqual(status, { text: 'no frames for 3s', live: false, bad: false });
});

test('frames that arrived but did not draw still count as activity, not as a rate', () => {
  const status = secondStatus({ drawn: 0, bytes: 50 * 1024, sinceMessageMs: 10 });
  assert.deepEqual(status, { text: '0 fps · 50 KB/s', live: true, bad: false });
});
