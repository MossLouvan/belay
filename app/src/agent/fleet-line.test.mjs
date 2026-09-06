import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetLine } from './fleet-line.ts';

const meta = (id, status, pending) => ({
  id, title: id, cwd: '/p', status, lastUsed: 0, createdAt: 0, ...(pending !== undefined ? { pending } : {}),
});
const disc = (id, live) => ({ claudeSessionId: id, cwd: '/p', preview: '', mtime: 0, live });

test('fleetLine: null when nothing is happening', () => {
  assert.equal(fleetLine(null, null), null);
  assert.equal(fleetLine([], []), null);
  assert.equal(fleetLine([meta('a', 'idle'), meta('b', 'error')], [disc('x', false)]), null);
});

test('fleetLine: counts running, waiting and live in that order', () => {
  const line = fleetLine(
    [meta('a', 'running'), meta('b', 'running'), meta('c', 'waiting'), meta('d', 'idle')],
    [disc('x', true), disc('y', false)],
  );
  assert.deepEqual(line, { text: '2 RUNNING · 1 WAITING · 1 LIVE', warn: true });
});

test('fleetLine: a pending approval counts as waiting, not running, even if status lags', () => {
  const line = fleetLine([meta('a', 'running', { id: 'p', tool: 'Bash', detail: 'ls', expiresAt: 1 })], null);
  assert.deepEqual(line, { text: '1 WAITING', warn: true });
});

test('fleetLine: only live discovered sessions make a line, and it does not warn', () => {
  assert.deepEqual(fleetLine(null, [disc('x', true), disc('y', true)]), { text: '2 LIVE', warn: false });
});

test('fleetLine: running alone does not warn', () => {
  assert.deepEqual(fleetLine([meta('a', 'running')], []), { text: '1 RUNNING', warn: false });
});
