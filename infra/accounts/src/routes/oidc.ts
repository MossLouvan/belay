// POST /auth/apple, POST /auth/google

import { accountJson, createSession, findOrCreateAccount } from '../auth.js';
import { sha256Hex } from '../crypto.js';
import { splitList, type Env } from '../env.js';
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

export async function appleAuth(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const identityToken = requireString(body, 'identityToken', MAX_TOKEN_LEN);
  const nonce = requireString(body, 'nonce', 256);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);

  const claims = await verifyIdToken(identityToken, { ...APPLE, audiences: [env.APPLE_AUDIENCE] });
  if (claims.nonce !== (await sha256Hex(nonce))) throw new HttpError(401, 'invalid_token', 'nonce mismatch');
  return signIn(env, 'apple', claims);
}

export async function googleAuth(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const idToken = requireString(body, 'idToken', MAX_TOKEN_LEN);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);

  const audiences = splitList(env.GOOGLE_AUDIENCES);
  if (audiences.length === 0) throw new HttpError(500, 'misconfigured', 'GOOGLE_AUDIENCES is not set');
  const claims = await verifyIdToken(idToken, { ...GOOGLE, audiences });
  return signIn(env, 'google', claims);
}
