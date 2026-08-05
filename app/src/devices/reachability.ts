// Live "is this computer up right now" state for the computer list.
//
// Each saved computer is probed by racing its addresses, exactly the way an
// actual connection is made — so a green dot means "I just reached it by some
// path", not "it answered on the address you happened to save first".

import { useCallback, useEffect, useRef, useState } from 'react';

import { checkHost } from '../api';
import { SavedDevice, orderAddresses } from './model';
import { raceAddresses } from './race';

export type Reachability = 'checking' | 'online' | 'offline';

/** Probe budget per computer. Shorter than a real connect — this is a hint. */
const LIST_PROBE_TIMEOUT_MS = 3000;

export interface ReachabilityMap {
  readonly byId: Readonly<Record<string, Reachability>>;
  readonly refresh: () => void;
}

/**
 * Track which of the saved computers are reachable.
 *
 * Probes run concurrently across computers, and are re-run on demand. Results
 * are keyed by id so a computer that is removed simply stops being rendered
 * rather than needing its entry cleaned up.
 */
export function useReachability(devices: readonly SavedDevice[]): ReachabilityMap {
  const [byId, setById] = useState<Readonly<Record<string, Reachability>>>({});
  const [nonce, setNonce] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (devices.length === 0) { setById({}); return; }

    let live = true;
    setById((prev) => {
      const next: Record<string, Reachability> = {};
      // Keep a previous verdict visible while re-checking, so the list does not
      // flash from green to grey on every refresh.
      for (const d of devices) next[d.id] = prev[d.id] ?? 'checking';
      return next;
    });

    const probes = devices.map(async (device) => {
      const winner = await raceAddresses(
        orderAddresses(device.addresses, device.lastKnownGoodUrl),
        async (url, signal) => {
          const health = await checkHost(url, signal);
          return { ok: health.ok, hostId: health.id };
        },
        { timeoutMs: LIST_PROBE_TIMEOUT_MS },
      );
      if (!live || !mountedRef.current) return;
      setById((prev) => ({ ...prev, [device.id]: winner ? 'online' : 'offline' }));
    });

    void Promise.all(probes);
    return () => { live = false; };
    // Re-probing is keyed on identity and address set, not object identity, so
    // an unrelated store write (a lastSeen bump) does not restart every probe.
  }, [devicesKey(devices), nonce]);

  return { byId, refresh };
}

/** Stable key describing which computers exist and at what addresses. */
function devicesKey(devices: readonly SavedDevice[]): string {
  return devices.map((d) => `${d.id}:${d.addresses.map((a) => a.url).join(',')}`).join('|');
}
