// Tests for the hook HTTP surface: the loopback + secret gate, the "is a
// phone even listening?" short-circuit, the decision round-trip between the
// hook's held request and the phone's POST, and the ways a held request ends
// without a decision. A real express app on an ephemeral port; the store is
// real, the phone count and clock are injected. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHooksStore } from '../src/hooks-store.js';
import { hookWaitMs, projectTitle, registerHookRoutes, HOOK_REASON_HEADER } from '../src/hooks-routes.js';
import type { HookRouteDeps } from '../src/hooks-routes.js';
import { HOOK_SECRET_HEADER } from '../src/hooks-secret.js';
import type { NotifyEvent } from '../src/notify.js';

const SECRET = 'a'.repeat(64);
const TOKEN = 'phone-token';

const ask = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess-1', transcript_path: '/t.jsonl', cwd: '/Users/me/projects/belay', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
  ...over,
});

interface Harness {
  readonly url: string;
  readonly store: ReturnType<typeof createHooksStore>;
  readonly pings: NotifyEvent[];
  phones: number;
  belay: Set<string>;
  starts: number;
  close(): Promise<void>;
}

async function harness(over: Partial<HookRouteDeps> = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const store = createHooksStore({ newId: (() => { let n = 0; return () => `h${++n}`; })() });
  const pings: NotifyEvent[] = [];
  const h = { phones: 1, belay: new Set<string>(), starts: 0 };
  const auth: express.RequestHandler = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) next(); else res.status(401).json({ error: 'unauthorized' });
  };
  registerHookRoutes(app, auth, {
    store, secret: SECRET, waitMs: 500, phonePollMs: 20,
    phones: () => h.phones,
    isBelaySession: (id) => h.belay.has(id),
    onSessionStart: () => { h.starts += 1; },
    notify: (ev) => { pings.push(ev); },
    hostLabel: () => 'mac', hostId: () => 'host-1',
    ...over,
  });
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, store, pings,
    get phones() { return h.phones; }, set phones(v) { h.phones = v; },
    get belay() { return h.belay; }, set belay(v) { h.belay = v; },
    get starts() { return h.starts; }, set starts(v) { h.starts = v; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const hookPost = (url: string, event: string, body: unknown, secret = SECRET) =>
  fetch(`${url}/hooks/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HOOK_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
  });

const phone = (url: string, path: string, method = 'GET', body?: unknown) =>
  fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const until = async (pred: () => boolean, ms = 500): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---- gate ------------------------------------------------------------------

test('a hook POST without the secret is refused; a phone route without bearer is refused', async () => {
  const h = await harness();
  try {
    const r = await hookPost(h.url, 'Stop', ask({ hook_event_name: 'Stop' }), 'b'.repeat(64));
    assert.equal(r.status, 401);
    const r2 = await fetch(`${h.url}/hooks/Stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 401);
    const r3 = await fetch(`${h.url}/agent/hooks`);
    assert.equal(r3.status, 401);
  } finally { await h.close(); }
});

test('a malformed payload or a mismatched event name is a 400, never an ask', async () => {
  const h = await harness();
  try {
    assert.equal((await hookPost(h.url, 'PermissionRequest', { nope: 1 })).status, 400);
    assert.equal((await hookPost(h.url, 'Stop', ask())).status, 400);
    assert.equal((await hookPost(h.url, 'PreToolUse', ask({ hook_event_name: 'PreToolUse' }))).status, 400);
    assert.deepEqual(h.store.pending(), []);
  } finally { await h.close(); }
});

// ---- short-circuits --------------------------------------------------------

test('no phone connected: the hook gets {} at once and nothing is pending', async () => {
  const h = await harness();
  h.phones = 0;
  try {
    const r = await hookPost(h.url, 'PermissionRequest', ask());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(HOOK_REASON_HEADER), 'no-phone');
    assert.deepEqual(await r.json(), {});
    assert.deepEqual(h.store.pending(), []);
    assert.deepEqual(h.pings, []);
  } finally { await h.close(); }
});

test('a Belay-spawned session is not double-prompted: {} at once', async () => {
  const h = await harness();
  h.belay = new Set(['sess-1']);
  try {
    const r = await hookPost(h.url, 'PermissionRequest', ask());
    assert.equal(r.headers.get(HOOK_REASON_HEADER), 'belay-session');
    assert.deepEqual(await r.json(), {});
    assert.deepEqual(h.store.pending(), []);
  } finally { await h.close(); }
});

// ---- round trip ------------------------------------------------------------

