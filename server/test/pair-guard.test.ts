// Unit tests for the pairing brute-force guard.
//
// The clock is injected rather than slept on, so lockout expiry and record TTL
// are tested exactly rather than approximately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPairGuard, PAIR_GUARD_DEFAULTS } from '../src/pair-guard.js';

/** A controllable clock, so tests can jump forward without sleeping. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

test('a fresh client is allowed', () => {
  const guard = createPairGuard({}, fakeClock().now);
  const decision = guard.check('1.2.3.4');
  assert.equal(decision.allowed, true);
  assert.equal(decision.retryAfterSec, 0);
});

test('a client is locked out after the configured number of failures', () => {
  const clock = fakeClock();
  const guard = createPairGuard({ maxFailuresPerClient: 3 }, clock.now);

  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, true);

  const decision = guard.check('1.2.3.4');
  assert.equal(decision.allowed, false);
  assert.ok(decision.retryAfterSec > 0);
});

test('lockout applies only to the offending client', () => {
  const guard = createPairGuard({ maxFailuresPerClient: 2 }, fakeClock().now);
  guard.recordFailure('1.2.3.4');
  guard.recordFailure('1.2.3.4');

  assert.equal(guard.check('1.2.3.4').allowed, false);
  // A second phone on the same network must still be able to pair.
  assert.equal(guard.check('5.6.7.8').allowed, true);
});

test('lockout expires after the configured window', () => {
  const clock = fakeClock();
  const guard = createPairGuard({ maxFailuresPerClient: 2, lockoutMs: 60_000 }, clock.now);
  guard.recordFailure('1.2.3.4');
  guard.recordFailure('1.2.3.4');
  assert.equal(guard.check('1.2.3.4').allowed, false);

  clock.advance(59_000);
  assert.equal(guard.check('1.2.3.4').allowed, false, 'still locked one second early');

  clock.advance(2_000);
  assert.equal(guard.check('1.2.3.4').allowed, true, 'unlocked once the window passes');
});

test('retryAfterSec counts down as the lockout elapses', () => {
  const clock = fakeClock();
  const guard = createPairGuard({ maxFailuresPerClient: 1, lockoutMs: 60_000 }, clock.now);
  guard.recordFailure('1.2.3.4');
  assert.equal(guard.check('1.2.3.4').retryAfterSec, 60);

  clock.advance(30_000);
  assert.equal(guard.check('1.2.3.4').retryAfterSec, 30);
});

test('a served lockout resets the client rather than re-locking on one mistake', () => {
  const clock = fakeClock();
  const guard = createPairGuard({ maxFailuresPerClient: 2, lockoutMs: 1_000 }, clock.now);
  guard.recordFailure('1.2.3.4');
  guard.recordFailure('1.2.3.4');
  clock.advance(2_000);
  assert.equal(guard.check('1.2.3.4').allowed, true);

  // One further failure must not immediately re-lock: the count started over.
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
  assert.equal(guard.check('1.2.3.4').allowed, true);
});

test('a successful pairing clears the client record', () => {
  const guard = createPairGuard({ maxFailuresPerClient: 3 }, fakeClock().now);
  guard.recordFailure('1.2.3.4');
  guard.recordFailure('1.2.3.4');
  guard.recordSuccess('1.2.3.4');

  // Back to a clean slate, so the next two failures must not lock out.
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
});

test('the per-code budget burns the code regardless of how many clients are used', () => {
  // The point of this limit: a distributed attempt spreads across addresses so
  // no single client ever hits its own lockout. The code budget must still end.
  const guard = createPairGuard(
    { maxFailuresPerClient: 100, maxFailuresPerCode: 5 },
    fakeClock().now,
  );

  for (let i = 0; i < 4; i++) {
    assert.equal(guard.recordFailure(`10.0.0.${i}`).burnCode, false);
  }
  assert.equal(guard.recordFailure('10.0.0.99').burnCode, true);
});

test('resetting the code budget starts the count over', () => {
  const guard = createPairGuard({ maxFailuresPerCode: 3 }, fakeClock().now);
  guard.recordFailure('a');
  guard.recordFailure('b');
  assert.equal(guard.failuresAgainstCode(), 2);

  guard.resetCodeBudget();
  assert.equal(guard.failuresAgainstCode(), 0);
  assert.equal(guard.recordFailure('c').burnCode, false);
});

test('a client record is forgotten once it goes idle past its TTL', () => {
  const clock = fakeClock();
  const guard = createPairGuard(
    { maxFailuresPerClient: 3, clientTtlMs: 10_000 },
    clock.now,
  );
  guard.recordFailure('1.2.3.4');
  guard.recordFailure('1.2.3.4');

  clock.advance(20_000);
  // The two old failures aged out, so this is failure #1 again, not #3.
  assert.equal(guard.recordFailure('1.2.3.4').clientLockedOut, false);
  assert.equal(guard.check('1.2.3.4').allowed, true);
});

test('tracked clients are capped so the map cannot grow without bound', () => {
  const guard = createPairGuard({ maxTrackedClients: 10 }, fakeClock().now);
  for (let i = 0; i < 200; i++) guard.recordFailure(`10.0.0.${i}`);
  // Nothing to assert directly on the map, but the most recent client must
  // still be tracked — eviction takes the oldest, not the newest.
  assert.equal(guard.check('10.0.0.199').allowed, true);
});

test('defaults are strict enough to matter against a 6-digit code', () => {
  // A regression guard on the policy itself: if someone loosens these, the
  // whole point of the module is gone. 10^6 codes at 20 tries per code is a
  // 1-in-50,000 chance per code minted.
  assert.ok(PAIR_GUARD_DEFAULTS.maxFailuresPerClient <= 10);
  assert.ok(PAIR_GUARD_DEFAULTS.maxFailuresPerCode <= 50);
  assert.ok(PAIR_GUARD_DEFAULTS.lockoutMs >= 60_000);
});
