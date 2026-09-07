// Tests for the terminal-session ask logic: the push frame's hooks half, the
// merge into the fetched list, the badge count and the row shapes.
//
//   cd app && node --test src/agent/hook-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHooksPush, discoveredFromHook, hookTitle, hookWaitingCount, noticeLine, orderedHookAsks, parseHooksPush,
} from './hook-model.ts';

const ask = (id, over = {}) => ({
  id, sessionId: `sess-${id}`, cwd: '/Users/me/projects/belay', tool: 'Bash', detail: 'npm test',
  input: '{}', risk: 'run', choices: [], createdAt: 100, expiresAt: 100_000, ...over,
});
const notice = (id, over = {}) => ({
  id, kind: 'done', sessionId: `sess-${id}`, cwd: '/p/q', text: 'All green.', createdAt: 50, ...over,
});
const frame = (hooks) => JSON.stringify({ type: 'attention', sessions: [], hooks });

// ---- parseHooksPush ---------------------------------------------------------

test('parseHooksPush reads the hooks half of a frame and nothing else', () => {
  const rows = parseHooksPush(frame([
    { id: 'h1', kind: 'permission', sessionId: 's1', createdAt: 5 },
    { id: 'h2', kind: 'done', sessionId: 's2' },
  ]));
  assert.deepEqual(rows, [
    { id: 'h1', kind: 'permission', sessionId: 's1', createdAt: 5 },
    { id: 'h2', kind: 'done', sessionId: 's2', createdAt: 0 },
  ]);
  assert.deepEqual(parseHooksPush(frame([])), []);
});

test('parseHooksPush is null for an older host, other frames, bad rows, bad JSON', () => {
  assert.equal(parseHooksPush(JSON.stringify({ type: 'attention', sessions: [] })), null);
  assert.equal(parseHooksPush(JSON.stringify({ type: 'feed', hooks: [] })), null);
  assert.equal(parseHooksPush(frame([{ id: 'h1', kind: 'weird', sessionId: 's' }])), null);
  assert.equal(parseHooksPush(frame([{ kind: 'done', sessionId: 's' }])), null);
  assert.equal(parseHooksPush('{nope'), null);
});

// ---- applyHooksPush ---------------------------------------------------------

test('applyHooksPush drops what the push no longer lists, at once', () => {
  const current = { permissions: [ask('h1'), ask('h2')], notices: [notice('n1')] };
  const { hooks, needsFetch } = applyHooksPush(current, [
    { id: 'h2', kind: 'permission', sessionId: 's', createdAt: 0 },
  ]);
  assert.deepEqual(hooks.permissions.map((p) => p.id), ['h2']);
  assert.deepEqual(hooks.notices, []);
  assert.equal(needsFetch, false);
});

test('applyHooksPush keeps identity when nothing moved; a new id needs a fetch', () => {
  const current = { permissions: [ask('h1')], notices: [] };
  const same = applyHooksPush(current, [{ id: 'h1', kind: 'permission', sessionId: 's', createdAt: 0 }]);
  assert.equal(same.hooks, current);
  assert.equal(same.needsFetch, false);
  const fresh = applyHooksPush(current, [
    { id: 'h1', kind: 'permission', sessionId: 's', createdAt: 0 },
    { id: 'h9', kind: 'permission', sessionId: 's', createdAt: 0 },
  ]);
  assert.equal(fresh.hooks, current);
  assert.equal(fresh.needsFetch, true);
});

test('applyHooksPush before any fetch: null, and a fetch only if there is something to fetch', () => {
  assert.deepEqual(applyHooksPush(null, []), { hooks: null, needsFetch: false });
  assert.deepEqual(applyHooksPush(null, [{ id: 'h1', kind: 'done', sessionId: 's', createdAt: 0 }]), { hooks: null, needsFetch: true });
});

// ---- counts and shapes ------------------------------------------------------

test('hookWaitingCount counts asks, not notices; orderedHookAsks is oldest first', () => {
  assert.equal(hookWaitingCount(null), 0);
  const hooks = { permissions: [ask('b', { createdAt: 200 }), ask('a', { createdAt: 100 })], notices: [notice('n')] };
  assert.equal(hookWaitingCount(hooks), 2);
  assert.deepEqual(orderedHookAsks(hooks).map((p) => p.id), ['a', 'b']);
  // The input was not reordered.
  assert.equal(hooks.permissions[0].id, 'b');
});

test('hookTitle is the project folder; discoveredFromHook opens the same transcript view', () => {
  assert.equal(hookTitle(ask('h1')), 'belay');
  assert.equal(hookTitle({ cwd: 'C:\\work\\thing' }), 'thing');
  const d = discoveredFromHook(ask('h1'));
  assert.deepEqual(d, {
    claudeSessionId: 'sess-h1', cwd: '/Users/me/projects/belay', mtime: 100, lastWriteAt: 100, live: true,
    preview: 'Bash  npm test',
  });
  assert.equal(discoveredFromHook(notice('n1')).preview, 'All green.');
});

test('noticeLine labels the kind and squeezes the text to one line', () => {
  assert.deepEqual(noticeLine(notice('n1')), { label: 'done', text: 'All green.' });
  const long = noticeLine(notice('n2', { kind: 'terminal-prompt', text: 'x\n\n'.repeat(80) }), 10);
  assert.equal(long.label, 'prompt waiting at the terminal');
  assert.equal(long.text.length, 10);
  assert.equal(long.text.endsWith('…'), true);
});
