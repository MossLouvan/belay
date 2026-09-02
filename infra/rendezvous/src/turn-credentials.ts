// Short-lived TURN credentials, minted per session, verified by coturn offline.
//
// This is the TURN REST API scheme (draft-uberti-behave-turn-rest-00), which
// coturn implements natively via `use-auth-secret` + `static-auth-secret`:
//
//   username   = "<unix-expiry>:<userid>"
//   credential = base64( HMAC-SHA1( key = shared-secret, input = username ) )
//
// coturn recomputes the HMAC from the username and its own copy of the secret,
// so minting requires NO round trip to the TURN server and NO user database —
// the credential IS the proof. That is what keeps the rendezvous stateless and
// horizontally scalable: any instance holding the secret can mint, and any
// coturn PoP holding the same secret can verify.
//
// Scoping and caps:
// - TTL: short (default 5 min). A leaked credential is dead by the time it is
//   read out of a log. coturn honours the embedded expiry exactly.
// - Per-account + per-session userid: usage in coturn's logs and quotas is
//   attributable to one Belay account and one streaming session. Revocation is
//   "stop minting" — nothing long-lived exists to revoke.
// - Bandwidth: enforced coturn-side (`max-bps`, quotas). TURN_RELAY_POLICY
//   below is the single source of truth the deploy config must match; a unit
//   test asserts infra/turn/turnserver.conf agrees with it.
// - Peer restriction: a TURN allocation only relays to peers the *client*
//   explicitly grants via CreatePermission (RFC 5766 §9) — the relay cannot be
//   used as an open proxy — and the credential's session scoping means one
//   minted credential maps to one brokered session.
//
// SHA-1 here is an HMAC, not a bare digest: HMAC-SHA1 remains unbroken for
// authentication and is what coturn's REST mode expects. `sha256` is available
// for deployments that enable coturn's SHA-256 support.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Relay policy constants — mirrored into infra/turn/turnserver.conf.
 *  A test asserts the conf agrees, so the two cannot drift silently. */
export const TURN_RELAY_POLICY = Object.freeze({
  /** Per-session relay cap, bytes/second each direction. 1.5 MB/s ≈ 12 Mbit/s:
   *  headroom for 1080p60 H.264 plus audio + retransmits. */
  maxBpsPerSession: 1_500_000,
  /** Max simultaneous allocations per username (one username = one session). */
  userQuota: 4,
  /** Max simultaneous allocations across the whole PoP. */
  totalQuota: 1200,
});

export const CREDENTIAL_LIMITS = Object.freeze({
  /** Account/session ids: same token alphabet the signaling layer enforces.
   *  128 chars so a mailboxId can serve directly as the accountId. */
  idPattern: /^[A-Za-z0-9._-]{1,128}$/,
  minTtlSec: 30,
  maxTtlSec: 3600,
  defaultTtlSec: 300,
  minSecretBytes: 32,
});

export type TurnHmacAlgorithm = 'sha1' | 'sha256';

export interface MintRequest {
  readonly accountId: string;
  readonly sessionId: string;
  readonly ttlSec?: number;
  readonly algorithm?: TurnHmacAlgorithm;
}

export interface TurnCredential {
  readonly username: string;
  readonly credential: string;
  readonly ttlSec: number;
  readonly expiresAtMs: number;
  readonly algorithm: TurnHmacAlgorithm;
}

export type MintResult =
  | { readonly ok: true; readonly value: TurnCredential }
  | { readonly ok: false; readonly error: string };

/**
 * Mint one short-lived TURN credential. Pure given (request, secret, now):
 * no I/O, no state — the properties the unit tests pin down.
 */
export function mintTurnCredential(
  request: MintRequest,
  secret: string,
  now: () => number = Date.now,
): MintResult {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < CREDENTIAL_LIMITS.minSecretBytes) {
    return { ok: false, error: `secret must be at least ${CREDENTIAL_LIMITS.minSecretBytes} bytes` };
  }
  if (!CREDENTIAL_LIMITS.idPattern.test(request.accountId ?? '')) {
    return { ok: false, error: 'invalid accountId' };
  }
  if (!CREDENTIAL_LIMITS.idPattern.test(request.sessionId ?? '')) {
    return { ok: false, error: 'invalid sessionId' };
  }
  const algorithm = request.algorithm ?? 'sha1';
  if (algorithm !== 'sha1' && algorithm !== 'sha256') {
    return { ok: false, error: 'unsupported algorithm' };
  }

  const requestedTtl = request.ttlSec ?? CREDENTIAL_LIMITS.defaultTtlSec;
  if (!Number.isFinite(requestedTtl)) return { ok: false, error: 'invalid ttlSec' };
  const ttlSec = clamp(Math.floor(requestedTtl), CREDENTIAL_LIMITS.minTtlSec, CREDENTIAL_LIMITS.maxTtlSec);

  const nowMs = now();
  const expirySec = Math.floor(nowMs / 1000) + ttlSec;
  // The id charset excludes ':', so the separator is unambiguous by
  // construction — a hostile accountId cannot smuggle an earlier expiry field.
  const username = `${expirySec}:${request.accountId}.${request.sessionId}`;
  const credential = hmacBase64(algorithm, secret, username);

  return {
    ok: true,
    value: { username, credential, ttlSec, expiresAtMs: expirySec * 1000, algorithm },
  };
}

/**
 * Verify a credential the way coturn does: recompute the HMAC over the
 * username and compare, then honour the embedded expiry. Used by tests as the
 * independent check, and available to any future first-party verifier.
 */
export function verifyTurnCredential(
  username: string,
  credential: string,
  secret: string,
  now: () => number = Date.now,
  algorithm: TurnHmacAlgorithm = 'sha1',
): { readonly ok: boolean; readonly error?: string } {
  if (typeof username !== 'string' || typeof credential !== 'string') {
    return { ok: false, error: 'malformed input' };
  }
  const sep = username.indexOf(':');
  if (sep <= 0) return { ok: false, error: 'username missing expiry' };
  const expirySec = Number(username.slice(0, sep));
  if (!Number.isInteger(expirySec) || expirySec <= 0) return { ok: false, error: 'invalid expiry' };

  const expected = Buffer.from(hmacBase64(algorithm, secret, username), 'utf8');
  const supplied = Buffer.from(credential, 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, error: 'bad credential' };
  }
  if (expirySec * 1000 <= now()) return { ok: false, error: 'expired' };
  return { ok: true };
}

function hmacBase64(algorithm: TurnHmacAlgorithm, secret: string, input: string): string {
  return createHmac(algorithm, secret).update(input, 'utf8').digest('base64');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
