// POST /hosts/heartbeat (host credential), POST /hosts/link (session)

import { deviceJson, requireHost, requireSession, type DeviceRow } from '../auth.js';
import { newId, randomCredential, sha256Hex } from '../crypto.js';
import { splitList, type Env } from '../env.js';
import { HttpError, NODE_ID_RE, clientIp, json, maskEmail, readJson, requireString } from '../http.js';
import { LIMITS, enforceLimit } from '../rate-limit.js';
import { requireProofOfPossession } from './claims.js';

export async function heartbeat(req: Request, env: Env): Promise<Response> {
  const host = await requireHost(req, env.DB);
  await readJson(req); // body is `{}` today; still must be a JSON object
  const [, phones] = await env.DB.batch<{ node_id: string; platform: string; created_at: number }>([
    env.DB.prepare('UPDATE devices SET last_seen_at = ?1 WHERE id = ?2').bind(Date.now(), host.id),
    env.DB.prepare("SELECT node_id, platform, created_at FROM devices WHERE account_id = ?1 AND kind = 'phone'").bind(host.account_id),
  ]);
  return json({
    allowedNodeIds: phones.results.map((r) => r.node_id),
    relayUrls: splitList(env.RELAY_URLS),
    // For the host's "Allow this phone?" prompt: platform and when it joined.
    phones: phones.results.map((r) => ({ nodeId: r.node_id, platform: r.platform, createdAt: r.created_at })),
  });
}

const deviceExists = (id: string): HttpError =>
  new HttpError(409, 'device_exists', `this computer is already linked as device ${id}; remove it first`);

/**
 * A computer signed in to the account links itself: same proof of node-key
 * possession as POST /claims, same 409 rule as claim accept, and the host
 * credential is minted in the response (shown once, only its hash is stored).
 */
export async function linkHost(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  await enforceLimit(env.DB, `host-link:${account.id}`, LIMITS.claimAccept);
  const body = await readJson(req);
  const nodeId = requireString(body, 'nodeId', 64, NODE_ID_RE);
  const name = requireString(body, 'name', 100);
  const platform = requireString(body, 'platform', 32);
  await requireProofOfPossession(body, nodeId);

  const live = await env.DB.prepare('SELECT id FROM devices WHERE account_id = ?1 AND node_id = ?2 AND host_credential_hash IS NOT NULL')
    .bind(account.id, nodeId)
    .first<{ id: string }>();
  if (live) throw deviceExists(live.id);

  // Drop a half-linked row (claim accepted, never polled), then insert; the
  // UNIQUE(account_id, node_id) makes a concurrent link lose with no row.
  const hostCredential = randomCredential();
  const now = Date.now();
  const [, inserted] = await env.DB.batch<DeviceRow>([
    env.DB.prepare('DELETE FROM devices WHERE account_id = ?1 AND node_id = ?2 AND host_credential_hash IS NULL').bind(account.id, nodeId),
    env.DB
      .prepare(
        `INSERT INTO devices (id, account_id, kind, name, platform, node_id, host_credential_hash, last_seen_at, created_at)
         VALUES (?1, ?2, 'host', ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(account_id, node_id) DO NOTHING
         RETURNING *`,
      )
      .bind(newId(), account.id, name, platform, nodeId, await sha256Hex(hostCredential), now),
  ]);
  const device = inserted.results[0];
  if (!device) {
    const winner = await env.DB.prepare('SELECT id FROM devices WHERE account_id = ?1 AND node_id = ?2').bind(account.id, nodeId).first<{ id: string }>();
    throw deviceExists(winner?.id ?? 'unknown');
  }
  return json({ device: deviceJson(device), hostCredential, linkedBy: maskEmail(account.email) });
}
