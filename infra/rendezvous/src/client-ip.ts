// Deriving the real client IP behind a trusted TLS-terminating proxy.
//
// The deploy (infra/docker-compose.yml) mandates a proxy — Caddy/nginx or a
// cloud LB — in front of the rendezvous, which speaks plain HTTP/WS. Behind it,
// EVERY connection's socket.remoteAddress is the proxy, so keying rate limits
// on remoteAddress collapses per-IP buckets into ONE global bucket: a single
// abusive client would then rate-limit every host's lease renewal and everyone
// else's TURN minting — a trivial DoS.
//
// The fix is the standard "rightmost-untrusted X-Forwarded-For" walk, but it is
// only safe when the immediate peer is itself a trusted proxy. XFF is a plain
// header any client can forge, so:
//   - Peer NOT in the trusted set  -> ignore XFF entirely, key on remoteAddress
//     (an untrusted client cannot spoof its bucket by sending a header).
//   - Peer IS a trusted proxy      -> walk XFF right-to-left, skip entries that
//     are themselves trusted proxies (proxy chains), and take the first
//     untrusted entry as the client. That entry is the address the innermost
//     trusted hop actually observed; everything to its left is client-supplied
//     and therefore untrustworthy.
//
// Trusted set is configured via the TRUSTED_PROXIES env var (comma-separated
// IPs and/or CIDRs). DEFAULT (unset/empty) = trust nobody = always key on
// remoteAddress and never read XFF. That is the safe default: correct for a
// direct-exposure or single-tenant dev setup, and fail-safe (no spoofing) if an
// operator forgets to configure it behind a proxy — the only cost is that a
// genuinely-proxied deploy must set TRUSTED_PROXIES to get per-client buckets.

export interface TrustedProxyMatcher {
  /** True if `ip` falls in any configured trusted IP/CIDR. */
  contains(ip: string): boolean;
  /** Number of configured entries (0 => trust nobody). */
  readonly size: number;
}

interface Cidr {
  readonly value: bigint;
  readonly prefix: number;
  readonly bits: 32 | 128;
}

/** Parse TRUSTED_PROXIES (comma-separated IPs/CIDRs) into a matcher. Invalid
 *  entries are skipped rather than throwing — a malformed proxy entry must not
 *  take the whole rendezvous down at boot. */
export function parseTrustedProxies(raw: string | undefined): TrustedProxyMatcher {
  const cidrs: Cidr[] = [];
  for (const entryRaw of (raw ?? '').split(',')) {
    const entry = entryRaw.trim();
    if (entry.length === 0) continue;
    const parsed = parseCidr(entry);
    if (parsed) cidrs.push(parsed);
  }

  return {
    size: cidrs.length,
    contains(ip: string): boolean {
      if (cidrs.length === 0) return false;
      const addr = parseIp(ip);
      if (!addr) return false;
      for (const cidr of cidrs) {
        if (cidr.bits !== addr.bits) continue;
        const mask = prefixMask(cidr.prefix, cidr.bits);
        if ((addr.value & mask) === (cidr.value & mask)) return true;
      }
      return false;
    },
  };
}

/**
 * Derive the client IP to key rate limiting on. Pure over its inputs — the
 * server binds it to (socket.remoteAddress, x-forwarded-for header, trusted).
 */
export function deriveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: TrustedProxyMatcher,
): string {
  const remote = normalizeIp(remoteAddress) ?? 'unknown';

  // No trusted proxies, or the immediate peer is not one: never read XFF.
  if (trusted.size === 0 || !trusted.contains(remote)) return remote;

  // Peer is a trusted proxy: find the rightmost XFF entry that is NOT itself a
  // trusted proxy — that is the closest observed, non-forgeable client address.
  const entries = xffEntries(forwardedFor);
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = normalizeIp(entries[i]);
    if (candidate && !trusted.contains(candidate)) return candidate;
  }

  // Every hop was trusted (or XFF was empty/garbage): nothing more specific to
  // key on than the proxy itself.
  return remote;
}

function xffEntries(forwardedFor: string | string[] | undefined): string[] {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '';
  return header.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Normalize an address for matching: strip an IPv4-mapped IPv6 prefix so
 *  `::ffff:127.0.0.1` and `127.0.0.1` compare equal, and drop IPv6 brackets. */
function normalizeIp(ip: string | undefined): string | null {
  if (typeof ip !== 'string') return null;
  let s = ip.trim();
  if (s.length === 0) return null;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(s);
  if (mapped) s = mapped[1];
  return parseIp(s) ? s : null;
}

interface ParsedIp {
  readonly value: bigint;
  readonly bits: 32 | 128;
}

function parseIp(ip: string): ParsedIp | null {
  if (ip.includes('.') && !ip.includes(':')) {
    const v = ipv4ToBigInt(ip);
    return v === null ? null : { value: v, bits: 32 };
  }
  if (ip.includes(':')) {
    const v = ipv6ToBigInt(ip);
    return v === null ? null : { value: v, bits: 128 };
  }
  return null;
}

function parseCidr(entry: string): Cidr | null {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    const addr = parseIp(entry);
    if (!addr) return null;
    return { value: addr.value, prefix: addr.bits, bits: addr.bits };
  }
  const addr = parseIp(entry.slice(0, slash));
  if (!addr) return null;
  const prefix = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > addr.bits) return null;
  return { value: addr.value, prefix, bits: addr.bits };
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Reject a zone id and any IPv4-in-IPv6 tail we did not already normalize.
  if (ip.includes('%') || ip.includes('.')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const toGroups = (s: string): string[] => (s.length === 0 ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function prefixMask(prefix: number, bits: 32 | 128): bigint {
  if (prefix === 0) return 0n;
  const full = (1n << BigInt(bits)) - 1n;
  return (full << BigInt(bits - prefix)) & full;
}
