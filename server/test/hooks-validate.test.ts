// Tests for the hook payload boundary: what Claude Code's hook process may
// hand the host, and what it may not. Everything unrecognised fails, never
// half-parses. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHookPayload, validateHookDecisionBody } from '../src/hooks-validate.js';

const base = {
  session_id: '00893aaf-19fa-41d2-8238-13269b9b3ca0',
  transcript_path: '/Users/me/.claude/projects/-Users-me-app/00893aaf.jsonl',
  cwd: '/Users/me/app',
  permission_mode: 'default',
};

test('PermissionRequest: tool, input, cwd and suggestions come through', () => {
  const r = validateHookPayload({
    ...base,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.event.kind, 'PermissionRequest');
  if (r.event.kind !== 'PermissionRequest') return;
  assert.equal(r.event.sessionId, base.session_id);
  assert.equal(r.event.cwd, '/Users/me/app');
  assert.equal(r.event.toolName, 'Bash');
  assert.deepEqual(r.event.toolInput, { command: 'npm test' });
  // Only addRules entries are kept — those are the only ones a phone tap may echo back.
  assert.deepEqual(r.event.suggestions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
  ]);
});

test('PermissionRequest: suggestions are optional and malformed entries are dropped', () => {
  const r = validateHookPayload({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: {} });
  assert.equal(r.ok, true);
  if (!r.ok || r.event.kind !== 'PermissionRequest') return;
  assert.deepEqual(r.event.suggestions, []);
  const r2 = validateHookPayload({
    ...base, hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: {},
    permission_suggestions: [{ type: 'addRules', rules: 'nope', behavior: 'allow', destination: 'session' }, 'junk'],
  });
  assert.equal(r2.ok, true);
  if (!r2.ok || r2.event.kind !== 'PermissionRequest') return;
  assert.deepEqual(r2.event.suggestions, []);
});

test('PermissionRequest without a tool name is refused', () => {
  const r = validateHookPayload({ ...base, hook_event_name: 'PermissionRequest', tool_input: {} });
  assert.equal(r.ok, false);
});

test('Notification carries its type and message', () => {
  const r = validateHookPayload({
    ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt',
    message: 'Claude needs your permission', title: 'Permission needed',
  });
  assert.equal(r.ok, true);
  if (!r.ok || r.event.kind !== 'Notification') return;
  assert.equal(r.event.notificationType, 'permission_prompt');
  assert.equal(r.event.message, 'Claude needs your permission');
  assert.equal(r.event.title, 'Permission needed');
});

test('Stop carries the last assistant message, capped, and the re-entry flag', () => {
  const r = validateHookPayload({
    ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'x'.repeat(5000),
  });
  assert.equal(r.ok, true);
  if (!r.ok || r.event.kind !== 'Stop') return;
  assert.equal(r.event.stopHookActive, false);
  assert.equal(r.event.lastAssistantMessage.length, 600);
});

test('SessionStart carries its source', () => {
  const r = validateHookPayload({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.ok, true);
  if (!r.ok || r.event.kind !== 'SessionStart') return;
  assert.equal(r.event.source, 'startup');
});

test('unknown events, bad session ids and non-objects are refused', () => {
  assert.equal(validateHookPayload(null).ok, false);
  assert.equal(validateHookPayload('str').ok, false);
  assert.equal(validateHookPayload({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }).ok, false);
  assert.equal(validateHookPayload({ ...base, session_id: '../etc', hook_event_name: 'Stop' }).ok, false);
  assert.equal(validateHookPayload({ ...base, session_id: '', hook_event_name: 'Stop' }).ok, false);
  assert.equal(validateHookPayload({ ...base, cwd: 42, hook_event_name: 'Stop' }).ok, false);
});

test('validateHookDecisionBody: allow is a boolean, choice an optional short string', () => {
  assert.deepEqual(validateHookDecisionBody({ allow: true }), { ok: true, allow: true, choiceId: undefined });
  assert.deepEqual(validateHookDecisionBody({ allow: false, choice: 'suggest-0' }), { ok: true, allow: false, choiceId: 'suggest-0' });
  assert.equal(validateHookDecisionBody({ allow: 'yes' }).ok, false);
  assert.equal(validateHookDecisionBody({}).ok, false);
  assert.equal(validateHookDecisionBody({ allow: true, choice: 'x'.repeat(200) }).ok, false);
  assert.equal(validateHookDecisionBody(null).ok, false);
});
