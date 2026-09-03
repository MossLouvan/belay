// Tests for the pure attention logic: who is waiting, in what order, and how
// the time left reads.
//
//   cd app && node --test src/agent/attention.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAttentionPush, askSummary, countdown, expiryUrgent, parseAttentionMessage, waitingSessions,
} from './attention.ts';

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

// ---- push channel: parse + merge -------------------------------------------

test('parseAttentionMessage accepts only a well-formed attention envelope', () => {
  const ok = parseAttentionMessage(JSON.stringify({
    type: 'attention',
    sessions: [{ id: 'a', status: 'waiting', pending: 2 }, { id: 'b', status: 'idle', pending: 0 }],
  }));
  assert.deepEqual(ok, [
    { id: 'a', status: 'waiting', pending: 2 },
    { id: 'b', status: 'idle', pending: 0 },
  ]);
  assert.equal(parseAttentionMessage('not json'), null);
  assert.equal(parseAttentionMessage('42'), null);
  assert.equal(parseAttentionMessage(JSON.stringify({ type: 'status', status: 'idle' })), null);
  assert.equal(parseAttentionMessage(JSON.stringify({ type: 'attention', sessions: 'x' })), null);
  assert.equal(parseAttentionMessage(JSON.stringify({ type: 'attention', sessions: [{ id: 7, status: 'idle' }] })), null);
});

test('parseAttentionMessage defaults a missing or garbage pending count to 0', () => {
  const rows = parseAttentionMessage(JSON.stringify({
    type: 'attention',
    sessions: [{ id: 'a', status: 'running' }, { id: 'b', status: 'waiting', pending: -3 }],
  }));
  assert.deepEqual(rows, [
    { id: 'a', status: 'running', pending: 0 },
    { id: 'b', status: 'waiting', pending: 0 },
  ]);
});

test('applyAttentionPush flips statuses in place without waiting for a fetch', () => {
  const before = [meta({ id: 'a', status: 'idle' }), meta({ id: 'b', status: 'running' })];
  const { sessions, needsFetch } = applyAttentionPush(before, [
    { id: 'a', status: 'running', pending: 0 },
    { id: 'b', status: 'idle', pending: 0 },
  ]);
  assert.deepEqual(sessions.map((s) => [s.id, s.status]), [['a', 'running'], ['b', 'idle']]);
  assert.equal(needsFetch, false);
  // Immutable: the input rows are untouched.
  assert.equal(before[0].status, 'idle');
});

test('applyAttentionPush keeps identity for untouched rows', () => {
  const before = [meta({ id: 'a', status: 'idle' }), meta({ id: 'b', status: 'running' })];
  const { sessions } = applyAttentionPush(before, [
    { id: 'a', status: 'idle', pending: 0 },
    { id: 'b', status: 'waiting', pending: 0 },
  ]);
  assert.equal(sessions[0], before[0]);
  assert.notEqual(sessions[1], before[1]);
});

test('applyAttentionPush clears a stored pending ask the moment its count hits 0', () => {
  const before = [meta({ id: 'a', status: 'waiting', pending: { id: 'p', tool: 'Bash', detail: 'x' } })];
  const { sessions, needsFetch } = applyAttentionPush(before, [{ id: 'a', status: 'running', pending: 0 }]);
  assert.equal(sessions[0].pending, null);
  assert.equal(sessions[0].status, 'running');
  assert.equal(needsFetch, false);
});

test('applyAttentionPush asks for a fetch when a pending ask needs details it does not have', () => {
  const before = [meta({ id: 'a', status: 'running' })];
  const { sessions, needsFetch } = applyAttentionPush(before, [{ id: 'a', status: 'waiting', pending: 1 }]);
  // Status flips now; the tool/detail/expiry arrive with the fetch.
  assert.equal(sessions[0].status, 'waiting');
  assert.equal(needsFetch, true);
});

test('applyAttentionPush asks for a fetch when sessions appear or disappear', () => {
  const before = [meta({ id: 'a' })];
  assert.equal(applyAttentionPush(before, [
    { id: 'a', status: 'idle', pending: 0 }, { id: 'new', status: 'running', pending: 0 },
  ]).needsFetch, true);
  assert.equal(applyAttentionPush(before, []).needsFetch, true);
});

test('applyAttentionPush before any fetch leaves the store null and asks for one', () => {
  const { sessions, needsFetch } = applyAttentionPush(null, [{ id: 'a', status: 'waiting', pending: 1 }]);
  assert.equal(sessions, null);
  assert.equal(needsFetch, true);
});
