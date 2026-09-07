// Unit tests for the connect screen's pure pieces.
//
//   cd app && node --test src/connect/pair-flow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_CHECK_TIMEOUT_MS,
  SUCCESS_DWELL_MS,
  TIMED_OUT,
  deviceNameFor,
  errorMessage,
  firstReachable,
  shouldRecheckOnReturn,
  withDeadline,
} from './pair-flow.ts';

test('the pairing is registered under the phone platform, not the OS build', () => {
  assert.equal(deviceNameFor('ios'), 'iPhone');
  assert.equal(deviceNameFor('web'), 'Browser');
  assert.equal(deviceNameFor('android'), 'Android');
  // Anything else is treated as Android — the only other phone Belay ships on.
  assert.equal(deviceNameFor('windows'), 'Android');
});

test('errorMessage reads an Error, stringifies the rest, and never throws', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(404), '404');
  assert.equal(errorMessage(null), '');
  assert.equal(errorMessage(undefined), '');
});

test('withDeadline hands back the work when it beats the deadline', async () => {
  const result = await withDeadline(Promise.resolve({ ok: true, name: 'mac' }), 1000, TIMED_OUT);
  assert.deepEqual(result, { ok: true, name: 'mac' });
});

test('withDeadline hands back the fallback when the work hangs', async () => {
  const never = new Promise(() => undefined);
  const result = await withDeadline(never, 5, TIMED_OUT);
  assert.deepEqual(result, TIMED_OUT);
  assert.equal(result.ok, false);
});

test('withDeadline surfaces a rejection rather than masking it as a timeout', async () => {
  await assert.rejects(withDeadline(Promise.reject(new Error('refused')), 1000, TIMED_OUT), /refused/);
});

test('the timing constants keep their intent', () => {
  assert.ok(HOST_CHECK_TIMEOUT_MS >= 5000, 'a cold tailnet needs a few seconds to find its peer');
  assert.ok(SUCCESS_DWELL_MS < 2000, 'the success notice is a receipt, not a wait');
  assert.equal(TIMED_OUT.ok, false);
});

test('firstReachable returns the address that answered', async () => {
  const probe = async (url) => ({ ok: url.includes('100.'), id: 'mac-1' });
  const winner = await firstReachable(['http://192.168.1.2:8080', 'http://100.64.0.1:8080'], probe);
  assert.equal(winner, 'http://100.64.0.1:8080');
});

test('firstReachable is null when nothing answers, and with nothing to try', async () => {
  const dead = async () => ({ ok: false, error: 'refused' });
  assert.equal(await firstReachable(['http://192.168.1.2:8080'], dead), null);
  assert.equal(await firstReachable([], dead), null);
});

test('firstReachable treats a throwing probe as a miss, not a crash', async () => {
  const probe = async (url) => {
    if (url.startsWith('http://bad')) throw new Error('network down');
    return { ok: true };
  };
  assert.equal(await firstReachable(['http://bad:1', 'http://good:1'], probe), 'http://good:1');
});

const back = { previous: 'background', next: 'active', awaitingTailscale: true, stage: 'code', checking: false, live: true };

test('coming back from Tailscale re-runs the check', () => {
  assert.equal(shouldRecheckOnReturn(back), true);
  assert.equal(shouldRecheckOnReturn({ ...back, previous: 'inactive' }), true, 'iOS passes through inactive');
});

test('only a real foreground transition counts', () => {
  assert.equal(shouldRecheckOnReturn({ ...back, previous: 'active' }), false, 'active to active is not a return');
  assert.equal(shouldRecheckOnReturn({ ...back, next: 'background' }), false, 'leaving is not returning');
});

test('nothing re-runs unless the code screen is waiting on Tailscale', () => {
  assert.equal(shouldRecheckOnReturn({ ...back, awaitingTailscale: false }), false);
  assert.equal(shouldRecheckOnReturn({ ...back, stage: 'host' }), false);
  assert.equal(shouldRecheckOnReturn({ ...back, stage: 'tailscale' }), false);
});

test('a check in flight or an unmounted screen is never raced', () => {
  assert.equal(shouldRecheckOnReturn({ ...back, checking: true }), false);
  assert.equal(shouldRecheckOnReturn({ ...back, live: false }), false);
});
