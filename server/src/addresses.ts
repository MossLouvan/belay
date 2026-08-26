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
 * The range alone is NOT proof. 100.64.0.0/10 is the standard carrier-grade NAT
 * range and plenty of ISPs hand it out on ordinary Wi-Fi — observed in practice
 * on a machine with no Tailscale installed at all, where the address sat on
 * `en0`. Treating that as Tailscale is worse than saying nothing: a CGNAT
 * address means the opposite of reachable-from-anywhere, since there is no
 * public address and no port to forward, so the host would claim it could be
 * reached from outside precisely when it cannot be.
 *
 * So the range is necessary but not sufficient — the address must also sit on a
 * tunnel interface, which is what Tailscale actually creates.
 */
const CGNAT_RANGE = { first: 0x64400000, last: 0x647fffff } as const;

/**
 * Interface names Tailscale uses for its tunnel.
 *
 * macOS and iOS use `utun<N>`; Linux and Windows use `tailscale0`. An ISP's
 * CGNAT address arrives on a physical interface (`en0`, `eth0`, `wlan0`), which
 * is the distinction that makes this reliable.
 */
const TUNNEL_INTERFACE = /^(utun\d*|tailscale\d*|ts\d+)$/i;

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

/** Whether an IPv4 address falls in the CGNAT range. True for ISP NAT too. */
export function isCgnatAddress(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return value >= CGNAT_RANGE.first && value <= CGNAT_RANGE.last;
}

/** Whether an interface name is a tunnel rather than a physical adapter. */
export function isTunnelInterface(name: string): boolean {
  return TUNNEL_INTERFACE.test(name);
}

/**
 * Whether this address is genuinely a Tailscale address.
 *
 * Requires both the CGNAT range and a tunnel interface. Without the second
 * check an ISP's CGNAT address on Wi-Fi is indistinguishable from a tailnet
 * address, and the host ends up promising reachability it does not have.
 */
export function isTailscaleAddress(address: string, interfaceName: string): boolean {
  return isCgnatAddress(address) && isTunnelInterface(interfaceName);
}

/** An address together with the interface it was found on. */
export interface LocalAddress {
  readonly address: string;
  readonly interfaceName: string;
}

/**
 * Non-internal IPv4 addresses this host is bound to, with their interfaces.
 *
 * The interface name is carried through because it is the only thing that
 * distinguishes a Tailscale address from an ISP CGNAT address — see the note on
 * CGNAT_RANGE.
 */
export function localAddresses(): readonly LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [interfaceName, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ address: info.address, interfaceName });
    }
  }
  return out;
}

/** Just the addresses, for callers that do not care where they came from. */
export function localIPv4(): readonly string[] {
  return localAddresses().map((a) => a.address);
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
  found: readonly LocalAddress[] = localAddresses(),
): readonly HostAddress[] {
  const discovered: HostAddress[] = found.map((entry) => ({
    kind: isTailscaleAddress(entry.address, entry.interfaceName)
      ? ('tailscale' as const)
      : ('lan' as const),
    url: `http://${entry.address}:${port}`,
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
