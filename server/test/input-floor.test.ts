// Tests for the input floor: the exclusive lease that stops two remote users
// interleaving their clicks, and the rule that the person physically at the
// machine outranks both of them.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INJECT_MARGIN_MS, createInputFloor, denialBody, isLocalActivity,
} from '../src/input-floor.js';
import type { FloorDenied } from '../src/input-floor.js';

const T0 = 1_000_000;

// ---- telling a human apart from our own injection --------------------------

test('input long after our last injection is a human at the machine', () => {
  assert.equal(isLocalActivity(50, T0, T0 - 10_000), true);
});

test('input in the same breath as our injection is our injection', () => {
  // We injected at T0 - 100; the OS says input landed ~50 ms ago, i.e. at
  // T0 - 50. That is inside the margin, so it is the click we just sent.
  assert.equal(isLocalActivity(50, T0, T0 - 100), false);
});

test('the margin is the boundary, not a suggestion', () => {
  const lastInject = T0 - 1_000;
  // Input exactly one margin after the injection is still ours...
  assert.equal(isLocalActivity(1_000 - INJECT_MARGIN_MS, T0, lastInject), false);
  // ...a millisecond later it is not.
  assert.equal(isLocalActivity(1_000 - INJECT_MARGIN_MS - 1, T0, lastInject), true);
});

test('no probe means no evidence, and no evidence must not freeze the desktop', () => {
  // An older helper, or a platform with no idle probe at all. Freezing here
  // would break remote input entirely for everyone on that build.
  assert.equal(isLocalActivity(null, T0, 0), false);
  assert.equal(isLocalActivity(Number.NaN, T0, 0), false);
  assert.equal(isLocalActivity(-1, T0, 0), false);
});

// ---- exclusivity -----------------------------------------------------------

test('the first asker gets the floor', () => {
  const floor = createInputFloor();
  const d = floor.request('a', 'Moss', T0);
  assert.equal(d.ok, true);
  assert.equal(floor.holder(T0), 'a');
});

test('a second user is refused while the first holds it', () => {
  const floor = createInputFloor({ leaseMs: 1_000 });
  floor.request('a', 'Moss', T0);
  const d = floor.request('b', 'Jack', T0 + 10);
  assert.equal(d.ok, false);
  const denied = d as FloorDenied;
  assert.equal(denied.reason, 'held');
  assert.equal(denied.holder, 'a');
  assert.equal(denied.holderName, 'Moss');
  assert.ok(denied.retryInMs > 0 && denied.retryInMs <= 1_000);
});

test('the holder renews rather than being refused by itself', () => {
  const floor = createInputFloor({ leaseMs: 1_000 });
  floor.request('a', 'Moss', T0);
  const again = floor.request('a', 'Moss', T0 + 900);
  assert.equal(again.ok, true);
  // Renewal extends the lease, so a long drag does not lapse mid-gesture.
  assert.equal(floor.holder(T0 + 1_500), 'a');
});

test('an abandoned lease lapses so the floor is never held forever', () => {
  const floor = createInputFloor({ leaseMs: 1_000 });
  floor.request('a', 'Moss', T0);
  assert.equal(floor.holder(T0 + 1_001), null, 'a phone in a lift must not hold the desktop');
  assert.equal(floor.request('b', 'Jack', T0 + 1_001).ok, true);
});

test('release hands the floor over immediately', () => {
  const floor = createInputFloor({ leaseMs: 10_000 });
  floor.request('a', 'Moss', T0);
  floor.release('a', T0 + 10);
  assert.equal(floor.holder(T0 + 20), null);
  assert.equal(floor.request('b', 'Jack', T0 + 20).ok, true);
});

test('a non-holder cannot release the floor out from under the holder', () => {
  const floor = createInputFloor({ leaseMs: 10_000 });
  floor.request('a', 'Moss', T0);
  floor.release('b', T0 + 10);
  assert.equal(floor.holder(T0 + 20), 'a');
});

// ---- the local user wins ---------------------------------------------------

test('local activity freezes remote input and evicts the holder', () => {
  const floor = createInputFloor({ leaseMs: 10_000, localGraceMs: 3_000 });
  floor.request('a', 'Moss', T0);
  floor.noteLocalActivity(T0 + 100);

  assert.equal(floor.frozen(T0 + 200), true);
  assert.equal(floor.holder(T0 + 200), null, 'the holder is evicted, not merely paused');

  const d = floor.request('a', 'Moss', T0 + 200) as FloorDenied;
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'local');
  assert.equal(d.holder, undefined, 'the person at the keyboard has no cursor id');
});

test('the freeze lifts once the host goes idle again', () => {
  const floor = createInputFloor({ localGraceMs: 3_000 });
  floor.noteLocalActivity(T0);
  assert.equal(floor.request('a', 'Moss', T0 + 2_999).ok, false);
  assert.equal(floor.request('a', 'Moss', T0 + 3_001).ok, true);
});

test('continued typing keeps extending the freeze', () => {
  const floor = createInputFloor({ localGraceMs: 3_000 });
  floor.noteLocalActivity(T0);
  floor.noteLocalActivity(T0 + 2_000);
  assert.equal(floor.frozen(T0 + 4_000), true, 'still typing at +4s');
  assert.equal(floor.frozen(T0 + 5_001), false);
});

test('a stale local report cannot shorten a freeze already running', () => {
  const floor = createInputFloor({ localGraceMs: 3_000 });
  floor.noteLocalActivity(T0 + 2_000);
  floor.noteLocalActivity(T0);            // an older sample arriving late
  assert.equal(floor.frozen(T0 + 4_000), true);
});

test('a remote click does not freeze out the user who sent it', () => {
  // The full loop: request, inject, probe reports that injection. Without the
  // margin the desktop would freeze on its own remote input.
  const floor = createInputFloor({ leaseMs: 1_500, localGraceMs: 3_000 });
  assert.equal(floor.request('a', 'Moss', T0).ok, true);
  floor.noteInjection(T0 + 5);
  const idleMs = 20;
  const now = T0 + 25;
  assert.equal(isLocalActivity(idleMs, now, floor.lastInjectionAt()), false);
  assert.equal(floor.request('a', 'Moss', now).ok, true, 'the next click still lands');
});

// ---- what the client is told -----------------------------------------------

test('denialBody names the person holding the desktop', () => {
  const body = denialBody({
    ok: false, reason: 'held', holder: 'abc', holderName: 'Jack', retryInMs: 812.4,
  });
  assert.match(body.error, /Jack/);
  assert.equal(body.reason, 'held');
  assert.equal(body.retryInMs, 812);
});

test('denialBody says nothing about a person it cannot name', () => {
  const body = denialBody({ ok: false, reason: 'local', retryInMs: 2_900 });
  assert.match(body.error, /directly/);
  assert.equal(body.holder, undefined);
  assert.equal(body.holderName, undefined);
});

test('denialBody never returns a negative backoff', () => {
  const body = denialBody({ ok: false, reason: 'held', retryInMs: -5 });
  assert.equal(body.retryInMs, 0);
});
