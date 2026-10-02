// Token verifier against locally generated RS256 and ES256 keys.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { base64url } from '../src/crypto.js';
import { HttpError } from '../src/http.js';
import { clearJwksCache, verifyIdToken } from '../src/jwt.js';

const enc = new TextEncoder();
const b64 = (obj: unknown) => base64url(enc.encode(JSON.stringify(obj)));

interface Signer {
  readonly alg: 'RS256' | 'ES256';
  readonly kid: string;
  readonly jwk: JsonWebKey & { kid: string };
  sign(payload: Record<string, unknown>, headerOverride?: Record<string, unknown>): Promise<string>;
}

async function makeSigner(alg: 'RS256' | 'ES256', kid: string): Promise<Signer> {
  const pair =
    alg === 'RS256'
      ? await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
      : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  const params = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  return {
    alg,
    kid,
    jwk,
    async sign(payload, headerOverride = {}) {
      const head = `${b64({ alg, kid, ...headerOverride })}.${b64(payload)}`;
      const sig = await crypto.subtle.sign(params, pair.privateKey, enc.encode(head));
      return `${head}.${base64url(new Uint8Array(sig))}`;
    },
  };
}

const NOW = 1_800_000_000_000;
const jwksFetch = (keys: unknown[], calls = { n: 0 }): typeof fetch =>
  (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as typeof fetch;

const opts = (fetchImpl: typeof fetch) => ({
  jwksUrl: 'https://issuer.example/keys',
  issuers: ['https://issuer.example'],
  audiences: ['com.mosslouvan.belay'],
  fetch: fetchImpl,
  now: NOW,
});
const good = { iss: 'https://issuer.example', aud: 'com.mosslouvan.belay', sub: 'user-1', exp: NOW / 1000 + 600 };

beforeEach(clearJwksCache);

for (const alg of ['RS256', 'ES256'] as const) {
  test(`${alg}: accepts a valid token and rejects a tampered one`, async () => {
    const s = await makeSigner(alg, 'k1');
    const f = jwksFetch([s.jwk]);
    const claims = await verifyIdToken(await s.sign(good), opts(f));
    assert.equal(claims.sub, 'user-1');

    const [h, , sig] = (await s.sign(good)).split('.');
    const forged = `${h}.${b64({ ...good, sub: 'attacker' })}.${sig}`;
    await assert.rejects(verifyIdToken(forged, opts(f)), (e: HttpError) => e.code === 'invalid_token' && /signature/.test(e.message));
  });
}

test('rejects wrong issuer, wrong audience, expired, and unknown alg', async () => {
  const s = await makeSigner('ES256', 'k1');
  const o = opts(jwksFetch([s.jwk]));
  const expect = async (payload: Record<string, unknown>, re: RegExp, header?: Record<string, unknown>) =>
    assert.rejects(verifyIdToken(await s.sign(payload, header), o), (e: HttpError) => e.status === 401 && re.test(e.message));
  await expect({ ...good, iss: 'https://evil.example' }, /issuer/);
  await expect({ ...good, aud: 'other.app' }, /audience/);
  await expect({ ...good, exp: NOW / 1000 - 1 }, /expired/);
  await expect(good, /alg/, { alg: 'HS256' });
  await expect(good, /alg/, { alg: 'none' });
});

test('accepts an audience array containing ours', async () => {
  const s = await makeSigner('RS256', 'k1');
  const claims = await verifyIdToken(await s.sign({ ...good, aud: ['x', 'com.mosslouvan.belay'] }), opts(jwksFetch([s.jwk])));
  assert.equal(claims.sub, 'user-1');
});

test('caches JWKS and refetches once on an unknown kid', async () => {
  const k1 = await makeSigner('RS256', 'k1');
  const k2 = await makeSigner('RS256', 'k2');
  const calls = { n: 0 };
  let keys: unknown[] = [k1.jwk];
  const f = (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as typeof fetch;

  await verifyIdToken(await k1.sign(good), opts(f));
  await verifyIdToken(await k1.sign(good), opts(f));
  assert.equal(calls.n, 1);

  // rotation: k2 appears, but we fetched < 60 s ago so the refetch is suppressed
  keys = [k1.jwk, k2.jwk];
  await assert.rejects(verifyIdToken(await k2.sign(good), opts(f)), /unknown signing key/);
  assert.equal(calls.n, 1);

  // later, the unknown kid triggers exactly one refetch
  await verifyIdToken(await k2.sign(good), { ...opts(f), now: NOW + 120_000 });
  assert.equal(calls.n, 2);
});

test('a key whose type does not match the alg is a 401, not a crash', async () => {
  const rsa = await makeSigner('RS256', 'k1');
  const ec = await makeSigner('ES256', 'k1');
  await assert.rejects(verifyIdToken(await ec.sign(good), opts(jwksFetch([rsa.jwk]))), (e: HttpError) => e.status === 401);
});

test('malformed tokens are 401', async () => {
  const o = opts(jwksFetch([]));
  await assert.rejects(verifyIdToken('nope', o), (e: HttpError) => e.status === 401);
  await assert.rejects(verifyIdToken('a.b.c', o), (e: HttpError) => e.status === 401);
});
