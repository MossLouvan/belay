// The attention socket's reconnect schedule: fast first, then backing off.
//
//   cd app && node --test src/agent/reconnect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ATTENTION_RETRY_MAX_MS, attentionRetryMs } from './attention.ts';

test('attentionRetryMs starts at 500 ms and doubles', () => {
  assert.deepEqual([0, 1, 2, 3].map(attentionRetryMs), [500, 1000, 2000, 4000]);
});

test('attentionRetryMs caps at the old slow poll and never goes negative', () => {
  assert.equal(attentionRetryMs(10), ATTENTION_RETRY_MAX_MS);
  assert.equal(attentionRetryMs(-3), 500);
});
