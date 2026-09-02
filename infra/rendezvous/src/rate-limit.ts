// Token-bucket rate limiting, keyed by whatever the caller wants to throttle
// (remote IP, mailboxId). Pure logic over an injected clock so the tests can
// walk time; the server binds it to real connections.
//
// The rendezvous has no accounts and no passwords, so rate limiting is its
// entire anti-abuse surface for the free operations: announcing leases,
// opening mailboxes, requesting TURN credentials. The buckets are per-instance
// and in-memory — consistent with the stateless design, and honest about what
// that buys: a distributed attacker gets `instances × capacity`, which the
// caps are sized to tolerate (see docs/SCALABILITY.md).

export interface RateLimiterOptions {
  /** Bucket capacity: the burst a key may spend instantly. */
  readonly capacity: number;
  /** Sustained refill, tokens per second. */
  readonly refillPerSec: number;
  /** Max distinct keys tracked; beyond it, unknown keys are REFUSED (fail
   *  closed) — an attacker who fills the table must not turn the limiter off. */
  readonly maxKeys?: number;
}

export interface RateLimiter {
  /** Spend one token for `key`. True = allowed. */
  take(key: string): boolean;
  /** Tracked key count (after pruning full buckets). */
  size(): number;
}

const DEFAULT_MAX_KEYS = 200_000;

export function createRateLimiter(
  options: RateLimiterOptions,
  now: () => number = Date.now,
): RateLimiter {
  if (!(options.capacity > 0) || !(options.refillPerSec > 0)) {
    throw new Error('rate limiter needs positive capacity and refill');
  }
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, { tokens: number; updatedMs: number }>();
  let lastSweepMs = 0;

  const refill = (bucket: { tokens: number; updatedMs: number }, at: number): void => {
    const elapsedSec = Math.max(0, at - bucket.updatedMs) / 1000;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSec * options.refillPerSec);
    bucket.updatedMs = at;
  };

  const sweep = (at: number): void => {
    // A bucket back at full capacity carries no information; drop it.
    for (const [key, bucket] of buckets) {
      refill(bucket, at);
      if (bucket.tokens >= options.capacity) buckets.delete(key);
    }
    lastSweepMs = at;
  };

  return {
    take(key: string): boolean {
      const at = now();
      if (at - lastSweepMs >= 10_000) sweep(at);

      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          sweep(at);
          if (buckets.size >= maxKeys) return false; // fail closed
        }
        bucket = { tokens: options.capacity, updatedMs: at };
        buckets.set(key, bucket);
      }
      refill(bucket, at);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },

    size(): number {
      sweep(now());
      return buckets.size;
    },
  };
}
