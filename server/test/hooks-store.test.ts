// Tests for the terminal-session approval store: raising a PermissionRequest
// from a hook, the phone deciding it, the hook giving up, and the notices
// (permission_prompt, done) that ride the same channel. Pure and clocked;
// nothing here touches the network or a hook process. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choicesFromSuggestions, createHooksStore, decisionOutput, hookRows,
} from '../src/hooks-store.js';
import type { HookDecision } from '../src/hooks-store.js';
import type { PermissionRequestEvent } from '../src/hooks-validate.js';

const SUGGEST = {
  type: 'addRules' as const,
  rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
  behavior: 'allow' as const,
  destination: 'localSettings' as const,
};

const ask = (over: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent => ({
  kind: 'PermissionRequest',
  sessionId: 's1', cwd: process.cwd(), transcriptPath: '/t.jsonl',
  toolName: 'Bash', toolInput: { command: 'npm test' }, suggestions: [SUGGEST],
  ...over,
});

function makeStore(now = 1_000) {
  let t = now;
  let n = 0;
  const store = createHooksStore({ now: () => t, newId: () => `id${++n}`, noticeTtlMs: 60_000 });
  return { store, tick: (ms: number) => { t += ms; } };
}

// ---- choices ---------------------------------------------------------------

test('choicesFromSuggestions offers each allow rule as a session-scoped choice', () => {
  const choices = choicesFromSuggestions('Bash', { command: 'npm test' }, process.cwd(), [SUGGEST]);
  assert.deepEqual(choices, [{ id: 'suggest-0', label: 'Always allow Bash(npm test) (this session)' }]);
});

test('choicesFromSuggestions skips deny/ask rules and offers nothing for danger-tier asks', () => {
  assert.deepEqual(choicesFromSuggestions('Bash', { command: 'ls' }, process.cwd(), [{ ...SUGGEST, behavior: 'deny' }]), []);
  assert.deepEqual(choicesFromSuggestions('Bash', { command: 'rm -rf /' }, process.cwd(), [SUGGEST]), []);
});

test('choicesFromSuggestions labels a whole-tool rule honestly', () => {
  const choices = choicesFromSuggestions('Read', { file_path: 'a' }, process.cwd(), [
    { ...SUGGEST, rules: [{ toolName: 'Read' }] },
  ]);
  assert.deepEqual(choices, [{ id: 'suggest-0', label: 'Always allow every Read (this session)' }]);
});

// ---- raise / decide --------------------------------------------------------

test('raise publishes a pending item with the approval-card fields', () => {
  const { store } = makeStore();
  const { item } = store.raise(ask(), 30_000);
  assert.equal(item.id, 'id1');
  assert.equal(item.sessionId, 's1');
  assert.equal(item.tool, 'Bash');
  assert.equal(item.detail, 'npm test');
  assert.equal(item.risk, 'run');
  assert.deepEqual(item.preview, { kind: 'command', command: 'npm test' });
  assert.equal(item.expiresAt, 31_000);
  assert.equal(item.choices.length, 1);
  assert.deepEqual(store.pending().map((p) => p.id), ['id1']);
});

test('decide allow resolves the hook with an allow decision and clears the item', async () => {
  const { store } = makeStore();
  const { decision } = store.raise(ask(), 30_000);
  assert.equal(store.decide('id1', true), true);
  const d = await decision;
  assert.deepEqual(d, { behavior: 'allow' });
  assert.deepEqual(store.pending(), []);
});

test('decide deny carries a message the terminal session can read', async () => {
  const { store } = makeStore();
  const { decision } = store.raise(ask(), 30_000);
  store.decide('id1', false);
  const d = await decision;
  assert.equal(d?.behavior, 'deny');
  if (d?.behavior !== 'deny') return;
  assert.match(d.message, /denied from the phone/i);
});

test('a scope choice echoes the suggestion back with the session destination only', async () => {
  const { store } = makeStore();
  const { decision } = store.raise(ask(), 30_000);
  assert.equal(store.decide('id1', true, 'suggest-0'), true);
  const d = await decision;
  assert.deepEqual(d, {
    behavior: 'allow',
    updatedPermissions: [{ ...SUGGEST, destination: 'session' }],
  });
});

test('an unknown choice allows once and grants nothing', async () => {
  const { store } = makeStore();
  const { decision } = store.raise(ask(), 30_000);
  store.decide('id1', true, 'suggest-9');
  assert.deepEqual(await decision, { behavior: 'allow' });
});

test('deciding an unknown or already-decided id is a no-op false', () => {
  const { store } = makeStore();
  store.raise(ask(), 30_000);
  assert.equal(store.decide('nope', true), false);
  assert.equal(store.decide('id1', true), true);
  assert.equal(store.decide('id1', true), false);
});

test('withdraw (hook timed out or went away) resolves null and clears the item', async () => {
  const { store } = makeStore();
  const { decision } = store.raise(ask(), 30_000);
  store.withdraw('id1');
  assert.equal(await decision, null);
  assert.deepEqual(store.pending(), []);
  // Late phone tap after the hook is gone: nothing to answer.
  assert.equal(store.decide('id1', true), false);
});

test('two asks from parallel tool calls stand side by side, keyed apart', () => {
  const { store } = makeStore();
  store.raise(ask(), 30_000);
  store.raise(ask({ toolName: 'Read', toolInput: { file_path: '/x' } }), 30_000);
  assert.deepEqual(store.pending().map((p) => p.tool), ['Bash', 'Read']);
});

test('onChange fires on raise, decide, withdraw and notice', () => {
  const { store } = makeStore();
  let n = 0;
  const off = store.onChange(() => { n++; });
  store.raise(ask(), 30_000);
  store.decide('id1', false);
  store.raise(ask(), 30_000);
  store.withdraw('id2');
  store.notice({ kind: 'Stop', sessionId: 's1', cwd: '/p', transcriptPath: '', stopHookActive: false, lastAssistantMessage: 'done' });
  assert.equal(n, 5);
  off();
  store.raise(ask(), 30_000);
  assert.equal(n, 5);
});

// ---- notices ---------------------------------------------------------------

test('Stop becomes a done notice with the tail of the last message; re-entrant stops are ignored', () => {
  const { store } = makeStore();
  store.notice({ kind: 'Stop', sessionId: 's1', cwd: '/p', transcriptPath: '', stopHookActive: false, lastAssistantMessage: 'All green.' });
  store.notice({ kind: 'Stop', sessionId: 's1', cwd: '/p', transcriptPath: '', stopHookActive: true, lastAssistantMessage: 'again' });
  const list = store.notices();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'done');
  assert.equal(list[0].text, 'All green.');
});

