// POST /auth/email/start, POST /auth/email/verify

import { createSession, findOrCreateAccount, accountJson } from '../auth.js';
import { emailCode, sha256Hex } from '../crypto.js';
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_REUSE_MS, EMAIL_CODE_TTL_MS, type Env } from '../env.js';
import { HttpError, clientIp, json, noContent, readJson, requireEmail, requireString } from '../http.js';
import { LIMITS, enforceLimit } from '../rate-limit.js';
import { postResend } from '../resend.js';
import { sendSecurityEmail } from '../security-email.js';

const codeHash = (email: string, code: string): Promise<string> => sha256Hex(`${email}:${code}`);

const isReviewer = (env: Env, email: string): boolean =>
  Boolean(env.REVIEW_EMAIL && env.REVIEW_CODE && env.REVIEW_EMAIL.toLowerCase() === email);

async function sendCode(env: Env, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new HttpError(500, 'misconfigured', 'RESEND_API_KEY is not set');
  const res = await postResend(env, {
    to: email,
    subject: `${code} is your Belay sign-in code`,
    text: `Your Belay sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
  });
  if (!res.ok) {
    console.error('resend failed', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'email_send_failed', 'could not send the sign-in email');
  }
}

export async function emailStart(req: Request, env: Env): Promise<Response> {
  const email = requireEmail(await readJson(req));
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  await enforceLimit(env.DB, `email-start:${email}`, LIMITS.emailStart);

  if (isReviewer(env, email)) return noContent(); // fixed REVIEW_CODE, nothing to send

  // A code younger than EMAIL_CODE_REUSE_MS stays valid: a stranger cannot
  // invalidate the one the real user is about to type.
  const now = Date.now();
  const code = emailCode();
  const { meta } = await env.DB.prepare(
    `INSERT INTO email_codes (email, code_hash, attempts, created_at, expires_at) VALUES (?1, ?2, 0, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at
     WHERE created_at < ?5`,
  )
    .bind(email, await codeHash(email, code), now, now + EMAIL_CODE_TTL_MS, now - EMAIL_CODE_REUSE_MS)
    .run();
  if (meta.changes === 1) await sendCode(env, email, code);
  return noContent();
}

async function checkCode(env: Env, email: string, code: string): Promise<void> {
  if (isReviewer(env, email)) {
    if (code === env.REVIEW_CODE) return;
    throw new HttpError(401, 'invalid_code', 'wrong code');
  }
  const row = await env.DB.prepare('SELECT code_hash, attempts, expires_at FROM email_codes WHERE email = ?1')
    .bind(email)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) throw new HttpError(401, 'code_expired', 'code expired, request a new one');
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) throw new HttpError(401, 'too_many_attempts', 'too many attempts, request a new code');

  if (row.code_hash !== (await codeHash(email, code))) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?1').bind(email).run();
    throw new HttpError(401, 'invalid_code', 'wrong code');
  }
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ?1').bind(email).run();
}

export async function emailVerify(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const email = requireEmail(body);
  const code = requireString(body, 'code', 6, /^\d{6}$/);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  await enforceLimit(env.DB, `email-verify:${email}:${clientIp(req)}`, LIMITS.emailVerify);

  await checkCode(env, email, code);
  const account = await findOrCreateAccount(env.DB, 'email', email, email);
  const session = await createSession(env.DB, account.id);
  await sendSecurityEmail(env, req, account, { kind: 'sign-in', method: 'email' });
  return json({ session, account: accountJson(account) });
}
