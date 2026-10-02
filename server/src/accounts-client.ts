// The accounts service, as the host sees it (openspec/changes/belay-network/design.md).
//
// Four calls: mint a claim, poll it, heartbeat, and link with a signed-in
// session (Belay.app's sign-in, used once). The interface exists so
// host-claim.ts can be tested against a scripted client; the fetch one is
// the only real implementation. Every response is shape-checked here, because
// a credential or a node id that is "probably a string" is how a typo in the
// service becomes a host that admits nobody — or everybody.

import { productEnv } from './env.js';

export const DEFAULT_ACCOUNTS_URL = 'https://api.gobelay.com/v1';

/** The string the host signs to prove it owns `nodeId` when minting a claim. */
export function claimMessage(nodeId: string, ts: number): string {
  return `belay-claim:v1:${nodeId}:${ts}`;
}

export interface ClaimRequest {
  readonly nodeId: string;
  readonly name: string;
  readonly platform: string;
  /** Unix seconds. */
  readonly ts: number;
  /** base64url Ed25519 signature over claimMessage(nodeId, ts) by the node key. */
  readonly sig: string;
}
export interface Claim { readonly claimCode: string; readonly hostSecret: string; readonly expiresAt: number }
export interface ClaimPoll {
  readonly status: 'pending' | 'claimed' | 'expired';
  /** Only on the FIRST claimed poll. Persist it before doing anything else. */
  readonly hostCredential?: string;
  readonly maskedEmail?: string;
}
/** POST /hosts/link: the credential is in this one answer only. Persist it first. */
export interface LinkResult { readonly hostCredential: string; readonly maskedEmail?: string }
export interface Heartbeat { readonly allowedNodeIds: readonly string[]; readonly relayUrls: readonly string[] }

export interface AccountsClient {
  createClaim(body: ClaimRequest): Promise<Claim>;
  pollClaim(code: string, hostSecret: string): Promise<ClaimPoll>;
  heartbeat(hostCredential: string): Promise<Heartbeat>;
  /** `session` is a user session held only for this call (never stored). */
  linkHost(session: string, body: ClaimRequest): Promise<LinkResult>;
}

/** A non-2xx answer. `status` is what the state machine keys on (401, 404). */
export class AccountsError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export function accountsUrl(): string {
  return (productEnv('ACCOUNTS_URL') || DEFAULT_ACCOUNTS_URL).replace(/\/+$/, '');
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`accounts: ${what} missing from response`);
  return v;
};
const strs = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`accounts: ${what} is not a string list`);
  return v as string[];
};

/** Parse an ISO date or epoch (seconds or ms) into epoch ms. */
export function expiresAtMs(v: unknown): number {
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  if (!Number.isFinite(n)) throw new Error('accounts: expiresAt unreadable');
  return n;
}

export function parseClaim(json: unknown): Claim {
  const o = (json ?? {}) as Record<string, unknown>;
  return { claimCode: str(o.claimCode, 'claimCode'), hostSecret: str(o.hostSecret, 'hostSecret'), expiresAt: expiresAtMs(o.expiresAt) };
}

export function parsePoll(json: unknown): ClaimPoll {
  const o = (json ?? {}) as Record<string, unknown>;
  const status = o.status;
  if (status !== 'pending' && status !== 'claimed' && status !== 'expired') throw new Error(`accounts: unknown claim status ${String(status)}`);
  return {
    status,
    ...(typeof o.hostCredential === 'string' && o.hostCredential ? { hostCredential: o.hostCredential } : {}),
    ...(typeof o.claimedBy === 'string' && o.claimedBy ? { maskedEmail: o.claimedBy } : {}),
  };
}

/** Credentials are 32 random bytes, base64url: anything else is not written to disk. */
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function parseLink(json: unknown): LinkResult {
  const o = (json ?? {}) as Record<string, unknown>;
  const hostCredential = o.hostCredential;
  if (typeof hostCredential !== 'string' || !CREDENTIAL_RE.test(hostCredential)) throw new Error('accounts: hostCredential missing from link response');
  return { hostCredential, ...(typeof o.linkedBy === 'string' && o.linkedBy ? { maskedEmail: o.linkedBy } : {}) };
}

/** An iroh node id as the sidecar prints it: 32 bytes, lowercase hex. */
const NODE_ID_RE = /^[0-9a-f]{64}$/;

export function parseHeartbeat(json: unknown): Heartbeat {
  const o = (json ?? {}) as Record<string, unknown>;
  const allowedNodeIds = strs(o.allowedNodeIds, 'allowedNodeIds');
  const bad = allowedNodeIds.find((id) => !NODE_ID_RE.test(id));
  // One malformed entry fails the whole answer rather than being skipped: a
  // list the service got wrong is not a list to admit anyone on.
  if (bad !== undefined) throw new Error(`accounts: allowedNodeIds entry is not a 64-hex node id: ${JSON.stringify(bad)}`);
  return { allowedNodeIds, relayUrls: strs(o.relayUrls ?? [], 'relayUrls') };
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body: reported below */ }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: unknown; code?: unknown };
    throw new AccountsError(res.status, typeof e.error === 'string' ? e.error : `HTTP ${res.status}`, typeof e.code === 'string' ? e.code : undefined);
  }
  return json;
}

export function fetchAccountsClient(baseUrl: string = accountsUrl()): AccountsClient {
  return {
    createClaim: async (body) => parseClaim(await call(`${baseUrl}/claims`, { method: 'POST', body: JSON.stringify(body) })),
    pollClaim: async (code, hostSecret) =>
      parsePoll(await call(`${baseUrl}/claims/${encodeURIComponent(code)}`, { method: 'GET', headers: { 'X-Host-Secret': hostSecret } })),
    heartbeat: async (hostCredential) =>
      parseHeartbeat(await call(`${baseUrl}/hosts/heartbeat`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${hostCredential}` } })),
    linkHost: async (session, body) =>
      parseLink(await call(`${baseUrl}/hosts/link`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${session}` } })),
  };
}
