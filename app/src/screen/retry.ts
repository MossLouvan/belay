// Pure decisions behind the reconnect panel's copy and the probe-gated retry
// (backlog item `retry-honesty`).
//
// The old panel said "RETRYING IN 4S · ATTEMPT 86" — an app admitting it has
// blind-retried for ten minutes. The honest fact is how long the outage has
// lasted, so the copy speaks in elapsed time; and rather than waiting out a
// 15s backoff tick, the stream probes the host's cheap `/health` while it
// waits and reconnects the instant the host answers. Both decisions are pure
// and live here so the node test runner can hold them to their word.

/** For this long after a drop, the panel just says "Reconnecting…". */
export const FRESH_OUTAGE_MS = 10_000;

/** Cadence of the `/health` probe while a long backoff wait is pending. */
export const PROBE_INTERVAL_MS = 2_000;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * What the reconnect panel says, given the current time and when the outage
 * began. A fresh drop reads as an ordinary "Reconnecting…" — most blips heal
 * in seconds and deserve no drama — and only a persistent one owns up to its
 * age: "Still trying · 42s", "· 9m", "· 1h 12m". Never an attempt counter.
 */
export function retryPhrase(nowMs: number, sinceMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs);
  if (elapsed < FRESH_OUTAGE_MS) return 'Reconnecting…';
  if (elapsed < MINUTE_MS) return `Still trying · ${Math.floor(elapsed / SECOND_MS)}s`;
  if (elapsed < HOUR_MS) return `Still trying · ${Math.floor(elapsed / MINUTE_MS)}m`;
  const hours = Math.floor(elapsed / HOUR_MS);
  const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `Still trying · ${hours}h` : `Still trying · ${hours}h ${minutes}m`;
}

/**
 * Whether a pending backoff wait of `delayMs` is worth shadowing with a
 * `/health` probe. A probe can only beat the retry timer when the timer is
 * further away than one probe cycle; for short waits the retry itself is the
 * probe. Anything non-finite or negative is a bug upstream — never probe on it.
 */
export function shouldProbeDuringBackoff(delayMs: number): boolean {
  return Number.isFinite(delayMs) && delayMs > PROBE_INTERVAL_MS;
}
