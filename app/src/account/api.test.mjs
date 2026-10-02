// Unit tests for the accounts API client, against a mocked fetch.
//
//   cd app && node --test src/account/api.test.mjs
//
// The accounts service is built in parallel against the contract in
// openspec/changes/belay-network/design.md; these tests pin the client to
// that table, not to a running server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccountsError, DEFAULT_ACCOUNTS_URL, createAccountsApi, friendlyMessage } from './api.ts';

/** A fetch that records calls and answers from a queue. */
function mockFetch(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = answers.shift() ?? { status: 204 };
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

const SESSION = 'sess_abc';
const api = (f, session = SESSION) => createAccountsApi({ fetch: f, session: () => session });

test('the default base URL is the production API', () => {
  assert.equal(DEFAULT_ACCOUNTS_URL, 'https://api.gobelay.com/v1');
});

test('email start posts the address and accepts a 204', async () => {
  const { fetch, calls } = mockFetch({ status: 204 });
  await api(fetch).startEmail('Someone@Example.com ');
  assert.equal(calls[0].url, `${DEFAULT_ACCOUNTS_URL}/auth/email/start`);
  assert.equal(calls[0].init.method, 'POST');
  // Normalised before it leaves the phone: the code is keyed on the address.
  assert.deepEqual(calls[0].body, { email: 'someone@example.com' });
  assert.equal(calls[0].init.headers.authorization, undefined, 'no session on an auth route');
});

test('email verify returns the session and account', async () => {
  const account = { id: 'acc_1', email: 'a@b.c', createdAt: '2026-10-02T00:00:00Z' };
  const { fetch, calls } = mockFetch({ body: { session: 's1', account } });
  const result = await api(fetch, null).verifyEmail('a@b.c', '123456');
  assert.deepEqual(calls[0].body, { email: 'a@b.c', code: '123456' });
  assert.deepEqual(result, { session: 's1', account });
});

test('apple and google sign-in post the contract bodies', async () => {
  const { fetch, calls } = mockFetch(
    { body: { nonce: 'server-nonce' } },
    { body: { session: 's', account: { id: 'a' } } },
    { body: { session: 's', account: { id: 'a' } } },
  );
  assert.equal(await api(fetch, null).nonce(), 'server-nonce');
  assert.equal(calls[0].url, `${DEFAULT_ACCOUNTS_URL}/auth/nonce`);
  assert.equal(calls[0].init.method, 'POST');
  await api(fetch, null).signInApple('jwt', 'server-nonce');
  await api(fetch, null).signInGoogle('idtok');
  assert.equal(calls[1].url, `${DEFAULT_ACCOUNTS_URL}/auth/apple`);
  assert.deepEqual(calls[1].body, { identityToken: 'jwt', nonce: 'server-nonce' });
  assert.equal(calls[2].url, `${DEFAULT_ACCOUNTS_URL}/auth/google`);
  assert.deepEqual(calls[2].body, { idToken: 'idtok' });
});

test('session routes carry the bearer session', async () => {
  const { fetch, calls } = mockFetch({ body: { devices: [] } });
  await api(fetch).listDevices();
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SESSION}`);
  assert.equal(calls[0].init.method, 'GET');
});

test('a session route without a session fails before any request', async () => {
  const { fetch, calls } = mockFetch();
  await assert.rejects(api(fetch, null).me(), (e) => e instanceof AccountsError && e.code === 'no_session');
  assert.equal(calls.length, 0);
});

test('register phone, accept claim and delete account use the contract paths', async () => {
  const device = { id: 'd1', kind: 'phone', name: 'iPhone', platform: 'ios', nodeId: 'n1', lastSeenAt: null };
  const { fetch, calls } = mockFetch({ body: { device } }, { body: { device } }, { status: 204 }, { status: 204 }, { status: 204 });
  const a = api(fetch);
  assert.deepEqual(await a.registerPhone('iPhone', 'n1', 'ios'), device);
  assert.deepEqual(calls[0].body, { kind: 'phone', name: 'iPhone', nodeId: 'n1', platform: 'ios' });
  assert.deepEqual(await a.acceptClaim('abcd efgh'), device);
  // Claim codes are base32 and shown in upper case; typed/scanned spacing is tolerated.
  assert.equal(calls[1].url, `${DEFAULT_ACCOUNTS_URL}/claims/ABCDEFGH/accept`);
  await a.deleteMe();
  assert.equal(calls[2].init.method, 'DELETE');
  assert.equal(calls[2].url, `${DEFAULT_ACCOUNTS_URL}/me`);
  await a.removeDevice('d1');
  assert.equal(calls[3].url, `${DEFAULT_ACCOUNTS_URL}/devices/d1`);
  await a.logout();
  assert.equal(calls[4].url, `${DEFAULT_ACCOUNTS_URL}/auth/logout`);
  assert.equal(calls[4].init.headers.authorization, `Bearer ${SESSION}`);
});

test('accepting a claim: 409 is "already linked", 404 is one friendly message for any bad code', async () => {
  const { fetch } = mockFetch(
    { status: 409, body: { error: 'conflict', code: 'device_exists' } },
    { status: 404, body: { error: 'not found', code: 'claim_not_found' } },
    { status: 404, body: { error: 'expired', code: 'claim_expired' } },
  );
  const a = api(fetch);
  await assert.rejects(a.acceptClaim('ABCDEFGH'), (e) => {
    assert.equal(e.code, 'already_linked');
    assert.match(e.message, /already linked — remove it first/);
    return true;
  });
  const first = await a.acceptClaim('ABCDEFGH').catch((e) => e);
  const second = await a.acceptClaim('ABCDEFGH').catch((e) => e);
  assert.equal(first.code, 'claim_not_found');
  assert.equal(first.message, second.message, 'unknown, taken and expired read the same');
});

test('the {error, code} envelope becomes a typed error with a friendly message', async () => {
  const { fetch } = mockFetch({ status: 400, body: { error: 'bad code', code: 'invalid_code' } });
  await assert.rejects(api(fetch, null).verifyEmail('a@b.c', '000000'), (e) => {
    assert.ok(e instanceof AccountsError);
    assert.equal(e.code, 'invalid_code');
    assert.equal(e.status, 400);
    assert.equal(e.message, friendlyMessage('invalid_code', 400, 'bad code'));
    assert.notEqual(e.message, 'bad code');
    return true;
  });
});

test('friendly messages cover the codes a person can act on', () => {
  assert.match(friendlyMessage('invalid_code', 400), /code/i);
  assert.match(friendlyMessage('code_expired', 400), /new code|expired/i);
  assert.match(friendlyMessage('too_many_attempts', 429), /new code|too many/i);
  assert.match(friendlyMessage('rate_limited', 429), /wait|moment/i);
  assert.match(friendlyMessage('claim_not_found', 404), /computer|scan/i);
  assert.match(friendlyMessage('unauthorized', 401), /sign in/i);
  // Unknown code: fall back on the status, then on the server's own text.
  assert.match(friendlyMessage('something_new', 503), /unavailable|try again/i);
  assert.equal(friendlyMessage('something_new', 400, 'server said'), 'server said');
});

test('a 401 is reported as a session problem whatever the body says', async () => {
  const { fetch } = mockFetch({ status: 401, body: {} });
  await assert.rejects(api(fetch).me(), (e) => e instanceof AccountsError && e.code === 'unauthorized');
});

test('a network failure is a friendly offline message, not a stack trace', async () => {
  const { fetch } = mockFetch(new TypeError('Network request failed'));
  await assert.rejects(api(fetch, null).startEmail('a@b.c'), (e) => {
    assert.ok(e instanceof AccountsError);
    assert.equal(e.code, 'network');
    assert.match(e.message, /connect|internet/i);
    return true;
  });
});

test('a non-JSON error body still produces a usable error', async () => {
  const fetch = async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } });
  await assert.rejects(api(fetch, null).startEmail('a@b.c'), (e) => e instanceof AccountsError && e.status === 502);
});

test('the base URL is configurable and trailing slashes are tolerated', async () => {
  const { fetch, calls } = mockFetch({ status: 204 });
  await createAccountsApi({ fetch, baseUrl: 'http://localhost:8787/v1/', session: () => null }).startEmail('a@b.c');
  assert.equal(calls[0].url, 'http://localhost:8787/v1/auth/email/start');
});
