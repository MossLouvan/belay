// Tests for the pure attention logic: who is waiting, in what order, and how
// the time left reads.
//
//   cd app && node --test src/agent/attention.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askSummary, countdown, expiryUrgent, waitingSessions } from './attention.ts';

const meta = (over = {}) => ({
  id: 'a', title: 't', cwd: '/x', status: 'idle', lastUsed: 0, createdAt: 0, ...over,
});

test('waitingSessions picks waiting status or a pending summary, nothing else', () => {
  const list = [
    meta({ id: 'idle' }),
    meta({ id: 'run', status: 'running' }),
    meta({ id: 'wait-status', status: 'waiting' }),
    meta({ id: 'wait-pending', status: 'running', pending: { id: 'p', tool: 'Bash', detail: 'x' } }),
    meta({ id: 'err', status: 'error' }),
    meta({ id: 'null-pending', pending: null }),
  ];
  assert.deepEqual(waitingSessions(list).map((s) => s.id), ['wait-status', 'wait-pending']);
});

test('waitingSessions orders by soonest expiry, deadline-less last', () => {
  const list = [
    meta({ id: 'later', status: 'waiting', pending: { id: 'p1', tool: 'Bash', detail: '', expiresAt: 9000 } }),
    meta({ id: 'forever', status: 'waiting', pending: { id: 'p2', tool: 'Bash', detail: '' } }),
    meta({ id: 'soon', status: 'waiting', pending: { id: 'p3', tool: 'Bash', detail: '', expiresAt: 1000 } }),
  ];
  assert.deepEqual(waitingSessions(list).map((s) => s.id), ['soon', 'later', 'forever']);
});

test('waitingSessions of an empty or calm list is empty', () => {
  assert.deepEqual(waitingSessions([]), []);
  assert.deepEqual(waitingSessions([meta(), meta({ id: 'b', status: 'running' })]), []);
});

test('countdown formats minutes, hours and the floor at zero', () => {
  assert.equal(countdown(undefined, 0), '');
  assert.equal(countdown(7_000, 0), '0:07');
  assert.equal(countdown(28 * 60_000 + 41_000, 0), '28:41');
  assert.equal(countdown(3_723_000, 0), '1:02:03');
  // Already past: the host has denied; never show a negative clock.
  assert.equal(countdown(1_000, 5_000), '0:00');
});

test('expiryUrgent flips under two minutes, never without a deadline', () => {
  assert.equal(expiryUrgent(undefined, 0), false);
  assert.equal(expiryUrgent(10 * 60_000, 0), false);
  assert.equal(expiryUrgent(90_000, 0), true);
  assert.equal(expiryUrgent(0, 1), true);
});

test('askSummary joins tool and detail and trims long ones', () => {
  assert.equal(askSummary('Bash', 'npm test'), 'Bash  npm test');
  assert.equal(askSummary('Bash', ''), 'Bash');
  const long = askSummary('Bash', 'x'.repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
});
