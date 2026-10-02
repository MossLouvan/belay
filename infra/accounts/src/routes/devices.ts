// POST /devices, GET /devices, DELETE /devices/:id

import { deviceJson, requireSession, type DeviceRow } from '../auth.js';
import { newId } from '../crypto.js';
import type { Env } from '../env.js';
import { NODE_ID_RE, bad, json, noContent, notFound, optionalString, readJson, requireString } from '../http.js';

/** Registers (or re-registers, keyed by nodeId) this phone's tunnel identity. */
export async function createDevice(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  const body = await readJson(req);
  if (body.kind !== 'phone') throw bad("kind must be 'phone'");
  const name = requireString(body, 'name', 100);
  const nodeId = requireString(body, 'nodeId', 128, NODE_ID_RE);
  const platform = optionalString(body, 'platform', 32, 'unknown');
  const now = Date.now();

  const device = await env.DB.prepare(
    `INSERT INTO devices (id, account_id, kind, name, platform, node_id, last_seen_at, created_at)
     VALUES (?1, ?2, 'phone', ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(account_id, node_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at
     RETURNING *`,
  )
    .bind(newId(), account.id, name, platform, nodeId, now)
    .first<DeviceRow>();
  if (!device) throw new Error('device upsert returned nothing');
  return json({ device: deviceJson(device) });
}

export async function listDevices(req: Request, env: Env): Promise<Response> {
  const account = await requireSession(req, env.DB);
  const { results } = await env.DB.prepare('SELECT * FROM devices WHERE account_id = ?1 ORDER BY created_at').bind(account.id).all<DeviceRow>();
  return json({ devices: results.map(deviceJson) });
}

export async function deleteDevice(req: Request, env: Env, id: string): Promise<Response> {
  const account = await requireSession(req, env.DB);
  const { meta } = await env.DB.prepare('DELETE FROM devices WHERE id = ?1 AND account_id = ?2').bind(id, account.id).run();
  if (meta.changes === 0) throw notFound('device not found');
  return noContent();
}
