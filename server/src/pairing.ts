// Pairing: the PC shows a 6-digit code, the phone submits it once to trade the
// code for a long-lived device token. Codes are single-use and expire, so a
// glimpsed code is not a standing key to the machine.

import { randomInt } from 'node:crypto';

const CODE_TTL_MS = 5 * 60 * 1000;

let current: { code: string; expires: number } | null = null;

export function generateCode(): string {
  // A fixed code for automated end-to-end tests only; never set in normal use.
  const forced = process.env.TETHER_TEST_CODE;
  const code = forced && /^\d{6}$/.test(forced)
    ? forced
    : String(randomInt(0, 1_000_000)).padStart(6, '0');
  current = { code, expires: Date.now() + CODE_TTL_MS };
  return code;
}

export function currentCode(): { code: string; expiresInSec: number } | null {
  if (!current) return null;
  const left = current.expires - Date.now();
  if (left <= 0) { current = null; return null; }
  return { code: current.code, expiresInSec: Math.round(left / 1000) };
}

export function consumeCode(code: string): boolean {
  // Test mode: a fixed code stays valid and reusable so an automated suite can
  // pair repeatedly. Never active in normal use (the env var is unset).
  const forced = process.env.TETHER_TEST_CODE;
  if (forced && /^\d{6}$/.test(forced)) {
    return code === forced;
  }
  if (!current) return false;
  if (Date.now() > current.expires) { current = null; return false; }
  if (code !== current.code) return false;
  // Single use: burn it so the same code can't pair a second device.
  current = null;
  return true;
}

// Keep a fresh code available at all times while unpaired so the PC display is
// never showing an expired one.
export function ensureCode(): void {
  if (!currentCode()) generateCode();
}
