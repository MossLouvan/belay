// Authentication for the person standing at the computer.
//
// `npm run attach` opens a live terminal into a Claude session — that is full
// control of the machine's keyboard, so it needs real auth, and inventing a
// third unauthenticated loopback route was never an option. The two existing
// patterns were the candidates:
//
//   - the pairing token in belay-state.json, which a local process could read
//     — but that token is the phone's, it works from anywhere on the tailnet,
//     and handing a desk-side CLI a credential with that reach to hold in its
//     argv and environment is a larger key than the door needs;
//   - the sidecar pattern in approval-mcp.cjs: a secret that only proves "I am
//     a process running as this user on this machine", checked on a route that
//     accepts loopback only.
//
// This is the second one, with its own file rather than a shared one, because
// the capability is different in kind from the hook secret: leaking the hook
// secret buys an attacker fake approval prompts on a phone, leaking this one
// buys them a shell. Different blast radius, different key, rotated by
// deleting the file.
//
// The secret itself never travels in a URL. The CLI presents it in a header on
// a loopback POST and gets back an ordinary single-use WebSocket ticket — the
// same 30-second ticket the phone uses — which is what the upgrade carries.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRET_BYTES = 32;
const SECRET_HEX = /^[0-9a-f]{64}$/;

/** The header the attach CLI presents the secret in. */
export const ATTACH_SECRET_HEADER = 'x-belay-attach-secret';

export function attachSecretPath(home: string = homedir()): string {
  return join(home, '.belay', 'attach-secret');
}

/** A well-formed secret from the file, or null when missing or garbage. */
export function readAttachSecret(home: string = homedir()): string | null {
  try {
    const raw = readFileSync(attachSecretPath(home), 'utf8').trim();
    return SECRET_HEX.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read the secret, minting one (0600, in a 0700 dir) when there is none or the
 * file is unusable. Called once at host boot; the CLI only ever reads.
 */
export function ensureAttachSecret(home: string = homedir()): string {
  const existing = readAttachSecret(home);
  if (existing) return existing;
  const path = attachSecretPath(home);
  const dir = join(home, '.belay');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already existed (a truncated
  // one, say); make the permission unconditional.
  chmodSync(path, 0o600);
  return secret;
}

/** Constant-time comparison; a wrong length is simply false. */
export function attachSecretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** Loopback, in every shape Node reports it. */
export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The token a local-console ticket is issued for.
 *
 * Random per host process and never written anywhere — it is an internal
 * handle, not a credential anybody can present. The only way to obtain a
 * ticket bound to it is the loopback route guarded by the file secret above,
 * and the only route that accepts it is /ws/agent-attach.
 */
export const LOCAL_CONSOLE_TOKEN = randomBytes(32).toString('hex');

/** The name shown wherever a connected client is named. */
export const LOCAL_CONSOLE_NAME = 'this computer';

export interface LocalConsoleDevice {
  readonly token: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

/**
 * The pseudo-device a redeemed local-console ticket authenticates as, or
 * undefined for anything else.
 *
 * Deliberately gated on the path as well as the token: a local console is
 * allowed to attach to an agent session and nothing else. It is not a paired
 * phone and must not be able to reach the screen, the shell, or the cursor
 * channel by presenting the same handle at a different route.
 */
export function localConsoleDevice(token: string, pathname: string): LocalConsoleDevice | undefined {
  if (pathname !== '/ws/agent-attach') return undefined;
  if (!token || token.length !== LOCAL_CONSOLE_TOKEN.length) return undefined;
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(LOCAL_CONSOLE_TOKEN))) return undefined;
  const at = Date.now();
  return { token: LOCAL_CONSOLE_TOKEN, name: LOCAL_CONSOLE_NAME, createdAt: at, lastSeen: at };
}
