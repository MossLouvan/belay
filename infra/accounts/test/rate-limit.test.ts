import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enforceLimit } from '../src/rate-limit.js';
import { HttpError } from '../src/http.js';
import { fakeD1 } from './fake-d1.js';

const limit = { max: 3, windowMs: 60_000 };

test('allows max hits in a window, then 429s', async () => {
  const db = fakeD1();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) await enforceLimit(db, 'k', limit, t0 + i);
  await assert.rejects(enforceLimit(db, 'k', limit, t0 + 10), (e: HttpError) => e.status === 429 && e.code === 'rate_limited');
});

test('resets in the next window and keeps keys independent', async () => {
  const db = fakeD1();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) await enforceLimit(db, 'a', limit, t0);
  await assert.rejects(enforceLimit(db, 'a', limit, t0));
  await enforceLimit(db, 'b', limit, t0); // other key unaffected
  await enforceLimit(db, 'a', limit, t0 + 60_000); // new window
});
