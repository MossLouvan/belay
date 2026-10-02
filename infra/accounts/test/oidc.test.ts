// /auth/apple and /auth/google end to end, with a stubbed JWKS endpoint.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { base64url, sha256Hex } from '../src/crypto.js';
import { clearJwksCache } from '../src/jwt.js';
import { APPLE, GOOGLE } from '../src/routes/oidc.js';
import { app } from './helpers.js';

const enc = new TextEncoder();
const b64 = (obj: unknown) => base64url(enc.encode(JSON.stringify(obj)));

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };

async function sign(payload: Record<string, unknown>): Promise<string> {
  const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, enc.encode(head));
  return `${head}.${base64url(new Uint8Array(sig))}`;
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearJwksCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url === APPLE.jwksUrl || url === GOOGLE.jwksUrl, `unexpected fetch ${url}`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
});
afterEach(() => (globalThis.fetch = originalFetch));

const exp = Math.floor(Date.now() / 1000) + 600;

test('apple: verifies token + nonce, creates an account, then signs the same account in again', async () => {
  const a = app();
  const nonce = (await a.call('POST', '/v1/auth/nonce')).body.nonce as string;
  const identityToken = await sign({ iss: APPLE.issuers[0], aud: 'com.mosslouvan.belay', sub: 'apple-1', exp, nonce: await sha256Hex(nonce), email: 'a@privaterelay.appleid.com', email_verified: 'true' });

  const first = await a.call('POST', '/v1/auth/apple', { body: { identityToken, nonce } });
  assert.equal(first.status, 200);
  assert.equal(first.body.account.email, 'a@privaterelay.appleid.com');

  // M1: the nonce is single-use, so the same token+nonce cannot be replayed
  const replay = await a.call('POST', '/v1/auth/apple', { body: { identityToken, nonce } });
  assert.deepEqual(replay, { status: 401, body: { error: 'nonce unknown, expired or already used', code: 'invalid_nonce' } });

  const nonce2 = (await a.call('POST', '/v1/auth/nonce')).body.nonce as string;
  const token2 = await sign({ iss: APPLE.issuers[0], aud: 'com.mosslouvan.belay', sub: 'apple-1', exp, nonce: await sha256Hex(nonce2) });
  const again = await a.call('POST', '/v1/auth/apple', { body: { identityToken: token2, nonce: nonce2 } });
  assert.equal(again.body.account.id, first.body.account.id);
  assert.notEqual(again.body.session, first.body.session);

  const wrongNonce = await a.call('POST', '/v1/auth/apple', { body: { identityToken: token2, nonce: 'other' } });
  assert.deepEqual(wrongNonce, { status: 401, body: { error: 'nonce mismatch', code: 'invalid_token' } });

  // M1: a client-chosen nonce the server never issued is refused even when the token matches it
  const nonce3 = 'client-chosen';
  const token3 = await sign({ iss: APPLE.issuers[0], aud: 'com.mosslouvan.belay', sub: 'apple-1', exp, nonce: await sha256Hex(nonce3) });
  assert.equal((await a.call('POST', '/v1/auth/apple', { body: { identityToken: token3, nonce: nonce3 } })).body.code, 'invalid_nonce');

  // expired nonce
  const nonce4 = (await a.call('POST', '/v1/auth/nonce')).body.nonce as string;
  await a.env.DB.prepare('UPDATE nonces SET expires_at = ?1').bind(Date.now() - 1).run();
  const token4 = await sign({ iss: APPLE.issuers[0], aud: 'com.mosslouvan.belay', sub: 'apple-1', exp, nonce: await sha256Hex(nonce4) });
  assert.equal((await a.call('POST', '/v1/auth/apple', { body: { identityToken: token4, nonce: nonce4 } })).body.code, 'invalid_nonce');
});

test('google: accepts any configured client id and links by verified email', async () => {
  const a = app();
  const email = 'shared@example.com';
  const n = (await a.call('POST', '/v1/auth/nonce')).body.nonce as string;
  const apple = await sign({ iss: APPLE.issuers[0], aud: 'com.mosslouvan.belay', sub: 'apple-2', exp, nonce: await sha256Hex(n), email, email_verified: true });
  const viaApple = await a.call('POST', '/v1/auth/apple', { body: { identityToken: apple, nonce: n } });

  const google = await sign({ iss: GOOGLE.issuers[0], aud: 'ios.apps.googleusercontent.com', sub: 'google-2', exp, email, email_verified: true });
  const viaGoogle = await a.call('POST', '/v1/auth/google', { body: { idToken: google } });
  assert.equal(viaGoogle.status, 200);
  assert.equal(viaGoogle.body.account.id, viaApple.body.account.id);

  // M1: a Google token is accepted once
  const replay = await a.call('POST', '/v1/auth/google', { body: { idToken: google } });
  assert.deepEqual(replay, { status: 401, body: { error: 'token already used', code: 'invalid_token' } });
  const hash = await a.env.DB.prepare('SELECT hash, expires_at FROM used_tokens').first<{ hash: string; expires_at: number }>();
  assert.equal(hash?.hash, await sha256Hex(google));
  assert.equal(hash?.expires_at, exp * 1000);

  const badAud = await sign({ iss: GOOGLE.issuers[0], aud: 'someone-else.apps.googleusercontent.com', sub: 'google-3', exp });
  assert.equal((await a.call('POST', '/v1/auth/google', { body: { idToken: badAud } })).status, 401);
});

test('unverified email never links accounts', async () => {
  const a = app();
  const email = 'victim@example.com';
  await a.call('POST', '/v1/auth/google', { body: { idToken: await sign({ iss: GOOGLE.issuers[0], aud: 'web.apps.googleusercontent.com', sub: 'g-victim', exp, email, email_verified: true }) } });
  const attacker = await a.call('POST', '/v1/auth/google', { body: { idToken: await sign({ iss: GOOGLE.issuers[0], aud: 'web.apps.googleusercontent.com', sub: 'g-attacker', exp, email, email_verified: false }) } });
  assert.equal(attacker.status, 200);
  assert.equal(attacker.body.account.email, null);
  const count = await a.env.DB.prepare('SELECT count(*) AS n FROM accounts').first<number>('n');
  assert.equal(count, 2);
});

test('missing fields are 400', async () => {
  const a = app();
  assert.equal((await a.call('POST', '/v1/auth/apple', { body: { identityToken: 'x' } })).body.code, 'bad_request');
  assert.equal((await a.call('POST', '/v1/auth/google', { body: {} })).body.code, 'bad_request');
});
