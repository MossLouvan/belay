// Accounts, sessions and host credentials.

import { newId, randomCredential, sha256Hex } from './crypto.js';
import { SESSION_MAX_LIFETIME_MS, SESSION_REFRESH_AFTER_MS, SESSION_TTL_MS } from './env.js';
import { bearer, unauthorized } from './http.js';

export interface AccountRow {
  readonly id: string;
  readonly email: string | null;
  readonly created_at: number;
  /** 1 = send security alert emails (default), 0 = opted out. */
  readonly security_emails: number;
}

export interface DeviceRow {
  readonly id: string;
  readonly account_id: string;
  readonly kind: 'phone' | 'host';
  readonly name: string;
  readonly platform: string;
  readonly node_id: string;
  readonly last_seen_at: number;
  readonly created_at: number;
}

export const accountJson = (a: AccountRow) => ({
  id: a.id,
  email: a.email,
  createdAt: new Date(a.created_at).toISOString(),
  securityEmails: a.security_emails !== 0,
});

export const deviceJson = (d: DeviceRow) => ({
  id: d.id,
  kind: d.kind,
  name: d.name,
  platform: d.platform,
  nodeId: d.node_id,
  lastSeenAt: new Date(d.last_seen_at).toISOString(),
});

export async function createSession(db: D1Database, accountId: string, now = Date.now()): Promise<string> {
  const token = randomCredential();
  await db
    .prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(token), accountId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/** Resolves the bearer session to an account, sliding the expiry forward. */
export async function requireSession(req: Request, db: D1Database, now = Date.now()): Promise<AccountRow> {
  const token = bearer(req);
  if (!token) throw unauthorized('missing session');
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT a.id, a.email, a.created_at, a.security_emails, s.expires_at, s.created_at AS session_created_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.hash = ?1 AND s.expires_at > ?2 AND s.created_at > ?3`,
    )
    .bind(hash, now, now - SESSION_MAX_LIFETIME_MS)
    .first<AccountRow & { expires_at: number; session_created_at: number }>();
  if (!row) throw unauthorized('invalid or expired session');

  // Sliding expiry, capped at the absolute lifetime.
  const slid = Math.min(now + SESSION_TTL_MS, row.session_created_at + SESSION_MAX_LIFETIME_MS);
  if (row.expires_at < slid - SESSION_REFRESH_AFTER_MS) {
    await db.prepare('UPDATE sessions SET expires_at = ?1 WHERE hash = ?2').bind(slid, hash).run();
  }
  return { id: row.id, email: row.email, created_at: row.created_at, security_emails: row.security_emails };
}

export async function deleteSession(req: Request, db: D1Database): Promise<void> {
  const token = bearer(req);
  if (!token) throw unauthorized('missing session');
  const { meta } = await db.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha256Hex(token)).run();
  if (meta.changes === 0) throw unauthorized('invalid or expired session');
}

/** Signs the account out everywhere: every session, including the caller's. */
export async function deleteAllSessions(db: D1Database, accountId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(accountId).run();
}

/** Resolves the bearer host credential to a host device. */
export async function requireHost(req: Request, db: D1Database): Promise<DeviceRow> {
  const token = bearer(req);
  if (!token) throw unauthorized('missing host credential');
  const row = await db
    .prepare('SELECT * FROM devices WHERE host_credential_hash = ?1 AND kind = ?2')
    .bind(await sha256Hex(token), 'host')
    .first<DeviceRow>();
  if (!row) throw unauthorized('invalid host credential');
  return row;
}

/**
 * Finds the account for (provider, subject); links by verified email when the
 * identity is new but the email already has an account; otherwise creates one.
 */
export async function findOrCreateAccount(
  db: D1Database,
  provider: 'email' | 'apple' | 'google',
  subject: string,
  email: string | null,
  now = Date.now(),
): Promise<AccountRow> {
  const byIdentity = await db
    .prepare('SELECT a.* FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.provider = ?1 AND i.subject = ?2')
    .bind(provider, subject)
    .first<AccountRow>();
  if (byIdentity) return byIdentity;

  const byEmail = email ? await db.prepare('SELECT * FROM accounts WHERE email = ?1').bind(email).first<AccountRow>() : null;
  const account: AccountRow = byEmail ?? { id: newId(), email, created_at: now, security_emails: 1 };

  const statements = [
    ...(byEmail ? [] : [db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)').bind(account.id, email, now)]),
    db.prepare('INSERT INTO identities (provider, subject, account_id, created_at) VALUES (?1, ?2, ?3, ?4)').bind(provider, subject, account.id, now),
  ];
  await db.batch(statements);
  return account;
}
