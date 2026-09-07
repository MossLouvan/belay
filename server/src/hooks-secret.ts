// The shared secret between the host and the hook script that Claude Code
// runs on its behalf. Both live on the same machine as the same user, so a
// file readable only by that user is the whole trust model: the host mints
// it once, the hook reads it on every run, and a process that cannot read
// ~/.belay/hook-secret cannot talk to /hooks/*.
//
// Deliberately not the pairing token. That token lets a phone drive the
// desktop; this one only lets a local process say "Claude is asking".
// Leaking it buys an attacker the ability to put fake asks on the phone —
// annoying, not a takeover — and it is rotated by deleting the file.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRET_BYTES = 32;
const SECRET_HEX = /^[0-9a-f]{64}$/;

/** The header the hook sends the secret in. */
export const HOOK_SECRET_HEADER = 'x-belay-hook-secret';

export function hookSecretPath(home: string = homedir()): string {
  return join(home, '.belay', 'hook-secret');
}

/** A well-formed secret from the file, or null when the file is missing or garbage. */
export function readHookSecret(home: string = homedir()): string | null {
  try {
    const raw = readFileSync(hookSecretPath(home), 'utf8').trim();
    return SECRET_HEX.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read the secret, minting one (0600, in a 0700 dir) when there is none or
 * the file is unusable. Called once at host boot; the hook only ever reads.
 */
export function ensureHookSecret(home: string = homedir()): string {
  const existing = readHookSecret(home);
  if (existing) return existing;
  const path = hookSecretPath(home);
  const dir = join(home, '.belay');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already existed (e.g. a
  // truncated one); make the permission unconditional.
  chmodSync(path, 0o600);
  return secret;
}

/** Constant-time comparison; a wrong length is simply false. */
export function secretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
