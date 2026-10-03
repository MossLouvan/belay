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
  // Security alert emails (security-email.ts): a sign-in alert at most once
  // per 10 min per account, a phone-request alert once per 10 min per host,
  // and new-device alerts capped so a stolen session cannot flood the inbox.
  alertSignIn: { max: 1, windowMs: 10 * 60_000 },
  alertHostEvent: { max: 1, windowMs: 10 * 60_000 },
  alertDevice: { max: 5, windowMs: 10 * 60_000 },
} as const satisfies Record<string, Limit>;

/** Counts a hit on `key`; false once it exceeds `limit.max` in the current window. */
export async function withinLimit(db: D1Database, key: string, limit: Limit, now = Date.now()): Promise<boolean> {
  const windowStart = now - (now % limit.windowMs);
  const count = await db.prepare(UPSERT).bind(key, windowStart).first<number>('count');
  return count !== null && count <= limit.max;
}

/** Throws 429 when `key` exceeds `limit.max` hits in the current window. */
export async function enforceLimit(db: D1Database, key: string, limit: Limit, now = Date.now()): Promise<void> {
  if (!(await withinLimit(db, key, limit, now))) {
    throw new HttpError(429, 'rate_limited', 'too many requests, try again later');
  }
}
