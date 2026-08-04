// Every address this host believes it can be reached on, classified by kind.
//
// The phone stores all of them per computer and races them at connect time, so
// it silently uses the fast LAN path at home and the tunnel on cellular without
// the user ever choosing. That only works if the host tells it about every
// path, so this module's job is to enumerate generously and label honestly.
//
// The ordering matters and is deliberate. `lan` is fastest but is only ever an
// *optimization layered on top of* a stable address: if the LAN IP changes
// while the phone is away, the phone cannot reach the host to learn the new
// one. `tailscale`/`magicdns` addresses are bound to the device record rather
// than the network, so they survive reboots, DHCP churn and moving house —
// which is why a saved device must never end up with only a LAN address.

import { networkInterfaces } from 'node:os';

/**
 * Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range.
 *
 * Note this range is also used by some ISPs for real carrier-grade NAT, so a
 * `100.x` address is a strong hint rather than proof. Mislabelling is cheap
 * here — the address still gets raced like any other; it only affects ordering.
 */
const TAILSCALE_CGNAT = { first: 0x64400000, last: 0x647fffff } as const;

export type AddressKind = 'lan' | 'tailscale' | 'magicdns' | 'relay';

export interface HostAddress {
  readonly kind: AddressKind;
  readonly url: string;
}

/**
 * Preference order used when the phone has no recent success to go on.
 * Lower sorts first.
 */
const KIND_ORDER: Record<AddressKind, number> = {
  lan: 0,
  magicdns: 1,
  tailscale: 2,
  relay: 3,
};

/** Parse a dotted-quad into a 32-bit integer, or null if it isn't one. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Whether an IPv4 address falls in Tailscale's CGNAT range. */
export function isTailscaleAddress(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return value >= TAILSCALE_CGNAT.first && value <= TAILSCALE_CGNAT.last;
}

/** Non-internal IPv4 addresses this host is currently bound to. */
export function localIPv4(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * Build the advertised address list.
 *
 * `extra` carries addresses this module cannot discover by looking at network
 * interfaces — a MagicDNS name or a relay id reported by a sidecar. They are
 * merged rather than appended so a sidecar-reported Tailscale name wins over
 * the bare `100.x` address we inferred ourselves.
 */
export function buildAddresses(
  port: number,
  extra: readonly HostAddress[] = [],
  ips: readonly string[] = localIPv4(),
): readonly HostAddress[] {
  const discovered: HostAddress[] = ips.map((ip) => ({
    kind: isTailscaleAddress(ip) ? ('tailscale' as const) : ('lan' as const),
    url: `http://${ip}:${port}`,
  }));

  const byUrl = new Map<string, HostAddress>();
  // `extra` is applied last so an explicitly reported address overrides an
  // inferred classification for the same URL.
  for (const address of [...discovered, ...extra]) byUrl.set(address.url, address);

  return [...byUrl.values()].sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return byKind !== 0 ? byKind : a.url.localeCompare(b.url);
  });
}

/**
 * Whether this address set contains anything that survives an IP change.
 *
 * A device saved with LAN addresses only is one DHCP lease away from being
 * unreachable from outside the house, with no way to self-heal. The host uses
 * this to warn at boot; the app uses the same idea to nudge toward Tailscale.
 */
export function hasStableAddress(addresses: readonly HostAddress[]): boolean {
  return addresses.some((a) => a.kind !== 'lan');
}
