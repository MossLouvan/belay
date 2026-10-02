// Who may make the host show a fresh pairing code on its own screen (#150).
//
// An already-paired host issues no code by itself, so a second phone (or a
// reinstalled one) used to hit a dead end. POST /pair/request lets the phone
// ask for one. Asking never reveals the code: it only puts a short-lived code
// on the COMPUTER'S screen (Belay.app's window and the native popup), which is
// still the proof of physical presence pairing has always relied on. The
// device token from /pair stays the only thing that grants control, so an
// account compromise alone still cannot pair a phone.
//
// What this gate adds is a bound on how often a code can be conjured:
//
//   source      an allow-listed tunnel peer (`tunnel:<nodeId>` with the node
//               on the account's allow-list) or a LAN address. Anything else
//               — a public address, an unknown tunnel node — gets 403 and
//               the computer shows nothing.
//   per source  a few requests per window, so one phone cannot spam popups.
//   global      a few across all sources, because every minted code carries a
//               fresh pair-guard failure budget: the global cap is what keeps
//               total guesses per hour bounded (see the test).
//
// Refusals are not counted, so a flood from outside cannot use up the
// owner's own allowance. Pure module, clock injected, state per process.

import { BlockList, isIP } from 'node:net';

import { normalizeIp } from './tailnet.js';
import { TUNNEL_REMOTE_ADDRESS } from './tunnel-listener.js';

export const PAIR_REQUEST_DEFAULTS = {
  /** Requests one source may make per window. */
  perSourceMax: 3,
  /** Requests all sources together may make per window. */
  globalMax: 4,
  windowMs: 15 * 60 * 1000,
} as const;

export type PairRequestOptions = { -readonly [K in keyof typeof PAIR_REQUEST_DEFAULTS]: number };

export type PairRequestDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 403 | 429; readonly error: string; readonly retryAfterSec: number };

const LAN = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16],
  ['100.64.0.0', 10], ['127.0.0.0', 8]] as const) LAN.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]] as const) LAN.addSubnet(net, bits, 'ipv6');

/** Private, link-local, CGNAT/tailnet or loopback. Never a tunnel tag. */
export function isLanAddress(ip: string | undefined): boolean {
  const v = normalizeIp(ip);
  const family = isIP(v);
  if (family === 0) return false;
  return LAN.check(v, family === 6 ? 'ipv6' : 'ipv4');
}

const TUNNEL_NODE = /^[0-9a-f]{64}$/;

/** The rate-limit key for an admitted source, or null when it may not ask. */
function admittedKey(remoteAddress: string | undefined, allowList: readonly string[]): string | null {
  if (remoteAddress?.startsWith(TUNNEL_REMOTE_ADDRESS)) {
    const node = remoteAddress.slice(TUNNEL_REMOTE_ADDRESS.length);
    return TUNNEL_NODE.test(node) && allowList.includes(node) ? remoteAddress : null;
  }
  return isLanAddress(remoteAddress) ? normalizeIp(remoteAddress) : null;
}

export interface PairRequestGate {
  /** Decide, and count the request when it is allowed. */
  decide(remoteAddress: string | undefined, allowList: readonly string[]): PairRequestDecision;
}

export function createPairRequestGate(
  options: Partial<PairRequestOptions> = {},
  now: () => number = Date.now,
): PairRequestGate {
  const config: PairRequestOptions = { ...PAIR_REQUEST_DEFAULTS, ...options };
  // ponytail: timestamps per source in a Map, swept on every call; fine at a
  // handful of requests per window, which is all the caps allow anyway.
  let bySource = new Map<string, readonly number[]>();
  let all: readonly number[] = [];

  const limited = (stamps: readonly number[], max: number, at: number): number =>
    stamps.length < max ? 0 : Math.ceil((stamps[0] + config.windowMs - at) / 1000);

  return {
    decide(remoteAddress, allowList) {
      const key = admittedKey(remoteAddress, allowList);
      if (!key) return { allowed: false, status: 403, error: 'pairing codes are only issued to your own devices', retryAfterSec: 0 };

      const at = now();
      const fresh = (stamps: readonly number[]) => stamps.filter((t) => at - t < config.windowMs);
      all = fresh(all);
      bySource = new Map([...bySource].map(([k, v]) => [k, fresh(v)] as const).filter(([, v]) => v.length > 0));
      const mine = bySource.get(key) ?? [];

      const wait = Math.max(limited(mine, config.perSourceMax, at), limited(all, config.globalMax, at));
      if (wait > 0) return { allowed: false, status: 429, error: 'too many pairing code requests; wait and try again', retryAfterSec: wait };

      bySource = new Map(bySource).set(key, [...mine, at]);
      all = [...all, at];
      return { allowed: true };
    },
  };
}
