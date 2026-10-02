// ID-token verification (Apple, Google) with WebCrypto against a JWKS.
// RS256 and ES256 only. Keys are cached per JWKS URL; an unknown `kid`
// triggers one refetch (key rotation).

import { fromBase64url } from './crypto.js';
import { HttpError } from './http.js';

export interface IdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly nonce?: string;
}

export interface VerifyOptions {
  readonly jwksUrl: string;
  readonly issuers: readonly string[];
  readonly audiences: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: number;
}

type Jwk = JsonWebKey & { readonly kid?: string };

interface CachedJwks {
  readonly keys: readonly Jwk[];
  readonly fetchedAt: number;
}

const JWKS_TTL_MS = 6 * 3_600_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const cache = new Map<string, CachedJwks>();

const invalid = (why: string): HttpError => new HttpError(401, 'invalid_token', `invalid identity token: ${why}`);

const ALGS = {
  RS256: { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } },
} as const;
const isSupportedAlg = (alg: unknown): alg is keyof typeof ALGS => typeof alg === 'string' && alg in ALGS;

async function loadJwks(url: string, fetchImpl: typeof fetch, now: number, force: boolean): Promise<readonly Jwk[]> {
  const cached = cache.get(url);
  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  const recentlyFetched = cached && now - cached.fetchedAt < JWKS_MIN_REFETCH_MS;
  if (cached && fresh && (!force || recentlyFetched)) return cached.keys;

  const res = await fetchImpl(url);
  if (!res.ok) throw new HttpError(502, 'jwks_unavailable', `could not fetch signing keys (${res.status})`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new HttpError(502, 'jwks_unavailable', 'malformed JWKS');
  const keys = body.keys as Jwk[];
  cache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Test hook. */
export const clearJwksCache = (): void => cache.clear();

function decodePart<T>(part: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(part))) as T;
  } catch {
    throw invalid(`malformed ${what}`);
  }
}

export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<IdTokenClaims> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('expected 3 segments');
  const [h, p, s] = parts;

  const header = decodePart<{ alg?: string; kid?: string }>(h, 'header');
  if (!isSupportedAlg(header.alg) || typeof header.kid !== 'string') throw invalid('unsupported alg or missing kid');
  const alg = ALGS[header.alg];

  const findKey = (keys: readonly Jwk[]) => keys.find((k) => k.kid === header.kid);
  const jwk = findKey(await loadJwks(opts.jwksUrl, fetchImpl, now, false)) ?? findKey(await loadJwks(opts.jwksUrl, fetchImpl, now, true));
  if (!jwk) throw invalid('unknown signing key');

  const key = await crypto.subtle.importKey('jwk', jwk, alg.importParams, false, ['verify']).catch(() => null);
  if (!key) throw invalid('signing key does not match alg');
  const ok = await crypto.subtle.verify(alg.verifyParams, key, fromBase64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw invalid('bad signature');

  const claims = decodePart<IdTokenClaims>(p, 'payload');
  if (!opts.issuers.includes(claims.iss)) throw invalid('wrong issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a) => opts.audiences.includes(a))) throw invalid('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw invalid('expired');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw invalid('missing subject');
  return claims;
}
