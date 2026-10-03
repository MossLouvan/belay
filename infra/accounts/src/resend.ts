// The one Resend call (plain fetch): sign-in codes and security alerts.

import type { Env } from './env.js';

const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 5_000;

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** Caller checks RESEND_API_KEY and `res.ok`. */
export const postResend = (env: Env, mail: Mail): Promise<Response> =>
  fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, ...mail, to: [mail.to] }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
