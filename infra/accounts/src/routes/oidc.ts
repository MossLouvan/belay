// POST /auth/nonce, POST /auth/apple, POST /auth/google

import { accountJson, createSession, findOrCreateAccount } from '../auth.js';
import { randomCredential, sha256Hex } from '../crypto.js';
import { NONCE_TTL_MS, splitList, type Env } from '../env.js';
import { HttpError, clientIp, json, readJson, requireString } from '../http.js';
import { verifyIdToken, type IdTokenClaims } from '../jwt.js';
import { LIMITS, enforceLimit } from '../rate-limit.js';

export const APPLE = { jwksUrl: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] } as const;
export const GOOGLE = {
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

const MAX_TOKEN_LEN = 8192;

const verifiedEmail = (claims: IdTokenClaims): string | null => {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return verified && typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
};

async function signIn(env: Env, provider: 'apple' | 'google', claims: IdTokenClaims): Promise<Response> {
  const account = await findOrCreateAccount(env.DB, provider, claims.sub, verifiedEmail(claims));
  const session = await createSession(env.DB, account.id);
  return json({ session, account: accountJson(account) });
}

/** Server-issued nonce for Sign in with Apple; the app sends sha256(nonce) to Apple and the raw nonce to us. */
export async function issueNonce(req: Request, env: Env): Promise<Response> {
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  const nonce = randomCredential();
  const expiresAt = Date.now() + NONCE_TTL_MS;
  await env.DB.prepare('INSERT INTO nonces (hash, expires_at) VALUES (?1, ?2)').bind(await sha256Hex(nonce), expiresAt).run();
  return json({ nonce, expiresAt: new Date(expiresAt).toISOString() });
}

async function consumeNonce(env: Env, nonce: string): Promise<void> {
  const row = await env.DB.prepare('DELETE FROM nonces WHERE hash = ?1 AND expires_at > ?2 RETURNING hash')
    .bind(await sha256Hex(nonce), Date.now())
    .first();
  if (!row) throw new HttpError(401, 'invalid_nonce', 'nonce unknown, expired or already used');
}

export async function appleAuth(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const identityToken = requireString(body, 'identityToken', MAX_TOKEN_LEN);
  const nonce = requireString(body, 'nonce', 256);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);

  const claims = await verifyIdToken(identityToken, { ...APPLE, audiences: [env.APPLE_AUDIENCE] });
  if (claims.nonce !== (await sha256Hex(nonce))) throw new HttpError(401, 'invalid_token', 'nonce mismatch');
  await consumeNonce(env, nonce);
  return signIn(env, 'apple', claims);
}

/** Google has no nonce in the native flow; remember accepted tokens until they expire. */
async function rejectReplay(env: Env, idToken: string, claims: IdTokenClaims): Promise<void> {
  const { meta } = await env.DB.prepare('INSERT OR IGNORE INTO used_tokens (hash, expires_at) VALUES (?1, ?2)')
    .bind(await sha256Hex(idToken), claims.exp * 1000)
    .run();
  if (meta.changes === 0) throw new HttpError(401, 'invalid_token', 'token already used');
}

export async function googleAuth(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const idToken = requireString(body, 'idToken', MAX_TOKEN_LEN);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);

  const audiences = splitList(env.GOOGLE_AUDIENCES);
  if (audiences.length === 0) throw new HttpError(500, 'misconfigured', 'GOOGLE_AUDIENCES is not set');
  const claims = await verifyIdToken(idToken, { ...GOOGLE, audiences });
  await rejectReplay(env, idToken, claims);
  return signIn(env, 'google', claims);
}