test('phone allows: the held hook request resolves with an allow decision', async () => {
  const h = await harness();
  try {
    const held = hookPost(h.url, 'PermissionRequest', ask());
    await until(() => h.store.pending().length === 1);
    const list = await (await phone(h.url, '/agent/hooks')).json();
    assert.equal(list.permissions.length, 1);
    assert.equal(list.permissions[0].tool, 'Bash');
    assert.equal(list.permissions[0].cwd, '/Users/me/projects/belay');
    assert.equal(h.pings.length, 1);
    assert.equal(h.pings[0].kind, 'approval');
    assert.equal(h.pings[0].session.title, 'belay');

    const d = await (await phone(h.url, `/agent/hooks/${list.permissions[0].id}/decide`, 'POST', { allow: true })).json();
    assert.deepEqual(d, { ok: true });
    const r = await held;
    assert.equal(r.headers.get(HOOK_REASON_HEADER), 'decided');
    assert.deepEqual(await r.json(), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    assert.deepEqual(h.store.pending(), []);
  } finally { await h.close(); }
});

test('phone denies with a scope choice ignored; deny carries a message', async () => {
  const h = await harness();
  try {
    const held = hookPost(h.url, 'PermissionRequest', ask());
    await until(() => h.store.pending().length === 1);
    await phone(h.url, '/agent/hooks/h1/decide', 'POST', { allow: false, choice: 'suggest-0' });
    const out = await (await held).json();
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(out.hookSpecificOutput.decision.message, /phone/);
  } finally { await h.close(); }
});

test('"allow for session" echoes the suggestion with the session destination', async () => {
  const h = await harness();
  try {
    const held = hookPost(h.url, 'PermissionRequest', ask());
    await until(() => h.store.pending().length === 1);
    await phone(h.url, '/agent/hooks/h1/decide', 'POST', { allow: true, choice: 'suggest-0' });
    const out = await (await held).json();
    assert.deepEqual(out.hookSpecificOutput.decision.updatedPermissions, [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' },
    ]);
  } finally { await h.close(); }
});

test('a bad decide body is a 400; an unknown id is ok:false', async () => {
  const h = await harness();
  try {
    assert.equal((await phone(h.url, '/agent/hooks/h1/decide', 'POST', { allow: 'yes' })).status, 400);
    assert.deepEqual(await (await phone(h.url, '/agent/hooks/nope/decide', 'POST', { allow: true })).json(), { ok: false });
  } finally { await h.close(); }
});

// ---- no decision -----------------------------------------------------------

test('the wait runs out: {} and the ask is gone (Claude Code shows its own prompt)', async () => {
  const h = await harness({ waitMs: 60 });
  try {
    const r = await hookPost(h.url, 'PermissionRequest', ask());
    assert.equal(r.headers.get(HOOK_REASON_HEADER), 'wait-expired');
    assert.deepEqual(await r.json(), {});
    assert.deepEqual(h.store.pending(), []);
  } finally { await h.close(); }
});

test('every phone disconnects mid-wait: {} promptly, not at the deadline', async () => {
  const h = await harness({ waitMs: 5_000 });
  try {
    const held = hookPost(h.url, 'PermissionRequest', ask());
    await until(() => h.store.pending().length === 1);
    h.phones = 0;
    const r = await held;
    assert.equal(r.headers.get(HOOK_REASON_HEADER), 'phone-left');
    assert.deepEqual(await r.json(), {});
    assert.deepEqual(h.store.pending(), []);
  } finally { await h.close(); }
});

test('the hook goes away (Claude Code cancelled it): the ask is withdrawn and a late tap is ok:false', async () => {
  const h = await harness({ waitMs: 5_000 });
  try {
    const ctl = new AbortController();
    const held = fetch(`${h.url}/hooks/PermissionRequest`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', [HOOK_SECRET_HEADER]: SECRET },
      body: JSON.stringify(ask()),
    }).catch(() => null);
    await until(() => h.store.pending().length === 1);
    ctl.abort();
    await held;
    await until(() => h.store.pending().length === 0);
    assert.deepEqual(await (await phone(h.url, '/agent/hooks/h1/decide', 'POST', { allow: true })).json(), { ok: false });
  } finally { await h.close(); }
});

// ---- notices ---------------------------------------------------------------

test('Stop and permission_prompt become notices the phone lists and dismisses; SessionStart rescans', async () => {
  const h = await harness();
  try {
    await hookPost(h.url, 'Stop', ask({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'All green.' }));
    await hookPost(h.url, 'Notification', ask({ hook_event_name: 'Notification', session_id: 'sess-2', notification_type: 'permission_prompt', message: 'needs you' }));
    await hookPost(h.url, 'SessionStart', ask({ hook_event_name: 'SessionStart', source: 'startup' }));
    assert.equal(h.starts, 1);
    assert.equal(h.pings.filter((p) => p.kind === 'done').length, 1);
    const list = await (await phone(h.url, '/agent/hooks')).json();
    assert.deepEqual(list.notices.map((n: { kind: string }) => n.kind), ['terminal-prompt', 'done']);
    const doneId = list.notices[1].id;
    assert.deepEqual(await (await phone(h.url, `/agent/hooks/${doneId}/dismiss`, 'POST')).json(), { ok: true });
    assert.equal((await (await phone(h.url, '/agent/hooks')).json()).notices.length, 1);
  } finally { await h.close(); }
});

// ---- helpers ---------------------------------------------------------------

test('hookWaitMs defaults, parses and clamps', () => {
  assert.equal(hookWaitMs(undefined), 120_000);
  assert.equal(hookWaitMs('junk'), 120_000);
  assert.equal(hookWaitMs('30000'), 30_000);
  assert.equal(hookWaitMs('10'), 5_000);
  assert.equal(hookWaitMs('99999999'), 570_000);
});

test('projectTitle is the last path segment', () => {
  assert.equal(projectTitle('/Users/me/projects/belay'), 'belay');
  assert.equal(projectTitle('C:\\work\\thing'), 'C:\\work\\thing'.split('/').pop());
});
