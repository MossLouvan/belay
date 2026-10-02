// POST /claims (host), POST /claims/:code/accept (phone), GET /claims/:code (host polls)
//
// The host credential is minted when the host first polls a claimed code, so
// the plaintext never sits in D1 waiting to be picked up.

import { deviceJson, requireSession, type DeviceRow } from '../auth.js';
import { CLAIM_CODE_RE, claimCode, newId, randomCredential, sha256Hex } from '../crypto.js';
import { CLAIM_TTL_MS, type Env } from '../env.js';
import { HttpError, NODE_ID_RE, clientIp, json, notFound, readJson, requireString, unauthorized } from '../http.js';
import { LIMITS, enforceLimit } from '../rate-limit.js';

interface ClaimRow {
  readonly code: string;
  readonly host_secret_hash: string;
  readonly node_id: string;
  readonly name: string;
  readonly platform: string;
  readonly device_id: string | null;
  readonly expires_at: number;
}

const normalizeCode = (code: string): string => {
  const upper = code.toUpperCase();
  if (!CLAIM_CODE_RE.test(upper)) throw notFound('claim not found');
  return upper;
};

export async function createClaim(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const nodeId = requireString(body, 'nodeId', 128, NODE_ID_RE);
  const name = requireString(body, 'name', 100);
  const platform = requireString(body, 'platform', 32);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);

  const code = claimCode();
  const hostSecret = randomCredential();
  const now = Date.now();
  const expiresAt = now + CLAIM_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO claims (code, host_secret_hash, node_id, name, platform, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(code, await sha256Hex(hostSecret), nodeId, name, platform, now, expiresAt)
    .run();
  return json({ claimCode: code, hostSecret, expiresAt: new Date(expiresAt).toISOString() });
}

export async function acceptClaim(req: Request, env: Env, rawCode: string): Promise<Response> {
  const account = await requireSession(req, env.DB);
  const code = normalizeCode(rawCode);
  const claim = await env.DB.prepare('SELECT * FROM claims WHERE code = ?1').bind(code).first<ClaimRow>();
  if (!claim) throw notFound('claim not found');
  if (claim.expires_at <= Date.now()) throw new HttpError(410, 'claim_expired', 'claim code expired');
  if (claim.device_id) throw new HttpError(409, 'claim_taken', 'claim already accepted');

  const now = Date.now();
  const deviceId = newId();
  const [, , inserted] = await env.DB.batch([
    // A host re-claimed by the same account replaces its old registration.
    env.DB.prepare('DELETE FROM devices WHERE account_id = ?1 AND node_id = ?2').bind(account.id, claim.node_id),
    env.DB
      .prepare(
        `INSERT INTO devices (id, account_id, kind, name, platform, node_id, last_seen_at, created_at)
         VALUES (?1, ?2, 'host', ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(deviceId, account.id, claim.name, claim.platform, claim.node_id, now),
    env.DB.prepare('UPDATE claims SET device_id = ?1 WHERE code = ?2 AND device_id IS NULL RETURNING code').bind(deviceId, code),
  ]);
  if (inserted.results.length === 0) throw new HttpError(409, 'claim_taken', 'claim already accepted');
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?1').bind(deviceId).first<DeviceRow>();
  if (!device) throw new Error('device vanished after insert');
  return json({ device: deviceJson(device) });
}

export async function pollClaim(req: Request, env: Env, rawCode: string): Promise<Response> {
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  const secret = req.headers.get('x-host-secret');
  if (!secret) throw unauthorized('missing X-Host-Secret');
  const code = normalizeCode(rawCode);
  const claim = await env.DB.prepare('SELECT * FROM claims WHERE code = ?1').bind(code).first<ClaimRow>();
  if (!claim || claim.host_secret_hash !== (await sha256Hex(secret))) throw notFound('claim not found');

  if (claim.expires_at <= Date.now()) return json({ status: 'expired' });
  if (!claim.device_id) return json({ status: 'pending' });

  // First poll after acceptance mints the credential; later polls just say 'claimed'.
  const hostCredential = randomCredential();
  const { meta } = await env.DB.prepare('UPDATE devices SET host_credential_hash = ?1 WHERE id = ?2 AND host_credential_hash IS NULL')
    .bind(await sha256Hex(hostCredential), claim.device_id)
    .run();
  return json(meta.changes === 1 ? { status: 'claimed', hostCredential } : { status: 'claimed' });
}
