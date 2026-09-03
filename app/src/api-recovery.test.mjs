// The REST self-heal: a control request that fails at the network layer must
// re-race the connection once and retry, so a phone roaming off Wi-Fi doesn't
// leave the cursor dead until a manual reconnect.
//
//   cd app && node --test src/api-recovery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, setConnection, setRecoveryHandler, TimeoutError, UnauthorizedError } from './api.ts';

const conn = { host: 'http://host.test:8787', token: 'tok', hostName: 'PC' };

function withFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

test('a network failure heals the connection and the retry succeeds', async () => {
  setConnection(conn);
  let recovered = 0;
  setRecoveryHandler(async () => { recovered += 1; });
  let calls = 0;
  const restore = withFetch(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Network request failed'); // roam: half-open socket
    return okResponse();
  });
  try {
    await api.move(0.5, 0.5);
    assert.equal(calls, 2, 'the request was retried once');
    assert.equal(recovered, 1, 'recovery ran exactly once before the retry');
  } finally {
    restore();
    setRecoveryHandler(null);
  }
});

test('a timeout is retryable too', async () => {
  setConnection(conn);
  setRecoveryHandler(async () => {});
  let calls = 0;
  const restore = withFetch(async () => {
    calls += 1;
    if (calls === 1) throw new TimeoutError('/input/move');
    return okResponse();
  });
  try {
    await api.move(0.1, 0.1);
    assert.equal(calls, 2);
  } finally {
    restore();
    setRecoveryHandler(null);
  }
});

test('a 401 is terminal — never recovered, never retried', async () => {
  setConnection(conn);
  let recovered = 0;
  setRecoveryHandler(async () => { recovered += 1; });
  let calls = 0;
  const restore = withFetch(async () => {
    calls += 1;
    return { ok: false, status: 401, json: async () => ({}) };
  });
  try {
    await assert.rejects(() => api.click(0.5, 0.5), (e) => e instanceof UnauthorizedError);
    assert.equal(calls, 1, 'no retry on a bad token');
    assert.equal(recovered, 0, 're-racing a revoked token would only loop');
  } finally {
    restore();
    setRecoveryHandler(null);
  }
});

test('a second failure after recovery is surfaced, not retried forever', async () => {
  setConnection(conn);
  setRecoveryHandler(async () => {});
  let calls = 0;
  const restore = withFetch(async () => { calls += 1; throw new TypeError('down'); });
  try {
    await assert.rejects(() => api.move(0.5, 0.5));
    assert.equal(calls, 2, 'exactly one retry, then give up');
  } finally {
    restore();
    setRecoveryHandler(null);
  }
});
