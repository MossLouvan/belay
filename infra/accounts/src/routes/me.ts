// GET /me, PATCH /me, DELETE /me, POST /me/sessions/revoke-all

import { accountJson, deleteAllSessions, deleteSession, requireSession } from '../auth.js';
import type { Env } from '../env.js';
import { bad, json, noContent, readJson } from '../http.js';
import { sendSecurityEmail } from '../security-email.js';

export async function getMe(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  return json({ account: accountJson(account) });
}

/** `{securityEmails: boolean}`, the only setting today. */
export async function patchMe(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  const { securityEmails } = await readJson(req);
  if (typeof securityEmails !== 'boolean') throw bad('securityEmails must be a boolean');
  const flag = securityEmails ? 1 : 0;
  // Announced while still on, so a stolen session cannot switch alerts off silently.
  if (flag === 0 && account.security_emails !== 0) await sendSecurityEmail(env, req, account, { kind: 'alerts-off' });
  await env.DB.prepare('UPDATE accounts SET security_emails = ?1 WHERE id = ?2').bind(flag, account.id).run();
  return json({ account: accountJson({ ...account, security_emails: flag }) });
}

/** Sign out everywhere: every session of the account, this one included. Linked computers stay linked. */
export async function revokeAllSessions(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  await deleteAllSessions(env.DB, account.id);
  return noContent();
}

/** POST /auth/logout: deletes this session only. */
export async function logout(req: Request, env: Env): Promise<Response> {
  await deleteSession(req, env.DB);
  return noContent();
}

/** Cascades to identities, sessions, devices and claims via FK constraints. */
export async function deleteMe(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(account.id).run();
  return noContent();
}
