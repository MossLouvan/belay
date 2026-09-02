// The delay schedule for auto-reconnect ("Keep trying") on the computer list.
//
// When the active computer is unreachable, Belay can keep re-attempting the
// connection on its own and land the moment the machine wakes, instead of the
// user tapping "Try again" four times and giving up (docs/FRONTEND-REVAMP.md
// §4.4 / §5 #6). The System tab already backs its stats polling off the same
// way; this is that shape, isolated as a pure function so `node --test` can
// pin the curve without a bundler.

/** First wait between attempts. Short — a machine often wakes within seconds. */
export const RECONNECT_BASE_MS = 2000;
/** Ceiling, so a long-asleep machine is still retried at a sane cadence. */
export const RECONNECT_MAX_MS = 30000;

/**
 * How long to wait before reconnect attempt number `attempt` (0-based).
 *
 * Exponential from the base, capped: 2s, 4s, 8s, 16s, then 30s forever. A
 * negative or fractional input is clamped rather than trusted, since it comes
 * from a render counter.
 */
export function reconnectDelay(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_MAX_MS);
}
