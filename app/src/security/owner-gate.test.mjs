// Unit tests for the Face ID gate: when the app locks, and when a sensitive
// action may skip a fresh check. expo-local-authentication is mocked as a
// plain `authenticate` function, which is all the gate ever sees.
//
//   cd app && node --test src/security/owner-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRESH_MS, createOwnerGate, isFresh, shouldLock } from './owner-gate.ts';

const MIN = 60_000;

// --- shouldLock: the lock timing state machine --------------------------------

test('a cold start locks (never backgrounded yet)', () => {
  assert.equal(shouldLock(null, 1_000, 5 * MIN), true);
});

test('coming back before the timeout stays unlocked', () => {
  assert.equal(shouldLock(0, 5 * MIN - 1, 5 * MIN), false);
});

test('coming back at or after the timeout locks', () => {
  assert.equal(shouldLock(0, 5 * MIN, 5 * MIN), true);
  assert.equal(shouldLock(0, 60 * MIN, 5 * MIN), true);
});

test('timeout 0 ("Immediately") locks on every return', () => {
  assert.equal(shouldLock(1_000, 1_000, 0), true);
});

test('a clock that jumped backwards locks rather than trusting it', () => {
  assert.equal(shouldLock(10 * MIN, 1 * MIN, 5 * MIN), true);
});

// --- isFresh: the ~60 s window -------------------------------------------------

test('a check inside the window is fresh, at the edge it is not', () => {
  assert.equal(isFresh(0, FRESH_MS - 1), true);
  assert.equal(isFresh(0, FRESH_MS), false);
  assert.equal(isFresh(null, 0), false);
  assert.equal(isFresh(10_000, 5_000), false); // clock went backwards
});

// --- createOwnerGate: requireOwner with the native prompt mocked ---------------

function harness({ enabled = true, results = [true] } = {}) {
  let t = 1_000_000;
  const calls = [];
  const gate = createOwnerGate({
    now: () => t,
    isEnabled: () => enabled,
    authenticate: async (reason) => { calls.push(reason); return results.shift() ?? false; },
  });
  return { gate, calls, advance: (ms) => { t += ms; }, setEnabled: (v) => { enabled = v; } };
}

test('off means every action passes without a prompt', async () => {
  const h = harness({ enabled: false });
  assert.equal(await h.gate.requireOwner('Allow'), true);
  assert.deepEqual(h.calls, []);
});

test('a passed check is reused inside the window, then asked again', async () => {
  const h = harness({ results: [true, true] });
  assert.equal(await h.gate.requireOwner('Allow'), true);
  h.advance(FRESH_MS - 1);
  assert.equal(await h.gate.requireOwner('Allow again'), true);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(await h.gate.requireOwner('Allow later'), true);
  assert.equal(h.calls.length, 2);
});

test('a failed or cancelled check returns false and is not remembered', async () => {
  const h = harness({ results: [false, true] });
  assert.equal(await h.gate.requireOwner('Allow'), false);
  assert.equal(await h.gate.requireOwner('Allow'), true);
  assert.equal(h.calls.length, 2);
});

test('a throwing prompt counts as a refusal, never a pass', async () => {
  const gate = createOwnerGate({ now: () => 0, isEnabled: () => true, authenticate: async () => { throw new Error('boom'); } });
  assert.equal(await gate.requireOwner('Allow'), false);
});

test('two taps at once share one prompt', async () => {
  const h = harness({ results: [true] });
  const [a, b] = await Promise.all([h.gate.requireOwner('A'), h.gate.requireOwner('B')]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(h.calls.length, 1);
});

test('unlock always prompts, and counts as fresh for the next action', async () => {
  const h = harness({ results: [true, true] });
  await h.gate.requireOwner('Allow');
  assert.equal(await h.gate.unlock('Unlock Belay'), true);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.gate.requireOwner('Allow'), true);
  assert.equal(h.calls.length, 2);
});
