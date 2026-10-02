// Account trust: a phone on the same Belay account pairs without a code.
//
// Only a tunnel peer whose nodeId is on the account allow-list may ask. The
// tunnel listener tags its sockets `tunnel:<nodeId>` only for streams that
// quote the sidecar's per-launch secret (tunnel-listener.ts), the sidecar
// admits only allow-listed nodes, and this re-checks on every call. Then:
//
//   first phone   the host is account-linked, has zero paired devices, AND
//                 its first-phone window is open: trusted at once. The window
//                 is FIRST_PHONE_WINDOW_MS from link time (or from Belay.app's
//                 "Let a phone connect", or --reset-pairing), is persisted in
//                 host state, closes at the first pairing of any kind, and is
//                 never reopened by revoking phones.
//   later phones  a pending request the owner approves with ONE tap, on
//                 Belay.app or on a phone that is already paired. Five
//                 minutes, then it is gone. Both screens show the same short
//                 match code so the owner can tell which phone is asking.
//
// So an account compromise alone gets an attacker at most a pending request
// the owner sees and can deny, unless it lands inside a 15-minute window the
// owner opened at the computer. LAN, loopback and unknown nodes get 403; the
// 6-digit /pair stays for computers that are not account-linked.
//
// Pure module: no HTTP, clock injected, state per process. The caller mints
// the device token; `poll` hands an approval out exactly once, and only to
// the node that asked, holding the poll secret it was given.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { safeName } from './pair-notify.js';
import { TUNNEL_REMOTE_ADDRESS } from './tunnel-listener.js';
import { isLoopback } from './transport.js';

/** How long the first-phone window stays open once opened. */
export const FIRST_PHONE_WINDOW_MS = 15 * 60 * 1000;

export const ACCOUNT_PAIR_DEFAULTS = {
  /** How long a request waits for a tap. */
  ttlMs: 5 * 60 * 1000,
  windowMs: 10 * 60 * 1000,
  /** Distinct phones that may ask per account (this host has one) per window. */
  perAccountMax: 3,
  /** Requests per phone node per window. */
  perNodeMax: 2,
  /** At most one 403 audit line per this long; the rest are counted. */
  refusalAuditMs: 60 * 1000,
} as const;

type Options = { -readonly [K in keyof typeof ACCOUNT_PAIR_DEFAULTS]: number } & {
  readonly audit?: (line: string) => void;
};

/** Who is calling, and what the host currently trusts. */
export interface Admission {
  readonly remoteAddress: string | undefined;
  readonly allowList: readonly string[];
  readonly linked: boolean;
}

export interface AccountPairRequest extends Admission {
  readonly deviceCount: number;
  /** The persisted first-phone deadline (ms); 0 when closed. */
  readonly trustUntil: number;
  readonly name: unknown;
  /** What the account says about this phone, for the prompt. */
  readonly info?: { readonly platform: string; readonly createdAt: number };
}

export type AccountPairDecision =
  | { readonly kind: 'refused'; readonly status: 403 | 429; readonly error: string; readonly retryAfterSec: number }
  | { readonly kind: 'trusted'; readonly name: string }
  | {
    readonly kind: 'pending'; readonly id: string; readonly secret: string;
    readonly matchCode: string; readonly expiresAt: number;
  };

export type AccountPairPoll =
  | { readonly status: 'pending'; readonly expiresAt: number; readonly matchCode: string }
  | { readonly status: 'approved'; readonly name: string }
  | { readonly status: 'denied' }
  | { readonly status: 'unknown' };

