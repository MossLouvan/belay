// The phone half of account trust against a mocked fetch: ask, wait for the
// tap, and every way that wait ends.
//
//   cd app && node --test src/account/account-pair.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askToJoin, waitForApproval } from './account-pair.ts';

const HOST = 'https://127.0.0.1:5555';
const TOKEN_BODY = { token: 't', name: 'Mac', deviceId: 'd', secret: 's', fingerprint: 'f' };

function withFetch(replies) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const [status, body] = replies.length > 1 ? replies.shift() : replies[0];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('first phone: a 200 is a finished pairing', async () => {
  const f = withFetch([[200, { ...TOKEN_BODY, via: 'account' }]]);
  try {
    const r = await askToJoin(HOST, 'iPhone');
    assert.equal(r.kind, 'paired');
    assert.equal(r.result.token, 't');
    assert.equal(f.calls[0].url, `${HOST}/pair/account`);
    assert.equal(f.calls[0].method, 'POST');
  } finally { f.restore(); }
});

test('a later phone: 202 is a pending request', async () => {
  const f = withFetch([[202, { status: 'pending', pendingId: 'p1', expiresInSec: 300 }]]);
  try {
    assert.deepEqual(await askToJoin(HOST, 'iPhone'), { kind: 'pending', pendingId: 'p1' });
  } finally { f.restore(); }
});

test('403 or 404 means this computer will not do account trust: fall back', async () => {
  for (const status of [403, 404]) {
    const f = withFetch([[status, { error: 'no' }]]);
    try {
      assert.equal((await askToJoin(HOST, 'iPhone')).kind, 'unsupported');
    } finally { f.restore(); }
  }
});

test('429 surfaces as a readable error', async () => {
  const f = withFetch([[429, { error: 'too many', retryAfterSec: 60 }]]);
  try {
    const r = await askToJoin(HOST, 'iPhone');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /too many/);
  } finally { f.restore(); }
});

const noSleep = async () => {};

test('waiting: pending, pending, then approved hands back the token', async () => {
  const f = withFetch([[200, { status: 'pending' }], [200, { status: 'pending' }], [200, { ...TOKEN_BODY, status: 'approved' }]]);
  try {
    const r = await waitForApproval(HOST, 'p1', { sleep: noSleep });
    assert.equal(r.kind, 'paired');
    assert.equal(r.result.token, 't');
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[0].url, `${HOST}/pair/account/p1`);
  } finally { f.restore(); }
});

test('waiting: denied and expired end the wait', async () => {
  let f = withFetch([[403, { status: 'denied' }]]);
  try { assert.equal((await waitForApproval(HOST, 'p1', { sleep: noSleep })).kind, 'denied'); } finally { f.restore(); }
  f = withFetch([[404, { status: 'expired' }]]);
  try { assert.equal((await waitForApproval(HOST, 'p1', { sleep: noSleep })).kind, 'expired'); } finally { f.restore(); }
});

test('waiting: a dropped poll is retried, not fatal', async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) throw new TypeError('Network request failed');
    return { ok: true, status: 200, json: async () => ({ ...TOKEN_BODY, status: 'approved' }) };
  };
  try {
    assert.equal((await waitForApproval(HOST, 'p1', { sleep: noSleep })).kind, 'paired');
  } finally { globalThis.fetch = original; }
});

test('Cancel: an aborted wait stops polling and withdraws the request', async () => {
  const f = withFetch([[200, { status: 'pending' }]]);
  const ctl = new AbortController();
  try {
    const r = await waitForApproval(HOST, 'p1', { sleep: async () => { ctl.abort(); }, signal: ctl.signal });
    assert.equal(r.kind, 'cancelled');
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url === `${HOST}/pair/account/p1`));
  } finally { f.restore(); }
});
