// Source-bound /pair idempotency: a lost reply is recoverable by the SAME
// requester, but never by a different device that merely saw the on-screen code.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPairReplayCache, PAIR_REPLAY_TTL_MS } from '../src/pair-replay.js';

const RESULT = { token: 'tok-abc', name: 'PC' };

test('the same source replays the token after a lost reply', () => {
  const cache = createPairReplayCache({ now: () => 1000 });
  cache.remember('123456', 'phone-A', RESULT);
  assert.deepEqual(cache.lookup('123456', 'phone-A'), RESULT);
});

test('a DIFFERENT source that saw the code cannot replay it (the security fix)', () => {
  const cache = createPairReplayCache({ now: () => 1000 });
  cache.remember('123456', 'phone-A', RESULT);
  assert.equal(cache.lookup('123456', 'attacker-B'), null);
});

test('an empty source id neither remembers nor replays', () => {
  const cache = createPairReplayCache({ now: () => 1000 });
  cache.remember('123456', '', RESULT);
  assert.equal(cache.lookup('123456', ''), null);
  assert.equal(cache.lookup('123456', 'phone-A'), null);
});

test('replay expires with the code window', () => {
  let t = 1000;
  const cache = createPairReplayCache({ now: () => t });
  cache.remember('123456', 'phone-A', RESULT);
  t = 1000 + PAIR_REPLAY_TTL_MS + 1;
  assert.equal(cache.lookup('123456', 'phone-A'), null);
});

test('an unknown code is never replayable', () => {
  const cache = createPairReplayCache({ now: () => 1000 });
  assert.equal(cache.lookup('999999', 'phone-A'), null);
});
