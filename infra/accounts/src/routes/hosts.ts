// POST /hosts/heartbeat (host credential)

import { requireHost } from '../auth.js';
import { splitList, type Env } from '../env.js';
import { json, readJson } from '../http.js';

export async function heartbeat(req: Request, env: Env): Promise<Response> {
  const host = await requireHost(req, env.DB);
  await readJson(req); // body is `{}` today; still must be a JSON object
  const [, phones] = await env.DB.batch<{ node_id: string }>([
    env.DB.prepare('UPDATE devices SET last_seen_at = ?1 WHERE id = ?2').bind(Date.now(), host.id),
    env.DB.prepare("SELECT node_id FROM devices WHERE account_id = ?1 AND kind = 'phone'").bind(host.account_id),
  ]);
  return json({ allowedNodeIds: phones.results.map((r) => r.node_id), relayUrls: splitList(env.RELAY_URLS) });
}
