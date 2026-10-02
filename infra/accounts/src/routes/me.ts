// GET /me, DELETE /me

import { accountJson, requireSession } from '../auth.js';
import type { Env } from '../env.js';
import { json, noContent } from '../http.js';

export async function getMe(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  return json({ account: accountJson(account) });
}

/** Cascades to identities, sessions, devices and claims via FK constraints. */
export async function deleteMe(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(account.id).run();
  return noContent();
}
