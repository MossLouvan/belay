// The pure half of notification deep-linking.
//
// Every host notification carries `belay://agent?host=<hostId>&session=<id>`
// (server/src/notify.ts). This module decides what that URL means for *this*
// phone: which saved computer it names, whether a switch is needed first, and
// when a deferred open should fire or be abandoned. The React glue — the
// expo-linking listener and the navigation — lives in `app/_layout.tsx`; this
// file stays free of React and React Native so it runs under node:test as-is.
//
// The one rule that matters: a computer is identified by its stable host id,
// never by an address. Addresses change with every DHCP lease and network
// roam; the id is the identity (see app/src/devices/model.ts).

import type { SavedDevice } from '../devices/model';

/** The two facts a notification link carries. */
export interface AgentLink {
  readonly hostId: string;
  readonly sessionId: string;
}

/** What the app should do with a parsed link, given the saved computers. */
export type AgentLinkPlan =
  | { readonly kind: 'open'; readonly sessionId: string }
  | { readonly kind: 'switch'; readonly hostId: string; readonly sessionId: string }
  | { readonly kind: 'host-not-found'; readonly hostId: string };

/** The fate of an open that was deferred until a host switch settles. */
export type PendingVerdict = 'open' | 'wait' | 'drop';

/**
 * Parse a URL the OS handed us, or null if it is not an agent link.
 *
 * This is a boundary: the input is whatever launched the app — a pairing QR,
 * a stale notification, an arbitrary URL another app fired at our scheme.
 * Null (not a throw) lets the caller ignore everything that is not ours.
 * The pre-rename `tether:` scheme is still registered and still accepted, so
 * notifications delivered before the rename keep working.
 */
export function parseAgentLink(raw: string): AgentLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'belay:' && url.protocol !== 'tether:') return null;
  // `belay://agent?...` parses with hostname 'agent' and an empty pathname on
  // some platforms, and as a pathname on others — accept either shape rather
  // than depending on the platform's URL implementation.
  const isAgent = url.hostname === 'agent' || url.pathname.replace(/\//g, '') === 'agent';
  if (!isAgent) return null;

  const hostId = url.searchParams.get('host') ?? '';
  const sessionId = url.searchParams.get('session') ?? '';
  if (!hostId || !sessionId) return null;

  return { hostId, sessionId };
}

/**
 * Decide what a link means given the saved computers and which one is active.
 *
 * Matching is on `SavedDevice.id` — the host-generated stable id — and nothing
 * else. A link for the active computer opens directly; a link for another
 * saved computer asks for a switch first; a link for a computer this phone has
 * never paired with (or has since forgotten) is reported as such rather than
 * guessed at.
 */
export function planAgentLink(
  link: AgentLink,
  devices: readonly SavedDevice[],
  activeId: string | null,
): AgentLinkPlan {
  const target = devices.find((d) => d.id === link.hostId);
  if (!target) return { kind: 'host-not-found', hostId: link.hostId };
  if (target.id === activeId) return { kind: 'open', sessionId: link.sessionId };
  return { kind: 'switch', hostId: target.id, sessionId: link.sessionId };
}

/**
 * Whether the session a link names still exists on the (now-active) host.
 *
 * Optimistic when the list is unknown: a failed fetch must not block the open,
 * because the session view has its own honest error surface. A fetched list
 * that lacks the id is the one case worth catching — the session was pruned —
 * where landing on the session list beats opening a view of nothing.
 */
export function sessionKnown(
  sessions: readonly { readonly id: string }[] | null,
  sessionId: string,
): boolean {
  if (sessions === null) return true;
  return sessions.some((s) => s.id === sessionId);
}

/**
 * Settle an open that was deferred until a host switch resolved.
 *
 * - `open`: the named computer is connected — do it now.
 * - `wait`: the switch is still racing addresses — check again next change.
 * - `drop`: the moment has passed — the computer is unreachable (the tab is
 *   already showing that, honestly), the user moved to a different computer
 *   meanwhile, or everything was forgotten. A session that surprise-opens
 *   minutes later after a manual retry would be navigation the user no longer
 *   asked for.
 */
export function settlePendingOpen(
  pending: AgentLink,
  activeId: string | null,
  phase: 'idle' | 'connecting' | 'connected' | 'unreachable',
): PendingVerdict {
  if (activeId !== pending.hostId) return 'drop';
  if (phase === 'connected') return 'open';
  if (phase === 'connecting') return 'wait';
  return 'drop';
}
