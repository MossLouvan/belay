// What to do with the computers a connected host found on its tailnet.
//
// The host reports every Belay peer it can vouch for; this module decides what
// the phone shows. Two jobs: drop the computers already in the saved list (the
// host cannot do this — it has no idea which machines this phone holds tokens
// for), and turn each "found nothing" shape into words that state what was
// observed rather than a generic shrug (docs/DESIGN.md §11.4) — Tailscale off,
// no peers, and peers-without-Belay are different states with different fixes.
//
// Pure, so it runs under node without React or react-native.

import type { DiscoverHostsReply, DiscoveredHost } from '../api';
import type { SavedDevice } from './model';

/**
 * The discovered hosts not yet in the saved list.
 *
 * Matched on id first — the same key the store uses — and then on address
 * overlap, because a computer saved before hosts reported ids carries a
 * synthesised `legacy:` id that will never match, while its URL will.
 */
export function newlyDiscovered(
  hosts: readonly DiscoveredHost[],
  saved: readonly SavedDevice[],
): readonly DiscoveredHost[] {
  const savedIds = new Set(saved.map((d) => d.id));
  const savedUrls = new Set(saved.flatMap((d) => d.addresses.map((a) => a.url)));
  return hosts.filter((h) =>
    !savedIds.has(h.id)
    && h.url !== undefined && !savedUrls.has(h.url)
    && !h.addresses.some((a) => savedUrls.has(a.url)));
}

/**
 * Every way in to a discovered computer, in the order to race them.
 *
 * The advertised list keeps the host's own ordering (LAN first — fastest when
 * it answers, and the race makes a dead entry cost one abandoned request, not
 * a wait). The URL the reporting host actually reached it on is appended when
 * it is not already advertised: proven from *somewhere*, so worth a try, but
 * proven from the host's vantage point, not this phone's.
 */
export function candidateUrls(host: DiscoveredHost): readonly string[] {
  const urls = host.addresses.map((a) => a.url);
  return urls.includes(host.url) ? urls : [...urls, host.url];
}

/**
 * Whether a failed pair means the host demanded a code.
 *
 * The code-less path only fires when the request arrives over the host's own
 * tailnet; a phone that reached a discovered computer over LAN instead gets
 * the ordinary code refusal, and the fix — pair with a code — is nothing like
 * the fix for a network failure.
 */
export function pairNeedsCode(message: string): boolean {
  return /pairing code/i.test(message);
}

/** The §11.4 anatomy for a discovery that surfaced nothing to add. */
export interface DiscoverySummary {
  /** The state name, set as a dim label. */
  readonly state: string;
  /** The observed truth, in body prose. */
  readonly message: string;
}

/**
 * Words for an empty discovery. Null when there are fresh hosts to show —
 * rows speak for themselves. `viaLabel` names the computer that did the
 * looking, because "Tailscale isn't running" must say *where*: the phone's
 * own Tailscale state is a different thing entirely.
 */
export function summarizeDiscovery(
  reply: DiscoverHostsReply,
  freshCount: number,
  viaLabel: string,
): DiscoverySummary | null {
  if (freshCount > 0) return null;

  if (!reply.tailscale) {
    return {
      state: 'Tailscale unavailable',
      message: `${viaLabel} could not ask Tailscale who else is on your network`
        + (reply.detail ? ` — ${reply.detail}` : '') + '.',
    };
  }

  if (reply.peers === 0) {
    return {
      state: 'No other devices',
      message: 'No other device is online on your Tailscale account right now.',
    };
  }

  if (reply.hosts.length === 0) {
    const device = reply.peers === 1 ? 'One other device is' : `${reply.peers} other devices are`;
    return {
      state: 'No Belay hosts found',
      message: `${device} on your tailnet, but none answered as a Belay host. `
        + 'Start the host agent on the computer you want to add.',
    };
  }

  // Hosts were found; every one of them is already saved.
  return {
    state: 'All added',
    message: 'Every Belay host on your tailnet is already in your list.',
  };
}
