// Tests for the attention push channel: the tiny per-session summary, the
// diff that gates the wire, and the hub that fans a changed summary out to
// every /ws/attention socket. The hub is built against injected deps (a list
// function and a change subscription), so nothing here spawns a session.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionRows, attentionWire, createAttentionHub, rowsEqual,
} from '../src/agent-attention.js';
import type { AttentionSocket } from '../src/agent-attention.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeSocket() {
  const sent: string[] = [];
  const handlers = new Map<string, () => void>();
  const ws: AttentionSocket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => { sent.push(data); },
    on: (event: 'close' | 'message', fn: () => void) => { handlers.set(event, fn); },
  };
  return { ws, sent, close: () => handlers.get('close')?.() };
}

// ---- attentionRows ---------------------------------------------------------

test('attentionRows keeps only id, status and a pending count', () => {
  const rows = attentionRows([
    { id: 'a', status: 'running', pending: null },
    { id: 'b', status: 'waiting', pending: { id: 'p1', tool: 'Bash', detail: 'x', waiting: 2 } },
    { id: 'c', status: 'idle' },
  ]);
  assert.deepEqual(rows, [
    { id: 'a', status: 'running', pending: 0 },
    { id: 'b', status: 'waiting', pending: 3 },
    { id: 'c', status: 'idle', pending: 0 },
  ]);
});

test('attentionRows counts a lone pending ask as 1 when waiting is absent', () => {
  const rows = attentionRows([
    { id: 'a', status: 'waiting', pending: { id: 'p', tool: 'Edit', detail: '' } },
  ]);
  assert.deepEqual(rows, [{ id: 'a', status: 'waiting', pending: 1 }]);
});

// ---- rowsEqual -------------------------------------------------------------

test('rowsEqual is true only for identical id/status/pending sequences', () => {
  const a = [{ id: 'x', status: 'idle', pending: 0 }];
  assert.equal(rowsEqual(a, [{ id: 'x', status: 'idle', pending: 0 }]), true);
  assert.equal(rowsEqual(a, [{ id: 'x', status: 'running', pending: 0 }]), false);
  assert.equal(rowsEqual(a, [{ id: 'x', status: 'idle', pending: 1 }]), false);
  assert.equal(rowsEqual(a, [{ id: 'y', status: 'idle', pending: 0 }]), false);
  assert.equal(rowsEqual(a, []), false);
  assert.equal(rowsEqual([], []), true);
});

// ---- attentionWire ---------------------------------------------------------

test('attentionWire is the typed envelope the phone parses', () => {
  const wire = JSON.parse(attentionWire([{ id: 'a', status: 'waiting', pending: 1 }]));
  assert.equal(wire.type, 'attention');
  assert.deepEqual(wire.sessions, [{ id: 'a', status: 'waiting', pending: 1 }]);
});

// ---- hub -------------------------------------------------------------------

test('hub sends the current summary immediately on connect', () => {
  const hub = createAttentionHub({
    list: () => [{ id: 'a', status: 'running', pending: null }],
    subscribe: () => () => {},
  });
  const { ws, sent } = fakeSocket();
  hub.handle(ws);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]).sessions, [{ id: 'a', status: 'running', pending: 0 }]);
});

test('hub pushes on change, coalesces bursts, and stays silent when the summary is unchanged', async () => {
  let sessions: { id: string; status: string; pending?: { waiting?: number } | null }[] =
    [{ id: 'a', status: 'idle', pending: null }];
  let notify: (() => void) | null = null;
  const hub = createAttentionHub({
    list: () => sessions,
    subscribe: (fn) => { notify = fn; return () => { notify = null; }; },
  });
  const { ws, sent } = fakeSocket();
  hub.handle(ws);
  assert.equal(sent.length, 1);

  // A burst of notifications around one real change lands as one push.
  sessions = [{ id: 'a', status: 'waiting', pending: { waiting: 0 } }];
  notify!(); notify!(); notify!();
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[1]).sessions, [{ id: 'a', status: 'waiting', pending: 1 }]);

  // A notification with no summary change (e.g. a feed event) pushes nothing.
  notify!();
  await tick();
  assert.equal(sent.length, 2);
});

test('hub fans one change out to every socket and unsubscribes after the last close', async () => {
  let subscribed = 0;
  let notify: (() => void) | null = null;
  let sessions = [{ id: 'a', status: 'idle', pending: null }];
  const hub = createAttentionHub({
    list: () => sessions,
    subscribe: (fn) => { subscribed += 1; notify = fn; return () => { subscribed -= 1; notify = null; }; },
  });
  const one = fakeSocket();
  const two = fakeSocket();
  hub.handle(one.ws);
  hub.handle(two.ws);
  assert.equal(subscribed, 1); // one upstream hook however many sockets

  sessions = [{ id: 'a', status: 'running', pending: null }];
  notify!();
  await tick();
  assert.equal(one.sent.length, 2);
  assert.equal(two.sent.length, 2);

  one.close();
  assert.equal(subscribed, 1);
  two.close();
  assert.equal(subscribed, 0);
});
