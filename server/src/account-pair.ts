// Account trust: a phone on the same Belay account pairs without a code.
//
// Only a tunnel peer whose nodeId is on the account allow-list may ask (the
// tunnel listener tags its sockets `tunnel:<nodeId>`; the sidecar admits only
// allow-listed nodes, and this re-checks). Then:
//
//   first phone   the host is account-linked AND has zero paired devices:
//                 trusted at once. That window runs from link time until the
//                 first phone pairs; it is the claim QR scan, done at this
//                 computer, that put this account in charge of it.
//   later phones  a pending request the owner approves with ONE tap, on
//                 Belay.app or on a phone that is already paired. Five
//                 minutes, then it is gone.
//
// So an account compromise alone gets an attacker at most a pending request
// the owner sees and can deny. LAN, loopback and unknown nodes get 403; the
// 6-digit /pair stays for computers that are not account-linked.
//
// Pure module: no HTTP, clock injected, state per process. The caller mints
// the device token; `poll` hands an approval out exactly once.

import { randomBytes } from 'node:crypto';

import { safeName } from './pair-notify.js';
import { TUNNEL_REMOTE_ADDRESS } from './tunnel-listener.js';

export const ACCOUNT_PAIR_DEFAULTS = {
  /** How long a request waits for a tap. */
  ttlMs: 5 * 60 * 1000,
  windowMs: 10 * 60 * 1000,
  /** Requests per account (this host has one) per window. */
  perAccountMax: 3,
  /** Requests per phone node per window. */
  perNodeMax: 2,
} as const;

type Options = { -readonly [K in keyof typeof ACCOUNT_PAIR_DEFAULTS]: number } & {
  readonly audit?: (line: string) => void;
};

export interface AccountPairRequest {
  readonly remoteAddress: string | undefined;
  readonly allowList: readonly string[];
  readonly linked: boolean;
  readonly deviceCount: number;
  readonly name: unknown;
}

export type AccountPairDecision =
  | { readonly kind: 'refused'; readonly status: 403 | 429; readonly error: string; readonly retryAfterSec: number }
  | { readonly kind: 'trusted'; readonly name: string }
  | { readonly kind: 'pending'; readonly id: string; readonly expiresAt: number };

export type AccountPairPoll =
  | { readonly status: 'pending'; readonly expiresAt: number }
  | { readonly status: 'approved'; readonly name: string }
  | { readonly status: 'denied' }
  | { readonly status: 'unknown' };

/** What Belay.app and paired phones see: never the node id. */
export interface PendingPhone {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AccountPairing {
  request(req: AccountPairRequest): AccountPairDecision;
  /** Only the node that asked gets an answer; anyone else sees 'unknown'. */
  poll(id: string, remoteAddress: string | undefined): AccountPairPoll;
  /** False for an unknown, expired or already decided request. */
  decide(id: string, allow: boolean): boolean;
  cancel(id: string, remoteAddress: string | undefined): boolean;
  /** Requests still waiting for a tap, oldest first. */
  list(): readonly PendingPhone[];
  onChange(fn: () => void): () => void;
}

interface Entry {
  readonly node: string;
  readonly name: string;
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

const ID = /^[0-9a-f]{32}$/;

export function createAccountPairing(options: Partial<Options> = {}, now: () => number = Date.now): AccountPairing {
  const config = { ...ACCOUNT_PAIR_DEFAULTS, ...options };
  const audit = options.audit ?? (() => {});
  let entries = new Map<string, Entry>();
  let stamps: readonly { readonly node: string; readonly at: number }[] = [];
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

  const retryAfter = (list: readonly { at: number }[], max: number, at: number): number =>
    list.length < max ? 0 : Math.ceil((list[0].at + config.windowMs - at) / 1000);

  const short = (node: string) => node.slice(0, 12);

  return {
    request(req) {
      const at = now();
      sweep(at);
      const node = admittedNode(req.remoteAddress, req.allowList);
      if (!node || !req.linked) {
        audit(`refused 403 from ${req.remoteAddress ?? 'unknown'}${node && !req.linked ? ' (host not linked)' : ''}`);
        return { kind: 'refused', status: 403, error: 'only phones on this computer\'s Belay account may ask', retryAfterSec: 0 };
      }
      const name = safeName(typeof req.name === 'string' ? req.name : null);

      const existing = [...entries].find(([, e]) => e.node === node && e.state === 'pending');
      if (existing) return { kind: 'pending', id: existing[0], expiresAt: existing[1].expiresAt };

      const wait = Math.max(
        retryAfter(stamps, config.perAccountMax, at),
        retryAfter(stamps.filter((s) => s.node === node), config.perNodeMax, at),
      );
      if (wait > 0) {
        audit(`refused 429 node ${short(node)} (${name})`);
        return { kind: 'refused', status: 429, error: 'too many requests to add a phone; wait and try again', retryAfterSec: wait };
      }
      stamps = [...stamps, { node, at }];

      // The first-phone window: linked, and nothing paired yet. The caller
      // mints the token synchronously, so the next request already sees one.
      if (req.deviceCount === 0) {
        audit(`first phone trusted: node ${short(node)} (${name})`);
        return { kind: 'trusted', name };
      }

      const id = randomBytes(16).toString('hex');
      const expiresAt = at + config.ttlMs;
      entries = new Map(entries).set(id, { node, name, createdAt: at, expiresAt, state: 'pending' });
      audit(`pending ${id.slice(0, 8)}: node ${short(node)} (${name})`);
      changed();
      return { kind: 'pending', id, expiresAt };
    },

    poll(id, remoteAddress) {
      sweep(now());
      const e = ID.test(id) ? entries.get(id) : undefined;
      if (!e || remoteAddress !== `${TUNNEL_REMOTE_ADDRESS}${e.node}`) return { status: 'unknown' };
      if (e.state === 'pending') return { status: 'pending', expiresAt: e.expiresAt };
      // Approved or denied: answered once, then gone. An approval is the
      // token, so a second poll must never mint another.
      entries = new Map([...entries].filter(([k]) => k !== id));
      if (e.state === 'denied') return { status: 'denied' };
      audit(`token issued for ${id.slice(0, 8)} (${e.name})`);
      return { status: 'approved', name: e.name };
    },

    decide(id, allow) {
      const at = now();
      sweep(at);
      const e = entries.get(id);
      if (!e || e.state !== 'pending') return false;
      // A fresh window to collect the answer: approving at 4:59 must not
      // leave the phone one poll short.
      entries = new Map(entries).set(id, { ...e, state: allow ? 'approved' : 'denied', expiresAt: at + config.ttlMs });
      audit(`${allow ? 'approved' : 'denied'} ${id.slice(0, 8)} (${e.name})`);
      changed();
      return true;
    },

    cancel(id, remoteAddress) {
      sweep(now());
      const e = entries.get(id);
      if (!e || e.state !== 'pending' || remoteAddress !== `${TUNNEL_REMOTE_ADDRESS}${e.node}`) return false;
      entries = new Map([...entries].filter(([k]) => k !== id));
      audit(`cancelled ${id.slice(0, 8)} (${e.name})`);
      changed();
      return true;
    },

    list() {
      sweep(now());
      return [...entries]
        .filter(([, e]) => e.state === 'pending')
        .map(([id, e]) => ({ id, name: e.name, createdAt: e.createdAt, expiresAt: e.expiresAt }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
