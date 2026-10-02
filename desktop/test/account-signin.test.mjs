// account-signin.js: signing in on this computer to link it. The session
// that comes out is handed to the host once and dropped — these tests pin the
// API calls, the config gating and the loopback redirect.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountsBase, appleAuthUrl, appleSignIn, emailStart, emailVerify, googleAuthUrl, googleSignIn, loopbackCallback, providers, signInConfig,
} from '../src/account-signin.js';

const BASE = 'http://127.0.0.1:8790/v1';
const SESSION = 'S'.repeat(43);

/** A fetch that answers from `routes` (key: "METHOD url") and records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, body: init.body ? String(init.body) : '', headers: init.headers ?? {} });
    const answer = routes[key];
    if (!answer) return new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), { status: 404 });
    const [status, body] = typeof answer === 'function' ? answer(init) : answer;
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, impl };
}

test('accountsBase follows BELAY_ACCOUNTS_URL like the host, else the product API', () => {
  assert.equal(accountsBase({}), 'https://api.gobelay.com/v1');
  assert.equal(accountsBase({ BELAY_ACCOUNTS_URL: `${BASE}/` }), BASE);
  assert.equal(accountsBase({ TETHER_ACCOUNTS_URL: BASE }), BASE);
});

test('Apple and Google only show when configured', () => {
  assert.deepEqual(providers(signInConfig({})), { apple: false, google: false });
  const google = signInConfig({ BELAY_GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', BELAY_GOOGLE_CLIENT_SECRET: 'GOCSPX-x' });
  assert.deepEqual(providers(google), { apple: false, google: true });
  assert.equal(providers(signInConfig({ BELAY_GOOGLE_CLIENT_ID: 'x' })).google, false, 'a desktop client needs its secret too');
  assert.equal(providers(signInConfig({ BELAY_APPLE_SERVICES_ID: 'com.mosslouvan.belay.signin' })).apple, true);
  assert.equal(providers(signInConfig({ BELAY_APPLE_SERVICES_ID: 'x', BELAY_APPLE_REDIRECT_URL: 'http://gobelay.com/cb' })).apple, false, 'Apple only redirects to https');
});

test('email: start and verify against the accounts API; verify returns only the session', async () => {
  const f = fakeFetch({
    [`POST ${BASE}/auth/email/start`]: [204, null],
    [`POST ${BASE}/auth/email/verify`]: [200, { session: SESSION, account: { id: 'a', email: 'moss@gobelay.com' } }],
  });
  await emailStart(BASE, ' Moss@GoBelay.com ', f.impl);
  assert.equal(await emailVerify(BASE, 'moss@gobelay.com', '246810', f.impl), SESSION);
  assert.deepEqual(f.calls.map((c) => [c.key, JSON.parse(c.body)]), [
    [`POST ${BASE}/auth/email/start`, { email: 'moss@gobelay.com' }],
    [`POST ${BASE}/auth/email/verify`, { email: 'moss@gobelay.com', code: '246810' }],
  ]);
});

test('email: bad input never reaches the network; API errors read as sentences', async () => {
  const f = fakeFetch({ [`POST ${BASE}/auth/email/verify`]: [401, { error: 'wrong code', code: 'invalid_code' }] });
  await assert.rejects(emailStart(BASE, 'not-an-email', f.impl), /email address/);
  await assert.rejects(emailVerify(BASE, 'a@b.co', '12345', f.impl), /6-digit/);
  await assert.rejects(emailVerify(BASE, 'a@b.co', '12345a', f.impl), /6-digit/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(emailVerify(BASE, 'a@b.co', '000000', f.impl), /code is not right/);
  const odd = fakeFetch({ [`POST ${BASE}/auth/email/verify`]: [200, { session: 'has spaces' }] });
  await assert.rejects(emailVerify(BASE, 'a@b.co', '000000', odd.impl), /usable session/);
});

test('googleAuthUrl: PKCE S256, loopback redirect, state, openid email', () => {
  const u = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555/google', state: 'st', challenge: 'ch' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    client_id: 'cid', redirect_uri: 'http://127.0.0.1:5555/google', response_type: 'code', scope: 'openid email',
    state: 'st', code_challenge: 'ch', code_challenge_method: 'S256', prompt: 'select_account',
  });
});

test('appleAuthUrl: fragment id_token to the https relay page, the port rides in state, hashed nonce', () => {
  const u = new URL(appleAuthUrl({ servicesId: 'sid', redirectUri: 'https://gobelay.com/auth/desktop-callback', state: '5555.abc', nonceHash: 'nh' }));
  assert.equal(u.origin + u.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    client_id: 'sid', redirect_uri: 'https://gobelay.com/auth/desktop-callback', response_type: 'code id_token',
    response_mode: 'fragment', state: '5555.abc', nonce: 'nh',
  });
});

test('loopbackCallback: 127.0.0.1 only, wrong path or state is refused, the right one resolves once', async () => {
  const cb = await loopbackCallback({ path: '/google', state: 'good', timeoutMs: 5_000 });
  const url = (q) => `http://127.0.0.1:${cb.port}${q}`;
  assert.equal((await fetch(url('/other?state=good'))).status, 404);
  assert.equal((await fetch(url('/google?state=bad&code=x'))).status, 400);
  assert.equal((await fetch(url('/google?state=good&code=c1'))).status, 200);
  assert.equal((await cb.params).get('code'), 'c1');
  await assert.rejects(fetch(url('/google?state=good&code=c2')), 'the listener is closed after one answer');
});

test('loopbackCallback: an OAuth error or a timeout rejects', async () => {
  const cb = await loopbackCallback({ path: '/google', state: 's', timeoutMs: 5_000 });
  await fetch(`http://127.0.0.1:${cb.port}/google?state=s&error=access_denied`);
  await assert.rejects(cb.params, /access_denied/);
  const slow = await loopbackCallback({ path: '/google', state: 's', timeoutMs: 20 });
  await assert.rejects(slow.params, /timed out/);
});

test('googleSignIn: browser, loopback code, token exchange with the verifier, then /auth/google', async () => {
  const config = signInConfig({ BELAY_GOOGLE_CLIENT_ID: 'cid', BELAY_GOOGLE_CLIENT_SECRET: 'csec' });
  let verifier = '';
  const f = fakeFetch({
    'POST https://oauth2.googleapis.com/token': (init) => {
      const p = new URLSearchParams(String(init.body));
      verifier = p.get('code_verifier');
      assert.equal(p.get('code'), 'the-code');
      assert.equal(p.get('client_secret'), 'csec');
      assert.equal(p.get('grant_type'), 'authorization_code');
      return [200, { id_token: 'google.id.token' }];
    },
    [`POST ${BASE}/auth/google`]: [200, { session: SESSION }],
  });
  const openUrl = async (raw) => {
    const u = new URL(raw);
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('state', u.searchParams.get('state'));
    back.searchParams.set('code', 'the-code');
    await fetch(back);
  };
  assert.equal(await googleSignIn({ config, base: BASE, openUrl, fetchImpl: f.impl }), SESSION);
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { idToken: 'google.id.token' });
});

test('appleSignIn: server nonce, relay page hands the id_token to the loopback, then /auth/apple', async () => {
  const config = signInConfig({ BELAY_APPLE_SERVICES_ID: 'sid' });
  const nonce = 'N'.repeat(43);
  const f = fakeFetch({
    [`POST ${BASE}/auth/nonce`]: [200, { nonce, expiresAt: new Date().toISOString() }],
    [`POST ${BASE}/auth/apple`]: [200, { session: SESSION }],
  });
  const openUrl = async (raw) => {
    const u = new URL(raw);
    const [port] = u.searchParams.get('state').split('.');
    // what https://gobelay.com/auth/desktop-callback does with the fragment
    await fetch(`http://127.0.0.1:${port}/apple?state=${encodeURIComponent(u.searchParams.get('state'))}&id_token=apple.id.token`);
  };
  assert.equal(await appleSignIn({ config, base: BASE, openUrl, fetchImpl: f.impl }), SESSION);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { identityToken: 'apple.id.token', nonce });
});
