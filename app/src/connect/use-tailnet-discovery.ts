// Is a remembered computer already answering over the tailnet?
//
// The connect screen's field is always there, but someone who has paired
// before should not have to retype anything: when a remembered tailnet
// address answers right now, it is offered above the field as a one-tap
// shortcut. The probe is one bounded request per remembered tailnet address,
// raced, so a computer that is asleep costs nothing but a short wait.

import { useEffect, useState } from 'react';
import { checkHost } from '../api';
import { raceAddresses } from '../devices/race';
import { isTailscaleAddress } from './host-input';

export interface DiscoveredTailnetHost {
  readonly name: string;
  readonly url: string;
}

/**
 * The first remembered tailnet address that answers, or null. Re-probes when
 * the remembered list changes; a probe still in flight when the list changes
 * is discarded rather than applied late.
 */
export function useTailnetDiscovery(
  recent: readonly string[],
  enabled: boolean,
): DiscoveredTailnetHost | null {
  const [found, setFound] = useState<DiscoveredTailnetHost | null>(null);
  const candidates = recent.filter(isTailscaleAddress);
  const key = candidates.join('\n');

  useEffect(() => {
    if (!enabled || candidates.length === 0) {
      setFound(null);
      return;
    }
    let live = true;
    // Filled by the probes as they answer; read once the race settles.
    const names = new Map<string, string>();
    raceAddresses(
      candidates.map((url) => ({ url })),
      async (url, signal) => {
        // The racer bounds each probe itself (PROBE_TIMEOUT_MS) and aborts
        // the losers, so a sleeping computer costs one short wait.
        const health = await checkHost(url, signal);
        if (health.ok && health.name) names.set(url, health.name);
        return { ok: health.ok, hostId: health.id };
      },
    ).then(
      (winner) => {
        if (!live) return;
        setFound(winner ? { url: winner.url, name: names.get(winner.url) ?? 'your computer' } : null);
      },
      () => {
        if (live) setFound(null);
      },
    );
    return () => {
      live = false;
    };
    // `key` stands in for the candidate list, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return found;
}
