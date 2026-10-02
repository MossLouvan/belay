// POST /claims (host), POST /claims/:code/accept (phone), GET /claims/:code (host polls)
//
// A claim proves possession of the node key: the host signs
// `belay-claim:v1:<nodeId>:<ts>` with its Ed25519 secret key. The host
// credential is minted when the host first polls a claimed code, so the
// plaintext never sits in D1 waiting to be picked up.

import { deviceJson, requireSession, type DeviceRow } from '../auth.js';
import { CLAIM_CODE_RE, claimCode, fromBase64url, fromHex, newId, randomCredential, sha256Hex, verifyEd25519 } from '../crypto.js';
import { CLAIM_SIG_SKEW_S, CLAIM_TTL_MS, type Env } from '../env.js';
import { HttpError, NODE_ID_RE, clientIp, json, maskEmail, notFound, readJson, requireInteger, requireString, unauthorized } from '../http.js';
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

export const claimMessage = (nodeId: string, ts: number): string => `belay-claim:v1:${nodeId}:${ts}`;

const normalizeCode = (code: string): string => {
  const upper = code.toUpperCase();
  if (!CLAIM_CODE_RE.test(upper)) throw notFound('claim not found');
  return upper;
};

async function requireProofOfPossession(body: Record<string, unknown>, nodeId: string): Promise<void> {
  const ts = requireInteger(body, 'ts');
  const sig = requireString(body, 'sig', 128, /^[A-Za-z0-9_-]{86}$/);
  if (Math.abs(Date.now() / 1000 - ts) > CLAIM_SIG_SKEW_S) throw unauthorized('ts outside the allowed window');
  if (!(await verifyEd25519(fromHex(nodeId), claimMessage(nodeId, ts), fromBase64url(sig)))) throw unauthorized('bad node signature');
}

export async function createClaim(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const nodeId = requireString(body, 'nodeId', 64, NODE_ID_RE);
  const name = requireString(body, 'name', 100);
  const platform = requireString(body, 'platform', 32);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  await requireProofOfPossession(body, nodeId);

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

/** Unknown, expired and already-taken codes all look the same to the caller. */
export async function acceptClaim(req: Request, env: Env, rawCode: string): Promise<Response> {
  const account = await requireSession(req, env.DB);
  await enforceLimit(env.DB, `ip:${clientIp(req)}`, LIMITS.ip);
  await enforceLimit(env.DB, `claim-accept:${account.id}`, LIMITS.claimAccept);
  const code = normalizeCode(rawCode);
  const now = Date.now();
  const claim = await env.DB.prepare('SELECT * FROM claims WHERE code = ?1 AND expires_at > ?2 AND device_id IS NULL').bind(code, now).first<ClaimRow>();
  if (!claim) throw notFound('claim not found');

  const existing = await env.DB.prepare('SELECT id, host_credential_hash FROM devices WHERE account_id = ?1 AND node_id = ?2')
    .bind(account.id, claim.node_id)
    .first<{ id: string; host_credential_hash: string | null }>();
  if (existing?.host_credential_hash) {
    throw new HttpError(409, 'device_exists', `this computer is already linked as device ${existing.id}; remove it first`);
  }

  // One atomic batch: insert the device, take the claim (guarded against a
  // concurrent accept), and drop the device again if the claim was not ours.
  // claims.device_id has a FK, so the device must exist before the update.
  const deviceId = newId();
  const results = await env.DB.batch([
    ...(existing ? [env.DB.prepare('DELETE FROM devices WHERE id = ?1').bind(existing.id)] : []),
    env.DB
      .prepare(
        `INSERT INTO devices (id, account_id, kind, name, platform, node_id, last_seen_at, created_at)
         VALUES (?1, ?2, 'host', ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(deviceId, account.id, claim.name, claim.platform, claim.node_id, now),
    env.DB.prepare('UPDATE claims SET device_id = ?1 WHERE code = ?2 AND device_id IS NULL').bind(deviceId, code),
    env.DB.prepare('DELETE FROM devices WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM claims WHERE device_id = ?1)').bind(deviceId),
    env.DB.prepare('SELECT * FROM devices WHERE id = ?1').bind(deviceId),
  ]);
  const device = results[results.length - 1].results[0] as DeviceRow | undefined;
  if (!device) throw notFound('claim not found');
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

  const owner = await env.DB.prepare('SELECT a.email FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?1')
    .bind(claim.device_id)
    .first<{ email: string | null }>();
  const claimedBy = maskEmail(owner?.email ?? null);

  // First poll after acceptance mints the credential; later polls just say 'claimed'.
  const hostCredential = randomCredential();
  const { meta } = await env.DB.prepare('UPDATE devices SET host_credential_hash = ?1 WHERE id = ?2 AND host_credential_hash IS NULL')
    .bind(await sha256Hex(hostCredential), claim.device_id)
    .run();
  return json(meta.changes === 1 ? { status: 'claimed', claimedBy, hostCredential } : { status: 'claimed', claimedBy });
}
