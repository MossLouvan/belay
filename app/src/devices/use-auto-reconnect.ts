// Drives "Keep trying" on the computer list: while enabled and the active
// computer is unreachable, it re-attempts the real connection on a backing-off
// schedule and stands down the moment the machine answers. A hook, so it lives
// beside the reachability hook rather than being node-tested — the schedule it
// leans on is the part with the unit tests (reconnect-backoff.ts).

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { ConnectPhase } from '../connection';
import { connectionReattachLink, shouldReattachOnForeground } from '../foreground';
import { reconnectDelay } from './reconnect-backoff';

/**
 * @param enabled   whether the user has asked Belay to keep trying
 * @param phase     the app-wide connect phase
 * @param reconnect re-races the active computer's addresses
 * @returns how many attempts have been made this run (0 while idle)
 */
export function useAutoReconnect(
  enabled: boolean,
  phase: ConnectPhase,
  reconnect: () => Promise<void>,
): number {
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    // Off, or already there: nothing to schedule. Reset the counter when off so
    // the next "Keep trying" starts from a fast first attempt.
    if (!enabled) {
      setAttempts(0);
      return undefined;
    }
    if (phase === 'connected') return undefined;
    // An attempt is in flight — wait for its outcome instead of stacking a
    // second connect on top of it.
    if (phase === 'connecting') return undefined;

    // Unreachable (or idle): the first attempt fires immediately, later ones
    // wait out the backoff so a machine that stays asleep is not hammered.
    const delay = attempts === 0 ? 0 : reconnectDelay(attempts - 1);
    const timer = setTimeout(() => {
      setAttempts((n) => n + 1);
      void reconnect();
    }, delay);
    return () => clearTimeout(timer);
  }, [enabled, phase, attempts, reconnect]);

  // Return-to-foreground reattach (backlog item `auto-reattach-foreground`).
  // iOS suspends timers in the background, so the wait pending on return
  // belongs to a stale outage. Resetting the counter to zero both erases the
  // backoff and — through the schedule above, where attempt 0 fires with no
  // delay — attempts the reconnect immediately. The guard is the shared pure
  // decision (../foreground.ts): only an `active` transition while a wait is
  // actually pending fires; a connected machine or an attempt already racing
  // its addresses is left alone, so nothing double-connects. A counter already
  // at zero is a no-op state update, which React bails out of entirely.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (!shouldReattachOnForeground(next, connectionReattachLink(enabled, phase))) return;
      setAttempts(0);
    });
    return () => sub.remove();
  }, [enabled, phase]);

  return attempts;
}
