// Linking this computer to a Belay account, and staying linked.
//
// Unlinked: mint a claim, show its QR, poll until a signed-in phone scans it
// — or Belay.app signs in on this computer and hands linkWithSession() a
// session for one POST /hosts/link; the loop notices the credential it wrote.
// Linked: heartbeat every minute; the answer is the allow-list the tunnel
// sidecar admits (tunnel.ts) and the relays to use. Two things are easy to
// get wrong and are therefore pinned down as pure functions with tests:
//
//  * The host credential is handed out by exactly ONE poll — the first
//    "claimed" answer. It is written to disk (0600) before any other call is
//    made; a crash between the two would otherwise orphan the link forever.
//  * A 401 heartbeat means the credential is dead (account deleted, host
//    removed): drop it and show a new QR. Any other failure (offline, 5xx)
//    keeps the credential; the cached allow-list keeps the tunnel working.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AccountsClient, AccountsError, ClaimPoll, claimMessage } from './accounts-client.js';
import type { PhoneInfo } from './accounts-client.js';

export type LinkState =
  | { readonly kind: 'unlinked' }
  | { readonly kind: 'claiming'; readonly code: string; readonly hostSecret: string; readonly expiresAt: number }
  | { readonly kind: 'linked'; readonly hostCredential: string };

const UNLINKED: LinkState = { kind: 'unlinked' };

export const CLAIM_POLL_MS = 2_000;
export const HEARTBEAT_MS = 60_000;
/** After a failed accounts call (offline, 5xx): neither a hot loop nor a long outage. */
export const RETRY_MS = 15_000;
/**
 * How long a cached allow-list may be replayed after a restart without the
 * service confirming it. Past this the tunnel admits nobody until a
 * heartbeat answers: a host cut off from the accounts service for three days
 * loses tunnel access, but a revoked phone can never ride a stale cache longer.
 */
export const ALLOW_CACHE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** What the phone scans. */
export function claimLink(code: string, nodeId: string): string {
  return `belay://claim?c=${encodeURIComponent(code)}&n=${encodeURIComponent(nodeId)}`;
}

export function onPoll(state: LinkState, poll: ClaimPoll, nowMs: number): LinkState {
  if (state.kind !== 'claiming') return state;
  if (poll.status === 'claimed') {
    return poll.hostCredential ? { kind: 'linked', hostCredential: poll.hostCredential } : UNLINKED;
  }
  if (poll.status === 'expired' || nowMs >= state.expiresAt) return UNLINKED;
  return state;
}

export function onHeartbeatFailure(state: LinkState, error: unknown): LinkState {
  return error instanceof AccountsError && error.status === 401 ? UNLINKED : state;
}

export interface AllowCache { readonly allowedNodeIds: readonly string[]; readonly relayUrls: readonly string[]; readonly at: number }

export interface LinkStore {
  readCredential(): string | null;
  writeCredential(credential: string): void;
  clearCredential(): void;
  readCache(): AllowCache | null;
  writeCache(cache: AllowCache): void;
}

export interface LinkShow {
  qr(link: string): void;
  line(text: string): void;
  popup(title: string, body: string): void;
  /** Linked: Belay.app swaps the claim QR for the pairing code. */
  linked?(): void;
}

