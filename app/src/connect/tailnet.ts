// Getting onto the tailnet without making anyone type a 100.x address.
//
// The host pairs without a code when the request arrives over the owner's own
// tailnet — it recognises the phone through the Tailscale daemon and the code
// becomes redundant. But that decision is made from the *source address of the
// connection*, so it only fires when the phone actually reached the host over
// Tailscale. Type the LAN address while sitting at home and the host sees
// 192.168.x, cannot identify the peer, and asks for the six digits.
//
// The address that would have worked is already in the reply: every host
// advertises its full address list on /health, tailnet address included. So
// nobody needs to know or type it — when a check lands on a non-tailnet
// address and the host advertises a tailnet one, we re-check over that instead
// and pair with no code.
//
// When that second check fails, the host is up (the first one answered) and the
// tailnet address is not, which means this phone is not on the tailnet — the
// Tailscale app is off or not installed. That is a thing the user can fix in
// one tap, so it is worth telling them apart from a generic failure.

import type { HostCheck } from '../api';

/** Opens the Tailscale app if it is installed. */
export const TAILSCALE_APP_URL = 'tailscale://';
/** Where to send someone who does not have it yet. */
export const TAILSCALE_STORE_URL = 'https://apps.apple.com/app/tailscale/id1470499037';

/**
 * Address kinds that carry tailnet identity.
 *
 * MagicDNS names resolve to the same 100.x address through the same tunnel, so
 * the host sees an identical source address and both pair without a code.
 */
const TAILNET_KINDS: readonly string[] = ['tailscale', 'magicdns'];

export type TailnetPlan =
  /** Already talking over the tailnet — the host will pair with no code. */
  | { readonly kind: 'ready' }
  /** Re-check over this address instead; it should pair with no code. */
  | { readonly kind: 'upgrade'; readonly url: string }
  /** The host has no tailnet address to offer. The code is the only way in. */
  | { readonly kind: 'unavailable' };

/**
 * The tailnet address a host advertises, if any.
 *
 * Prefers the literal `tailscale` address over `magicdns`: both reach the same
 * node, but the literal one needs no name resolution, and MagicDNS is the part
 * of a tailnet most likely to be switched off.
 */
export function tailnetUrlFrom(check: HostCheck): string | null {
  const addresses = check.addresses ?? [];
  for (const kind of TAILNET_KINDS) {
    const match = addresses.find((a) => a.kind === kind && Boolean(a.url));
    if (match) return match.url;
  }
  return null;
}

/**
 * What to do after a host check succeeds, given the address it succeeded on.
 *
 * `pairing === 'tailnet'` means the host already recognised this phone, so
 * there is nothing to upgrade — that is true however the address was written.
 * An upgrade is only worth a second round trip when it points somewhere new.
 */
export function planTailnetUpgrade(check: HostCheck, checkedUrl: string): TailnetPlan {
  if (check.pairing === 'tailnet') return { kind: 'ready' };

  const url = tailnetUrlFrom(check);
  if (!url) return { kind: 'unavailable' };
  if (sameHost(url, checkedUrl)) return { kind: 'unavailable' };

  return { kind: 'upgrade', url };
}

/**
 * How many times to try the tailnet address before giving up on it.
 *
 * The first packet over a cold tailnet is the slow one: the peers have to find
 * each other, usually via a relay, before the direct path is established. That
 * can outlast a single request deadline on a link that then works fine — so a
 * lone timeout is not evidence that Tailscale is off, and treating it as such
 * sends people to fix something that is not broken.
 */
export const TAILNET_PROBE_ATTEMPTS = 3;

export type TailnetOutcome =
  /** Pair over this address with no code. */
  | { readonly kind: 'paired-path'; readonly url: string }
  /** The host is up but unreachable over the tailnet: Tailscale is off here. */
  | { readonly kind: 'tailscale-off'; readonly detail?: string }
  /** Reachable, but the host still wants a code — fall back to the digits. */
  | { readonly kind: 'code-required' };

/**
 * Read the result of the upgraded check.
 *
 * The distinction that matters is the middle one: an unreachable tailnet
 * address, on a host that just answered on another address, is not a broken
 * host. It is a phone that is not on the tailnet.
 */
export function readTailnetProbe(url: string, probe: HostCheck): TailnetOutcome {
  if (!probe.ok) return { kind: 'tailscale-off', detail: probe.error };
  if (probe.pairing === 'tailnet') return { kind: 'paired-path', url };
  return { kind: 'code-required' };
}

/**
 * Whether two URLs point at the same host, ignoring how they were written.
 *
 * A typed address and an advertised one routinely differ by scheme, a trailing
 * slash or an explicit `:8787`, and re-checking an address we just checked
 * costs a round trip and tells us nothing new.
 */
function sameHost(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/:8787$/, '');
}
