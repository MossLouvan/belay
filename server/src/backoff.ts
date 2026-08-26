// Restart pacing for supervised subprocesses.
//
// Two failure shapes need different treatment and a single fixed delay handles
// neither well. A helper that dies once because a display was reconfigured
// should come back immediately — the user is looking at a black screen. A
// helper that dies instantly on every launch, because a permission was revoked
// or the binary is broken, must not be respawned in a tight loop.
//
// Exponential backoff with a ceiling covers both: the first retry is instant,
// and a persistently broken helper settles to one attempt every few seconds
// rather than thousands.

export interface BackoffPolicy {
  /** Delay before the first retry. */
  readonly initialMs: number;
  /** Longest delay between retries. */
  readonly maxMs: number;
  /** Multiplier applied per consecutive failure. */
  readonly factor: number;
  /**
   * How long a process must stay alive before it counts as healthy.
   *
   * Without this, a helper that runs for an hour and then dies would be treated
   * as the tenth consecutive failure and made to wait the maximum delay.
   */
  readonly healthyAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 10_000,
  factor: 2,
  healthyAfterMs: 30_000,
};

/**
 * Delay before attempt number `failures` (1 = the first retry).
 *
 * Returns 0 for a non-positive count so the caller can use the same function
 * for "restart now" without a special case.
 */
export function backoffDelay(failures: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  if (failures <= 0) return 0;
  const raw = policy.initialMs * policy.factor ** (failures - 1);
  return Math.min(policy.maxMs, Math.round(raw));
}

/**
 * Whether a process that ran for `uptimeMs` should reset the failure count.
 *
 * A run that lasted long enough to be useful is evidence the helper works, so
 * the next unrelated crash starts over at a fast retry.
 */
export function isHealthyRun(uptimeMs: number, policy: BackoffPolicy = DEFAULT_BACKOFF): boolean {
  return uptimeMs >= policy.healthyAfterMs;
}
