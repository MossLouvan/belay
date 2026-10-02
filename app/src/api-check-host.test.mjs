// `checkHost` and `revokeSelf` against a mocked fetch.
//
//   cd app && node --test src/api-check-host.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { checkHost, NOT_BELAY, revokeSelf } from './api.ts';

function withFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

const device = {
  id: 'mac', label: 'Mac', platform: 'darwin', token: 'tok', addedAt: 1,
  addresses: [{ kind: 'lan', url: 'http://10.0.0.5:8787' }],
};

test('a 200 that is not JSON is "isn\'t Belay", not a parser error (#86)', async () => {
  const restore = withFetch(async () => ({
    ok: true, status: 200,
    json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); },
  }));
  try {
    const check = await checkHost('http://127.0.0.1:8081');
    assert.equal(check.ok, false);
    assert.equal(check.error, NOT_BELAY);
  } finally { restore(); }
});

test('a 200 JSON body that is not an object is also not Belay', async () => {
  const restore = withFetch(async () => ({ ok: true, status: 200, json: async () => 'hello' }));
  try {
    assert.equal((await checkHost('http://x')).error, NOT_BELAY);
  } finally { restore(); }
});

test('revokeSelf posts the hashed-token prefix with the device\'s own bearer (#83)', async () => {
  const calls = [];
  const restore = withFetch(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  try {
    await revokeSelf({ ...device, lastKnownGoodUrl: 'http://10.0.0.5:8787' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://10.0.0.5:8787/devices/revoke');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
    const expected = createHash('sha256').update('tok', 'utf8').digest('hex').slice(0, 8);
    assert.deepEqual(JSON.parse(calls[0].init.body), { prefix: expected });
  } finally { restore(); }
});

test('revokeSelf rejects on a refusal, so forget can carry on regardless', async () => {
  const restore = withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await assert.rejects(revokeSelf(device));
  } finally { restore(); }
});
