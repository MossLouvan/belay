// Regression tests for the /pair idempotency cache.
//
// The bug: a lost reply to a successful POST /pair bricks first-run onboarding.
// The code is burned and a token minted before the response is written, so when
// the reply is dropped the phone has no token and re-entering the same code is
// answered `400 invalid or expired` forever. The cache makes the mutation
// replayable: an identical retry of a just-consumed code returns the same token
// instead of a 400.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPairReplayCache,
  PAIR_REPLAY_TTL_MS,
} from '../src/pair-replay.js';

test('an unremembered code has nothing to replay', () => {
  const cache = createPairReplayCache();
  assert.equal(cache.lookup('123456'), null);
});

test('REGRESSION: a retry of a just-paired code replays the same token', () => {
  // The exact failure mode: the first reply was lost, the code is burned, and
  // the phone re-sends the same code hoping to recover its token.
  const cache = createPairReplayCache();
  cache.remember('123456', { token: 'tok-abc', name: 'My PC' });

  const replayed = cache.lookup('123456');
  assert.deepEqual(replayed, { token: 'tok-abc', name: 'My PC' });
});

test('the result carries any optional via marker through a replay', () => {
  const cache = createPairReplayCache();
  cache.remember('654321', { token: 'tok-xyz', name: 'My PC', via: 'tailnet' });
  assert.deepEqual(cache.lookup('654321'), {
    token: 'tok-xyz', name: 'My PC', via: 'tailnet',
  });
});

test('a different code does not replay another code\'s token', () => {
  const cache = createPairReplayCache();
  cache.remember('111111', { token: 'tok-1', name: 'PC' });
  assert.equal(cache.lookup('222222'), null);
});

test('an empty code is never remembered or replayed', () => {
  const cache = createPairReplayCache();
  cache.remember('', { token: 'tok-empty', name: 'PC' });
  assert.equal(cache.lookup(''), null);
});

test('a remembered result expires after the TTL window', () => {
  let clock = 1_000;
  const cache = createPairReplayCache({ now: () => clock });
  cache.remember('123456', { token: 'tok-abc', name: 'PC' });

  clock += PAIR_REPLAY_TTL_MS - 1;
  assert.ok(cache.lookup('123456'), 'still replayable just inside the window');

  clock += 2; // now past the TTL
  assert.equal(cache.lookup('123456'), null, 'no longer replayable past the window');
});

test('mutating a replayed result cannot corrupt the cache', () => {
  const cache = createPairReplayCache();
  cache.remember('123456', { token: 'tok-abc', name: 'PC' });

  const first = cache.lookup('123456') as { token: string; name: string };
  first.token = 'tampered';

  assert.equal(cache.lookup('123456')?.token, 'tok-abc',
    'a later retry still gets the real token');
});

test('mutating the source object after remember cannot rewrite the cache', () => {
  const cache = createPairReplayCache();
  const source = { token: 'tok-abc', name: 'PC' };
  cache.remember('123456', source);
  source.token = 'tampered';

  assert.equal(cache.lookup('123456')?.token, 'tok-abc');
});
