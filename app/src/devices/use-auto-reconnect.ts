// Drives "Keep trying" on the computer list: while enabled and the active
// computer is unreachable, it re-attempts the real connection on a backing-off
// schedule and stands down the moment the machine answers. A hook, so it lives
// beside the reachability hook rather than being node-tested — the schedule it
// leans on is the part with the unit tests (reconnect-backoff.ts).

import { useEffect, useState } from 'react';
import type { ConnectPhase } from '../connection';
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

  return attempts;
}
