// How many clients are on a pty session, kept current while its screen is open.
//
// Neither of the two channels the phone already has can answer this. The attach
// socket reports `attached` once, in the handshake, and has no message for
// somebody joining later — the pty itself does not care how many clients it
// has, only how wide the smallest one is. The attention store's push socket
// carries status and approvals, not client counts, so its rows go stale on this
// field the moment anyone attaches.
//
// So it is polled, on the one screen where it matters and only while that
// screen is showing something live. The cost is one small GET every few
// seconds; the alternative is a header that says a colleague is at the desk
// long after they have walked away, or — worse — stays silent while they type.

import { useEffect, useState } from 'react';
import { api } from '../api';

/** Slow enough to be free, fast enough that somebody joining is noticed. */
export const ATTACHED_POLL_MS = 4000;

/**
 * The live client count for `id`, or `fallback` until the first poll answers.
 *
 * Polling stops whenever the screen is not live: a session that has exited or
 * refused has no count worth asking for, and asking anyway would be a request
 * every few seconds for as long as the user leaves the screen open.
 */
export function useAttachedCount(id: string, live: boolean, fallback?: number): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    setCount(undefined);
  }, [id]);

  useEffect(() => {
    if (!id || !live) return undefined;
    let running = true;
    const tick = async (): Promise<void> => {
      try {
        const snap = await api.agentSnapshot(id);
        if (running) setCount(snap.attached);
      } catch {
        // A failed poll leaves the last honest number in place rather than
        // claiming the session suddenly has nobody on it.
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, ATTACHED_POLL_MS);
    return () => {
      running = false;
      clearInterval(timer);
    };
  }, [id, live]);

  return count ?? fallback;
}
