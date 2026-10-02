// Tests for the control-room model: every agent from every source in ONE
// list, needs-you first, and the strip's counts over all of them.
//
//   cd app && node --test src/agent/fleet.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fleetCounts, fleetRows } from './fleet.ts';

const meta = (id, status, over = {}) => ({
  id, title: id, cwd: `/p/${id}`, status, lastUsed: 10, createdAt: 0, ...over,
});
const disc = (id, live, over = {}) => ({ claudeSessionId: id, cwd: `/p/${id}`, preview: 'hi', mtime: 5, lastWriteAt: 5, live, ...over });
const ask = (id, over = {}) => ({
  id, sessionId: `sess-${id}`, cwd: `/p/${id}`, tool: 'Bash', detail: 'rm -rf x', input: '{}', risk: 'run', choices: [],
  createdAt: 100, expiresAt: 100_000, ...over,
});
const done = (id, over = {}) => ({ id, kind: 'done', sessionId: `sess-${id}`, cwd: `/p/${id}`, text: 'ok', createdAt: 1, ...over });

test('fleetRows: one merged list, waiting first, then running, then the rest', () => {
  const rows = fleetRows(
    [meta('idle', 'idle'), meta('run', 'running'), meta('wait', 'waiting', { pending: { id: 'p', tool: 'Edit', detail: 'a.ts' } })],
    [disc('live', true), disc('quiet', false)],
    { permissions: [ask('h1')], notices: [] },
  );
  assert.deepEqual(rows.map((r) => `${r.source}:${r.key}:${r.state}`), [
    'hook:sess-h1:waiting',
    'belay:wait:waiting',
    'belay:run:running',
    'disk:live:running',
    'belay:idle:quiet',
    'disk:quiet:quiet',
  ]);
});

test('fleetRows: a hook ask replaces the discovered row for the same session, and one row per session', () => {
  const rows = fleetRows(
    null,
    [disc('sess-h1', true)],
    { permissions: [ask('h1', { createdAt: 200 }), ask('h1b', { sessionId: 'sess-h1', cwd: '/p/h1', createdAt: 100 })], notices: [] },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'hook');
  assert.equal(rows[0].ask?.id, 'h1b');
  assert.equal(rows[0].moreAsks, 1);
  assert.equal(rows[0].title, 'h1');
});

test('fleetRows: an ask from a Belay-spawned pty session rides that session row', () => {
  const rows = fleetRows(
    [meta('b1', 'idle', { kind: 'pty', live: true })],
    [],
    { permissions: [ask('h1', { belaySessionId: 'b1' })], notices: [] },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'belay');
  assert.equal(rows[0].state, 'waiting');
  assert.equal(rows[0].ask?.id, 'h1');
});

test('fleetRows: a done notice marks its row done, and makes a row when nothing else knows the session', () => {
  const rows = fleetRows([], [disc('sess-n1', false)], { permissions: [], notices: [done('n1'), done('n2')] });
  assert.deepEqual(rows.map((r) => `${r.source}:${r.key}:${r.state}`), ['disk:sess-n1:done', 'hook:sess-n2:done']);
});

test('fleetRows: nothing fetched yet is an empty list, not a crash', () => {
  assert.deepEqual(fleetRows(null, null, null), []);
});

test('fleetCounts: counts every source; done today counts only today\'s done notices', () => {
  const now = Date.UTC(2026, 9, 2, 15, 0, 0);
  const yesterday = now - 36 * 3600 * 1000;
  const counts = fleetCounts(
    [meta('run', 'running'), meta('wait', 'waiting'), meta('idle', 'idle')],
    [disc('live', true), disc('quiet', false)],
    { permissions: [ask('h1')], notices: [done('n1', { createdAt: now - 1000 }), done('n2', { createdAt: yesterday }), done('p', { kind: 'terminal-prompt', createdAt: now })] },
    now,
  );
  assert.deepEqual(counts, { running: 2, waiting: 2, doneToday: 1 });
});

test('fleetCounts: zeros when nothing is known', () => {
  assert.deepEqual(fleetCounts(null, null, null, 0), { running: 0, waiting: 0, doneToday: 0 });
});