export interface HostLinkDeps {
  readonly client: AccountsClient;
  readonly store: LinkStore;
  readonly show: LinkShow;
  readonly nodeId: string;
  readonly name: string;
  readonly platform: string;
  /** base64url Ed25519 signature by the node key — the sidecar's `sign`. */
  readonly sign: (message: string) => Promise<string>;
  readonly onAllowList: (allowedNodeIds: readonly string[], relayUrls: readonly string[]) => void;
  /** Display metadata for the account's phones, from each heartbeat. */
  readonly onPhones?: (phones: readonly PhoneInfo[]) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs until `signal` aborts. Every accounts failure is logged and retried; nothing throws out. */
export async function runHostLink(deps: HostLinkDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const cred = deps.store.readCredential();
  // Only a linked host replays its cache, and only a recent one: an unlinked
  // host admits nobody, and a stale list could carry a revoked phone forever.
  const cached = cred ? deps.store.readCache() : null;
  if (cached && now() - cached.at < ALLOW_CACHE_MAX_AGE_MS) deps.onAllowList(cached.allowedNodeIds, cached.relayUrls);
  let state: LinkState = cred ? { kind: 'linked', hostCredential: cred } : UNLINKED;

  while (!deps.signal?.aborted) {
    try {
      const [next, wait] = await step(state, deps, now());
      state = next;
      await sleep(wait);
    } catch (e) {
      console.warn(`[link] accounts call failed: ${messageOf(e)} — retrying in ${RETRY_MS / 1000}s`);
      await sleep(RETRY_MS);
    }
  }
}

async function step(state: LinkState, deps: HostLinkDeps, nowMs: number): Promise<[LinkState, number]> {
  if (state.kind !== 'linked') {
    // Linked by sign-in (linkWithSession) since the last step.
    const cred = deps.store.readCredential();
    if (cred) {
      deps.show.linked?.();
      return [{ kind: 'linked', hostCredential: cred }, 0];
    }
  }
  switch (state.kind) {
    case 'unlinked': {
      const ts = Math.floor(nowMs / 1000);
      const sig = await deps.sign(claimMessage(deps.nodeId, ts));
      const claim = await deps.client.createClaim({ nodeId: deps.nodeId, name: deps.name, platform: deps.platform, ts, sig });
      showClaim(deps, claim.claimCode);
      return [{ kind: 'claiming', code: claim.claimCode, hostSecret: claim.hostSecret, expiresAt: claim.expiresAt }, CLAIM_POLL_MS];
    }
    case 'claiming': {
      const poll = await deps.client.pollClaim(state.code, state.hostSecret);
      const next = onPoll(state, poll, nowMs);
      // Before anything else: the service never repeats the credential.
      if (next.kind === 'linked') {
        deps.store.writeCredential(next.hostCredential);
        deps.show.line(`  Linked to ${poll.maskedEmail ?? 'your Belay account'}.`);
        deps.show.linked?.();
        return [next, 0];
      }
      if (next.kind === 'unlinked') deps.show.line('  Claim code expired — showing a new one.');
      return [next, next.kind === 'claiming' ? CLAIM_POLL_MS : 0];
    }
    case 'linked': {
      try {
        const hb = await deps.client.heartbeat(state.hostCredential);
        deps.store.writeCache({ allowedNodeIds: hb.allowedNodeIds, relayUrls: hb.relayUrls, at: nowMs });
        deps.onAllowList(hb.allowedNodeIds, hb.relayUrls);
        deps.onPhones?.(hb.phones ?? []);
        return [state, HEARTBEAT_MS];
      } catch (e) {
        const next = onHeartbeatFailure(state, e);
        if (next.kind === 'unlinked') {
          deps.store.clearCredential();
          // Revoked means revoked now: the sidecar admits nobody, and a restart
          // cannot replay yesterday's list. The relays stay: an empty set would
          // restart the sidecar with no relay, and it must never fall back to
          // public ones.
          const relayUrls = deps.store.readCache()?.relayUrls ?? [];
          deps.store.writeCache({ allowedNodeIds: [], relayUrls, at: nowMs });
          deps.onAllowList([], relayUrls);
          deps.show.line('  This computer is no longer linked to an account — scan the new code to link it again.');
          return [next, 0];
        }
        console.warn(`[link] heartbeat failed: ${messageOf(e)} (keeping the cached allow-list)`);
        return [state, RETRY_MS];
      }
    }
  }
}

export type SessionLinkDeps = Pick<HostLinkDeps, 'client' | 'store' | 'nodeId' | 'name' | 'platform' | 'sign' | 'now'>;

/**
 * Belay.app signed in on this computer: link it with that session, once. The
 * session is only an argument here — never stored, never logged. The
 * credential is written before returning, exactly like the claim path, and
 * runHostLink picks it up on its next step.
 */
export async function linkWithSession(deps: SessionLinkDeps, session: string): Promise<{ maskedEmail?: string }> {
  if (deps.store.readCredential()) throw new Error('this computer is already linked');
  const ts = Math.floor((deps.now ?? Date.now)() / 1000);
  const sig = await deps.sign(claimMessage(deps.nodeId, ts));
  const res = await deps.client.linkHost(session, { nodeId: deps.nodeId, name: deps.name, platform: deps.platform, ts, sig });
  deps.store.writeCredential(res.hostCredential);
  return res.maskedEmail ? { maskedEmail: res.maskedEmail } : {};
}

function showClaim(deps: HostLinkDeps, code: string): void {
  const link = claimLink(code, deps.nodeId);
  deps.show.line('');
  deps.show.line('  Link this computer: open the Belay app on your phone, sign in, and scan this QR');
  deps.show.qr(link);
  deps.show.line(`  ...or type the code ${code} in the Belay app.`);
  deps.show.popup('Belay — link this computer', `Open Belay on your phone, sign in, and scan the QR — or type code ${code}.`);
}

// ---- the on-disk store ------------------------------------------------------

export const CREDENTIAL_FILE = 'host-credential';
export const ALLOW_CACHE_FILE = 'net-allow.json';

/** ~/.belay/host-credential (0600) and ~/.belay/net-allow.json. */
export function diskLinkStore(home: string = homedir()): LinkStore {
  const dir = join(home, '.belay');
  const credPath = join(dir, CREDENTIAL_FILE);
  const cachePath = join(dir, ALLOW_CACHE_FILE);
  const ensureDir = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); };
  return {
    readCredential: () => {
      try { return readFileSync(credPath, 'utf8').trim() || null; } catch { return null; }
    },
    writeCredential: (c) => {
      ensureDir();
      writeFileSync(credPath, `${c}\n`, { mode: 0o600 });
      // The mode is ignored when the file already existed; make it unconditional.
      chmodSync(credPath, 0o600);
    },
    clearCredential: () => rmSync(credPath, { force: true }),
    readCache: () => {
      try {
        const c = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<AllowCache>;
        if (!Array.isArray(c.allowedNodeIds)) return null;
        return { allowedNodeIds: c.allowedNodeIds, relayUrls: Array.isArray(c.relayUrls) ? c.relayUrls : [], at: Number(c.at) || 0 };
      } catch { return null; }
    },
    writeCache: (c) => { ensureDir(); writeFileSync(cachePath, JSON.stringify(c), { mode: 0o600 }); },
  };
}
