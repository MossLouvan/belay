// Belay accounts service: router + Worker entry.

import type { Env } from './env.js';
import { HttpError, errorResponse, json } from './http.js';
import { acceptClaim, createClaim, pollClaim } from './routes/claims.js';
import { createDevice, deleteDevice, listDevices } from './routes/devices.js';
import { emailStart, emailVerify } from './routes/email.js';
import { heartbeat } from './routes/hosts.js';
import { deleteMe, getMe } from './routes/me.js';
import { appleAuth, googleAuth } from './routes/oidc.js';

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;

const routes: ReadonlyArray<readonly [method: string, pattern: RegExp, handler: Handler]> = [
  ['POST', /^\/v1\/auth\/email\/start$/, emailStart],
  ['POST', /^\/v1\/auth\/email\/verify$/, emailVerify],
  ['POST', /^\/v1\/auth\/apple$/, appleAuth],
  ['POST', /^\/v1\/auth\/google$/, googleAuth],
  ['GET', /^\/v1\/me$/, getMe],
  ['DELETE', /^\/v1\/me$/, deleteMe],
  ['POST', /^\/v1\/devices$/, createDevice],
  ['GET', /^\/v1\/devices$/, listDevices],
  ['DELETE', /^\/v1\/devices\/([^/]+)$/, deleteDevice],
  ['POST', /^\/v1\/claims$/, createClaim],
  ['POST', /^\/v1\/claims\/([^/]+)\/accept$/, acceptClaim],
  ['GET', /^\/v1\/claims\/([^/]+)$/, pollClaim],
  ['POST', /^\/v1\/hosts\/heartbeat$/, heartbeat],
];

export async function handle(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  try {
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(path);
      if (match && req.method === method) return await handler(req, env, ...match.slice(1).map(decodeURIComponent));
    }
    return json({ error: 'not found', code: 'not_found' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    console.error('unhandled', req.method, path, err);
    return json({ error: 'internal error', code: 'internal' }, 500);
  }
}

const HOUSEKEEPING = [
  'DELETE FROM claims WHERE expires_at < ?1',
  'DELETE FROM email_codes WHERE expires_at < ?1',
  'DELETE FROM rate_limits WHERE window_start < ?1',
  'DELETE FROM sessions WHERE expires_at < ?1',
];

export default {
  fetch: handle,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = Date.now() - 3_600_000;
    await env.DB.batch(HOUSEKEEPING.map((sql) => env.DB.prepare(sql).bind(cutoff)));
  },
} satisfies ExportedHandler<Env>;
