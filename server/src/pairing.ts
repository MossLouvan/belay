// Pairing: the PC shows a 6-digit code, the phone submits it once to trade the
// code for a long-lived device token. Codes are single-use and expire, so a
// glimpsed code is not a standing key to the machine.
//
// The code space (10^6) is small on purpose — it has to be readable off a
// screen and typed on a phone. What makes that safe is the *cost of a wrong
// guess*, which lives in `pair-guard.ts`, not here. This module is only
// responsible for minting, expiring and burning codes.

import { randomInt, timingSafeEqual } from 'node:crypto';

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_PATTERN = /^\d{6}$/;

let current: { code: string; expires: number } | null = null;

/**
 * The fixed code used by the automated end-to-end suite, if one is configured
 * and permitted.
 *
 * This bypasses expiry *and* single-use, so it is a complete defeat of pairing
 * security. It is therefore refused outright in production rather than merely
 * discouraged by a comment — an env var inherited from a CI shell or a stray
 * `.env` must not be able to silently disable pairing on a real machine.
 */
export function testCode(): string | null {
  const forced = process.env.TETHER_TEST_CODE;
  if (!forced || !CODE_PATTERN.test(forced)) return null;
  if (process.env.NODE_ENV === 'production') return null;
  return forced;
}

/** True when the insecure fixed test code is active, so boot can warn loudly. */
export function testCodeActive(): boolean {
  return testCode() !== null;
}

export function generateCode(): string {
  const forced = testCode();
  const code = forced ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  current = { code, expires: Date.now() + CODE_TTL_MS };
  return code;
}

export function currentCode(): { code: string; expiresInSec: number } | null {
  if (!current) return null;
  const left = current.expires - Date.now();
  if (left <= 0) { current = null; return null; }
  return { code: current.code, expiresInSec: Math.round(left / 1000) };
}

/**
 * Invalidate the live code without pairing anything.
 *
 * Called when the brute-force guard decides too many wrong guesses have been
 * spent against this code. Burning it means a distributed attacker cannot keep
 * grinding one code by spreading attempts across many source addresses.
 */
export function burnCode(): void {
  current = null;
}

export function consumeCode(code: string): boolean {
  const forced = testCode();
  if (forced) {
    // Test mode: the fixed code stays valid and reusable so an automated suite
    // can pair repeatedly. Refused in production by `testCode()`.
    return equalsConstantTime(code, forced);
  }
  if (!current) return false;
  if (Date.now() > current.expires) { current = null; return false; }
  if (!equalsConstantTime(code, current.code)) return false;
  // Single use: burn it so the same code can't pair a second device.
  current = null;
  return true;
}

// Keep a fresh code available at all times while unpaired so the PC display is
// never showing an expired one.
export function ensureCode(): void {
  if (!currentCode()) generateCode();
}

/**
 * Compare two codes without an early exit.
 *
 * The rate limiter already makes timing analysis a poor attack against a
 * 6-digit code, so this is defence in depth rather than the primary control —
 * but a plain `!==` on a secret is the kind of thing that gets copied into
 * somewhere it matters more.
 */
function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, and length is not secret here
  // (every code is exactly six digits), so checking it first is safe.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
