export interface Env {
  DB: D1Database;
  APPLE_AUDIENCE: string;
  GOOGLE_AUDIENCES: string;
  EMAIL_FROM: string;
  RELAY_URLS?: string;
  // secrets
  RESEND_API_KEY?: string;
  REVIEW_EMAIL?: string;
  REVIEW_CODE?: string;
}

export const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
export const SESSION_TTL_MS = 90 * MS.day;
export const SESSION_MAX_LIFETIME_MS = 365 * MS.day;
export const SESSION_REFRESH_AFTER_MS = MS.day;
export const EMAIL_CODE_TTL_MS = 10 * MS.minute;
export const EMAIL_CODE_REUSE_MS = 2 * MS.minute;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const CLAIM_TTL_MS = 10 * MS.minute;
export const CLAIM_SIG_SKEW_S = 300;
export const NONCE_TTL_MS = 5 * MS.minute;
