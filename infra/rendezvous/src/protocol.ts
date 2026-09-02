// The rendezvous wire protocol: the outer frame around signaling.
//
// One WebSocket per participant, JSON text frames, `v: 1` on everything. The
// protocol is small on purpose — five client verbs — and every frame is
// validated here before any handler sees it, so server.ts stays a thin binding
// with no parsing of its own (the same split relay.ts/bridge.ts uses host-side).
//
//   host   → announce (lease renew), attach(side=host), signal, turn
//   client → lookup (is my host reachable?), attach(side=client), signal, turn
//
// The signaling payload inside `signal` is validated by signal.ts and relayed
// opaquely; its end-to-end seal is never inspected here.

import { validateSignal, type ValidSignal } from './signal.js';
import { validateAnnounce, type LeaseAnnounce } from './lease.js';
import { MAILBOX_LIMITS, type MailboxSide } from './mailbox.js';

/** Hard cap on a raw incoming frame: bigger than the largest legal signal
 *  (64KB SDP + envelope), small enough to bound per-frame work. */
export const MAX_FRAME_BYTES = 80 * 1024;

export type ClientFrame =
  | { readonly type: 'announce'; readonly announce: LeaseAnnounce; readonly ttlSec: number }
  | { readonly type: 'lookup'; readonly mailboxId: string }
  | { readonly type: 'attach'; readonly mailboxId: string; readonly side: MailboxSide }
  | { readonly type: 'signal'; readonly message: ValidSignal }
  | { readonly type: 'turn'; readonly sessionId: string };

export type ParseResult =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly error: string };

/** Parse + validate one raw text frame. Never throws. */
export function parseClientFrame(raw: unknown): ParseResult {
  if (typeof raw !== 'string') return fail('frame is not text');
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return fail('frame too large');

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail('frame is not JSON');
  }
  if (!decoded || typeof decoded !== 'object') return fail('frame is not an object');
  const msg = decoded as Record<string, unknown>;
  if (msg.v !== 1) return fail('unsupported protocol version');

  switch (msg.type) {
    case 'announce': {
      const validated = validateAnnounce(msg);
      if (!validated.ok) return fail(validated.error);
      return ok({ type: 'announce', announce: validated.announce, ttlSec: validated.ttlSec });
    }
    case 'lookup': {
      if (typeof msg.mailboxId !== 'string' || !MAILBOX_LIMITS.idPattern.test(msg.mailboxId)) {
        return fail('invalid mailboxId');
      }
      return ok({ type: 'lookup', mailboxId: msg.mailboxId });
    }
    case 'attach': {
      if (typeof msg.mailboxId !== 'string' || !MAILBOX_LIMITS.idPattern.test(msg.mailboxId)) {
        return fail('invalid mailboxId');
      }
      if (msg.side !== 'host' && msg.side !== 'client') return fail('invalid side');
      return ok({ type: 'attach', mailboxId: msg.mailboxId, side: msg.side });
    }
    case 'signal': {
      const validated = validateSignal(msg.message);
      if (!validated.ok) return fail(validated.error);
      return ok({ type: 'signal', message: validated.message });
    }
    case 'turn': {
      if (typeof msg.sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(msg.sessionId)) {
        return fail('invalid sessionId');
      }
      return ok({ type: 'turn', sessionId: msg.sessionId });
    }
    default:
      return fail(`unknown frame type: ${String(msg.type)}`);
  }
}

// ---- server → client frames (constructors, so shapes live in one place) ----

export function errorFrame(error: string): string {
  return JSON.stringify({ v: 1, type: 'error', error });
}

export function attachedFrame(side: MailboxSide): string {
  return JSON.stringify({ v: 1, type: 'attached', side });
}

export function leaseOkFrame(expiresInSec: number): string {
  return JSON.stringify({ v: 1, type: 'lease-ok', expiresInSec });
}

export function presenceFrame(live: boolean): string {
  return JSON.stringify({ v: 1, type: 'presence', live });
}

export function signalFrame(message: ValidSignal): string {
  return JSON.stringify({ v: 1, type: 'signal', message });
}

export function turnCredentialFrame(
  username: string,
  credential: string,
  ttlSec: number,
  urls: readonly string[],
): string {
  return JSON.stringify({ v: 1, type: 'turn-cred', username, credential, ttlSec, urls });
}

function ok(frame: ClientFrame): ParseResult {
  return { ok: true, frame };
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}