test('a permission_prompt notification becomes a terminal-prompt notice; other types are dropped', () => {
  const { store } = makeStore();
  store.notice({ kind: 'Notification', sessionId: 's1', cwd: '/p', transcriptPath: '', notificationType: 'permission_prompt', message: 'Claude needs your permission', title: '' });
  store.notice({ kind: 'Notification', sessionId: 's1', cwd: '/p', transcriptPath: '', notificationType: 'auth_success', message: 'ok', title: '' });
  const list = store.notices();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'terminal-prompt');
});

test('a done notice replaces an older notice for the same session; dismiss removes; ttl expires', () => {
  const { store, tick } = makeStore();
  store.notice({ kind: 'Notification', sessionId: 's1', cwd: '/p', transcriptPath: '', notificationType: 'permission_prompt', message: 'm', title: '' });
  store.notice({ kind: 'Stop', sessionId: 's1', cwd: '/p', transcriptPath: '', stopHookActive: false, lastAssistantMessage: 'fin' });
  assert.equal(store.notices().length, 1);
  assert.equal(store.notices()[0].kind, 'done');
  store.notice({ kind: 'Stop', sessionId: 's2', cwd: '/q', transcriptPath: '', stopHookActive: false, lastAssistantMessage: 'x' });
  assert.equal(store.dismiss(store.notices()[0].id), true);
  assert.equal(store.notices().length, 1);
  tick(61_000);
  assert.deepEqual(store.notices(), []);
});

test('a permission raise clears a stale terminal-prompt notice for that session', () => {
  const { store } = makeStore();
  store.notice({ kind: 'Notification', sessionId: 's1', cwd: '/p', transcriptPath: '', notificationType: 'permission_prompt', message: 'm', title: '' });
  store.raise(ask(), 30_000);
  assert.deepEqual(store.notices(), []);
});

// ---- wire ------------------------------------------------------------------

test('hookRows squeezes the store down to id, kind, session and time', () => {
  const { store } = makeStore();
  store.raise(ask(), 30_000);
  store.notice({ kind: 'Stop', sessionId: 's2', cwd: '/q', transcriptPath: '', stopHookActive: false, lastAssistantMessage: 'x' });
  assert.deepEqual(hookRows(store), [
    { id: 'id1', kind: 'permission', sessionId: 's1', createdAt: 1000 },
    { id: 'id2', kind: 'done', sessionId: 's2', createdAt: 1000 },
  ]);
});

test('decisionOutput wraps a decision in the PermissionRequest hook envelope; null is an empty object', () => {
  const allow: HookDecision = { behavior: 'allow' };
  assert.deepEqual(decisionOutput(allow), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.deepEqual(decisionOutput(null), {});
});
