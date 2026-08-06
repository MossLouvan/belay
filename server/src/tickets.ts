// Short-lived, single-use tickets for authenticating a WebSocket upgrade.
//
// Browsers cannot set headers on a WebSocket handshake, so the token was passed
// as a query parameter instead. That works, and it puts a credential granting
// complete control of the machine — screen, keystrokes, shell — into a place
// that is routinely written to disk: proxy access logs, reverse-proxy logs, and
// anything else that records a request line. A long-lived token in a URL is a
// long-lived token in a log file.
//
// It also breaks under at least one intended deployment: Tailscale Funnel has a
// known bug that strips query parameters from WebSocket upgrades, so the token
// would silently vanish and every stream would 401.
//
// A ticket fixes both. The phone asks for one over normal authenticated HTTP,
// where the token travels in an Authorization header, and spends it immediately
// on the upgrade. If a ticket does end up in a log it is worthless: it is
// single-use and expires in seconds.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How long a ticket stays valid.
 *
 * Only has to cover the gap between asking for one and opening the socket,
 * which is a single round trip. Generous enough for a slow link, short enough
 * that a leaked ticket is useless by the time anyone reads the log.
 */
export const TICKET_TTL_MS = 30_000;

/** Ceiling on live tickets, so a caller cannot mint them without bound. */
const MAX_LIVE_TICKETS = 256;

interface Ticket {
  readonly value: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface TicketStore {
  /** Mint a ticket bound to the device token that asked for it. */
  issue(token: string): { ticket: string; expiresInSec: number };
  /**
   * Spend a ticket, returning the device token it was issued for.
   * Returns null when unknown, expired, or already used.
   */
  redeem(ticket: string): string | null;
  /** Live ticket count. Exposed for tests. */
  size(): number;
}

export function createTicketStore(
  ttlMs: number = TICKET_TTL_MS,
  now: () => number = Date.now,
): TicketStore {
  const tickets = new Map<string, Ticket>();

  const prune = (at: number): void => {
    for (const [value, ticket] of tickets) {
      if (ticket.expiresAt <= at) tickets.delete(value);
    }
  };

  return {
    issue(token: string) {
      const at = now();
      prune(at);

      // Pruning normally keeps this well under the cap; if a client is minting
      // faster than they expire, drop the oldest rather than grow forever.
      while (tickets.size >= MAX_LIVE_TICKETS) {
        const oldest = tickets.keys().next();
        if (oldest.done) break;
        tickets.delete(oldest.value);
      }

      const value = randomBytes(32).toString('hex');
      tickets.set(value, { value, token, expiresAt: at + ttlMs });
      return { ticket: value, expiresInSec: Math.round(ttlMs / 1000) };
    },

    redeem(ticket: string): string | null {
      if (!ticket) return null;
      const at = now();
      prune(at);

      // Constant-time comparison against every live ticket rather than a direct
      // Map lookup: a lookup leaks, through timing, whether a guessed prefix
      // matched anything. There are at most a few hundred tickets, so the cost
      // is irrelevant.
      const candidate = Buffer.from(ticket, 'utf8');
      for (const stored of tickets.values()) {
        const known = Buffer.from(stored.value, 'utf8');
        if (known.length !== candidate.length) continue;
        if (!timingSafeEqual(known, candidate)) continue;
        // Single use: burn it so a replayed URL cannot open a second socket.
        tickets.delete(stored.value);
        return stored.token;
      }
      return null;
    },

    size(): number {
      prune(now());
      return tickets.size;
    },
  };
}
