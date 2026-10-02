// The terminal session store (#90): the shell socket and its screen buffer
// live at module level so a tab switch — which unmounts the route — neither
// closes the socket nor loses the scrollback.
//
//   cd app && node --test src/terminal/session-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureTermSession, flushTerm, getTermSession, reopenTermSession, setTermGeometry, subscribeTermSession,
} from './session-store.ts';
import { termToText } from '../terminal-ansi.ts';

class FakeSocket {
  constructor() { this.readyState = 0; this.sent = []; this.closed = false; }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const opener = (socket) => async () => socket;

test('a second mount with the same host keeps the socket and the scrollback', async () => {
  setTermGeometry({ cols: 40, rows: 10 });
  const key = { host: 'a' };
  const a = new FakeSocket();
  ensureTermSession(key, opener(a));
  await tick();
  a.open();
  a.push({ type: 'ready', mode: 'pipe' });
  a.push({ type: 'data', data: 'hello\r\n' });
  flushTerm();
  assert.equal(getTermSession().status, 'open');
  assert.equal(getTermSession().mode, 'pipe');
  assert.equal(termToText(getTermSession().term), 'hello\n');

  const b = new FakeSocket();
  let bOpened = 0;
  ensureTermSession(key, async () => { bOpened += 1; return b; });
  await tick();
  assert.equal(bOpened, 0, 'no new socket for the same host');
  assert.equal(a.closed, false, 'the live socket is kept');
  assert.equal(termToText(getTermSession().term), 'hello\n');
});

test('a different host ends the old shell and starts fresh', async () => {
  const a = new FakeSocket();
  ensureTermSession({ host: 'a' }, opener(a));
  await tick();
  a.open();
  a.push({ type: 'data', data: 'old' });
  flushTerm();
  const b = new FakeSocket();
  ensureTermSession({ host: 'b' }, opener(b));
  await tick();
  assert.equal(a.closed, true);
  assert.equal(termToText(getTermSession().term), '');
  b.open();
  assert.equal(getTermSession().status, 'open');
});

test('reopen replaces the socket for the same host and notifies subscribers', async () => {
  const a = new FakeSocket();
  ensureTermSession({ host: 'c' }, opener(a));
  await tick();
  a.open();
  let notified = 0;
  const unsub = subscribeTermSession(() => { notified += 1; });
  const b = new FakeSocket();
  reopenTermSession(opener(b));
  await tick();
  assert.equal(a.closed, true);
  assert.ok(notified > 0);
  unsub();
});

test('a closed socket is reopened on the next ensure for the same host', async () => {
  const key = { host: 'd' };
  const a = new FakeSocket();
  ensureTermSession(key, opener(a));
  await tick();
  a.open();
  a.onclose?.();
  assert.equal(getTermSession().status, 'closed');
  const b = new FakeSocket();
  ensureTermSession(key, opener(b));
  await tick();
  b.open();
  assert.equal(getTermSession().status, 'open');
});
