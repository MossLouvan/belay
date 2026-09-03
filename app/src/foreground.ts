// The return-to-foreground reattach decision (backlog item
// `auto-reattach-foreground`).
//
// iOS kills sockets while the app is backgrounded, so the moment the user
// comes back is exactly the moment every backoff timer is at its most wrong:
// the outage that scheduled it is stale news, and the user is watching the
// screen RIGHT NOW. Both reconnect loops — the screen stream and the computer
// list's "Keep trying" — cut the wait short on the `active` transition and
// attempt immediately. The one rule that keeps that from double-firing lives
// here as a pure function, shared by both loops and pinned by `node --test`
// (src/foreground.test.mjs), which cannot import the react-native hooks.

/**
 * What the link is doing at the moment the app-state event arrives.
 *
 * - `waiting`   — a backoff timer is pending; nothing is being attempted.
 * - `in-flight` — an attempt is already racing; a second would stack on it.
 * - `live`      — the link is up; there is nothing to reattach.
 * - `off`       — reattaching is not wanted (feature off, or terminal error).
 */
export type ReattachLink = 'waiting' | 'in-flight' | 'live' | 'off';

/**
 * Whether a foreground transition should cut the backoff short and attempt
 * immediately. True only for the `active` transition while a backoff wait is
 * pending — a live link, an attempt already in flight, and every non-active
 * app state (background, inactive, unknown) all leave the machinery alone.
 */
export const shouldReattachOnForeground = (nextAppState: string, link: ReattachLink): boolean =>
  nextAppState === 'active' && link === 'waiting';

/**
 * Maps the computer-list auto-reconnect's inputs onto a `ReattachLink`.
 * `phase` is the app-wide `ConnectPhase` (typed as string so this module
 * stays importable by the node test runner, which cannot load connection.tsx):
 * `connected` is live, `connecting` is in flight, and both `idle` and
 * `unreachable` are waits worth cutting short.
 */
export const connectionReattachLink = (enabled: boolean, phase: string): ReattachLink => {
  if (!enabled) return 'off';
  if (phase === 'connected') return 'live';
  if (phase === 'connecting') return 'in-flight';
  return 'waiting';
};
