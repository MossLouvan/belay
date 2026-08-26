// Turn what a host reports about itself into a saved computer.
//
// Kept separate from the pairing screen because it has to cope with two kinds
// of host: one running a build that reports an identity and its full address
// list, and an older one that reports neither. Both must produce something the
// device store can hold.

import { HostCheck, PairResult } from '../api';
import { HostAddress, AddressKind, Platform, SavedDevice } from './model';

const KNOWN_KINDS: readonly AddressKind[] = ['lan', 'tailscale', 'magicdns', 'relay'];
const KNOWN_PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'other'];

function toKind(value: unknown): AddressKind {
  return KNOWN_KINDS.includes(value as AddressKind) ? (value as AddressKind) : 'lan';
}

function toPlatform(value: unknown): Platform {
  return KNOWN_PLATFORMS.includes(value as Platform) ? (value as Platform) : 'other';
}

/**
 * The addresses to save for a computer.
 *
 * The URL that actually worked is always included, even when the host also
 * advertises it — that address is proven, and a host behind a proxy or port
 * mapping may not know the URL the phone reached it on.
 */
export function addressesFrom(workingUrl: string, check: HostCheck): readonly HostAddress[] {
  const advertised: HostAddress[] = (check.addresses ?? []).map((a) => ({
    kind: toKind(a.kind),
    url: a.url,
  }));

  if (advertised.some((a) => a.url === workingUrl)) return advertised;
  return [{ kind: 'lan', url: workingUrl }, ...advertised];
}

/**
 * Build a saved computer from a completed pairing.
 *
 * `check` is a fresh /health taken after pairing so the identity and address
 * list are current. When the host is too old to report an id, one is
 * synthesised from the URL — the entry still works, it just cannot be
 * recognised at a different address until the host is updated.
 */
export function buildSavedDevice(
  result: PairResult,
  check: HostCheck,
  now: number,
): SavedDevice {
  return {
    id: check.id ?? `legacy:${result.host}`,
    label: check.label || result.hostName || 'My computer',
    platform: toPlatform(check.platform),
    addresses: addressesFrom(result.host, check),
    token: result.token,
    addedAt: now,
    lastConnectedAt: now,
    lastKnownGoodUrl: result.host,
  };
}
