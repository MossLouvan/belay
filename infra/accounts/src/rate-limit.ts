// Fixed-window counter in D1, one upsert per check. Shared across all Worker
// isolates, which is why it is not in-memory like the rendezvous limiter.
// ponytail: fixed window allows 2x burst at the boundary; move to Workers Rate
// Limiting binding or a sliding window if that ever matters.

import { HttpError } from './http.js';

const UPSERT = `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
    window_start = excluded.window_start
  RETURNING count`;

export interface Limit {
  readonly max: number;
  readonly windowMs: number;
}

export const LIMITS = {
  ip: { max: 60, windowMs: 60_000 },
  emailStart: { max: 5, windowMs: 10 * 60_000 },
  emailVerify: { max: 10, windowMs: 10 * 60_000 },
  claimAccept: { max: 10, windowMs: 10 * 60_000 },
} as const satisfies Record<string, Limit>;

/** Throws 429 when `key` exceeds `limit.max` hits in the current window. */
export async function enforceLimit(db: D1Database, key: string, limit: Limit, now = Date.now()): Promise<void> {
  const windowStart = now - (now % limit.windowMs);
  const count = await db.prepare(UPSERT).bind(key, windowStart).first<number>('count');
  if (count === null || count > limit.max) {
    throw new HttpError(429, 'rate_limited', 'too many requests, try again later');
  }
}