/** What Belay.app and paired phones see: never the node id or the secret. */
export interface PendingPhone {
  readonly id: string;
  readonly name: string;
  readonly matchCode: string;
  readonly platform: string;
  /** When the phone joined the account (ms), or null when unknown. */
  readonly addedAt: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AccountPairing {
  request(req: AccountPairRequest): AccountPairDecision;
  poll(id: string, secret: string, who: Admission): AccountPairPoll;
  /** False for an unknown, expired or answered request, or one whose phone is no longer admitted. */
  decide(id: string, allow: boolean, ctx: Omit<Admission, 'remoteAddress'>): boolean;
  cancel(id: string, secret: string, remoteAddress: string | undefined): boolean;
  /** Requests still waiting for a tap, oldest first. */
  list(): readonly PendingPhone[];
  onChange(fn: () => void): () => void;
}

interface Entry {
  readonly node: string;
  readonly secretHash: Buffer;
  readonly name: string;
  readonly matchCode: string;
  readonly platform: string;
  readonly addedAt: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: 'pending' | 'approved' | 'denied';
}

const NODE = /^[0-9a-f]{64}$/;

/** The node id behind an allow-listed tunnel source, else null. */
export function admittedNode(remoteAddress: string | undefined, allowList: readonly string[]): string | null {
  if (!remoteAddress?.startsWith(TUNNEL_REMOTE_ADDRESS)) return null;
  const node = remoteAddress.slice(TUNNEL_REMOTE_ADDRESS.length);
  return NODE.test(node) && allowList.includes(node) ? node : null;
}

// No 0/O, 1/I/L: read off one screen, compared on another.
const MATCH_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Four characters derived from the request's secret. */
export function matchCodeFor(secret: string): string {
  const digest = createHash('sha256').update(`belay-match:${secret}`).digest();
  return Array.from(digest.subarray(0, 4), (b) => MATCH_ALPHABET[b % MATCH_ALPHABET.length]).join('');
}

const hashSecret = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

export function createAccountPairing(options: Partial<Options> = {}, now: () => number = Date.now): AccountPairing {
  const config = { ...ACCOUNT_PAIR_DEFAULTS, ...options };
  const audit = options.audit ?? (() => {});
  let entries = new Map<string, Entry>();
  let stamps: readonly { readonly node: string; readonly at: number }[] = [];
  let lastRefusalAudit = Number.NEGATIVE_INFINITY;
  let refusalsHidden = 0;
  const listeners = new Set<() => void>();
  const changed = () => { for (const fn of listeners) fn(); };

  const sweep = (at: number): void => {
    const live = [...entries].filter(([, e]) => e.expiresAt > at);
    if (live.length !== entries.size) {
      entries = new Map(live);
      changed();
    }
    stamps = stamps.filter((s) => at - s.at < config.windowMs);
  };

  const drop = (id: string): void => { entries = new Map([...entries].filter(([k]) => k !== id)); };

  const refuse403 = (at: number, from: string | undefined) => {
    if (at - lastRefusalAudit >= config.refusalAuditMs) {
      audit(`refused 403 from ${from ?? 'unknown'}${refusalsHidden > 0 ? ` (and ${refusalsHidden} more since the last line)` : ''}`);
      lastRefusalAudit = at;
      refusalsHidden = 0;
    } else {
      refusalsHidden += 1;
    }
    return { kind: 'refused', status: 403, error: 'only phones on this computer\'s Belay account may ask', retryAfterSec: 0 } as const;
  };

  const short = (node: string) => node.slice(0, 12);
  const wait = (oldest: number, at: number) => Math.max(1, Math.ceil((oldest + config.windowMs - at) / 1000));

  /** The entry for `id` only if `secret` and the asking node match it. */
  const owned = (id: string, secret: string, remoteAddress: string | undefined): Entry | null => {
    const e = entries.get(id);
    if (!e || typeof secret !== 'string' || secret.length === 0) return null;
    if (remoteAddress !== `${TUNNEL_REMOTE_ADDRESS}${e.node}`) return null;
    return timingSafeEqual(hashSecret(secret), e.secretHash) ? e : null;
  };

  return {
    request(req) {
      const at = now();
      sweep(at);
      const node = admittedNode(req.remoteAddress, req.allowList);
      if (!node || !req.linked) return refuse403(at, req.remoteAddress);
      const name = safeName(typeof req.name === 'string' ? req.name : null);

      // Per phone first: one noisy node runs out of its own budget long
      // before it can crowd the account's.
      const mine = stamps.filter((s) => s.node === node);
      if (mine.length >= config.perNodeMax) {
        audit(`refused 429 node ${short(node)} (${name}): per-phone limit`);
        return { kind: 'refused', status: 429, error: 'too many requests from this phone; wait and try again', retryAfterSec: wait(mine[0].at, at) };
      }
      const phones = new Set(stamps.map((s) => s.node));
      if (!phones.has(node) && phones.size >= config.perAccountMax) {
        audit(`refused 429 node ${short(node)} (${name}): account limit`);
        return { kind: 'refused', status: 429, error: 'too many phones asked recently; wait and try again', retryAfterSec: wait(stamps[0].at, at) };
      }
      stamps = [...stamps, { node, at }];

      if (req.deviceCount === 0 && at < req.trustUntil) {
        // The caller mints the token synchronously (closing the window in
        // host state), so the next request already sees a device.
        audit(`first phone trusted: node ${short(node)} (${name})`);
        return { kind: 'trusted', name };
      }

      // Never hand back an earlier request: whoever holds its secret is the
      // only one who may poll it. A re-ask replaces it with a fresh one.
      const earlier = [...entries].filter(([, e]) => e.node === node && e.state === 'pending').map(([k]) => k);
      for (const k of earlier) drop(k);

      const id = randomBytes(16).toString('hex');
      const secret = randomBytes(32).toString('hex');
      const matchCode = matchCodeFor(secret);
      const expiresAt = at + config.ttlMs;
      entries = new Map(entries).set(id, {
        node, secretHash: hashSecret(secret), name, matchCode,
        platform: req.info?.platform ?? 'unknown', addedAt: req.info?.createdAt || null,
        createdAt: at, expiresAt, state: 'pending',
      });
      audit(`pending ${id.slice(0, 8)} [${matchCode}]: node ${short(node)} (${name})${earlier.length ? ' (replaces an earlier request)' : ''}`);
      changed();
      return { kind: 'pending', id, secret, matchCode, expiresAt };
    },

    poll(id, secret, who) {
      sweep(now());
      const e = owned(id, secret, who.remoteAddress);
      if (!e) return { status: 'unknown' };
      if (!who.linked || !admittedNode(who.remoteAddress, who.allowList)) {
        drop(id);
        audit(`dropped ${id.slice(0, 8)} (${e.name}): no longer on the account`);
        changed();
        return { status: 'unknown' };
      }
      if (e.state === 'pending') return { status: 'pending', expiresAt: e.expiresAt, matchCode: e.matchCode };
      // Approved or denied: answered once, then gone. An approval is the
      // token, so a second poll must never mint another.
      drop(id);
      if (e.state === 'denied') return { status: 'denied' };
      audit(`token issued for ${id.slice(0, 8)} (${e.name})`);
      return { status: 'approved', name: e.name };
    },

    decide(id, allow, ctx) {
      const at = now();
      sweep(at);
      const e = entries.get(id);
      if (!e || e.state !== 'pending') return false;
      if (!ctx.linked || !ctx.allowList.includes(e.node)) {
        drop(id);
        audit(`dropped ${id.slice(0, 8)} (${e.name}): no longer on the account`);
        changed();
        return false;
      }
      // A fresh window to collect the answer: approving at 4:59 must not
      // leave the phone one poll short.
      entries = new Map(entries).set(id, { ...e, state: allow ? 'approved' : 'denied', expiresAt: at + config.ttlMs });
      audit(`${allow ? 'approved' : 'denied'} ${id.slice(0, 8)} [${e.matchCode}] (${e.name})`);
      changed();
      return true;
    },

    cancel(id, secret, remoteAddress) {
      sweep(now());
      const e = owned(id, secret, remoteAddress);
      if (!e || e.state !== 'pending') return false;
      drop(id);
      audit(`cancelled ${id.slice(0, 8)} (${e.name})`);
      changed();
      return true;
    },

    list() {
      sweep(now());
      return [...entries]
        .filter(([, e]) => e.state === 'pending')
        .map(([id, e]) => ({
          id, name: e.name, matchCode: e.matchCode, platform: e.platform, addedAt: e.addedAt,
          createdAt: e.createdAt, expiresAt: e.expiresAt,
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/**
 * What /health says about pairing, by who is asking. A tunnel peer (any
 * phone on the account) learns nothing: account trust needs no hint, and
 * "has this computer got zero phones?" is exactly what an attacker with the
 * account would want to know. LAN keeps `paired` for the code-on-request
 * path; only Belay.app on loopback gets the count for its menu bar.
 */
export function healthPairingFacts(remoteAddress: string | undefined, count: number): { paired?: boolean; devices?: number } {
  if (!remoteAddress || remoteAddress.startsWith(TUNNEL_REMOTE_ADDRESS)) return {};
  if (isLoopback(remoteAddress)) return { paired: count > 0, devices: count };
  return { paired: count > 0 };
}
