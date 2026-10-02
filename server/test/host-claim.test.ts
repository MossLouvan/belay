// host-claim.ts: the claim state machine and the link loop, against a
// scripted accounts client. The one invariant worth a test of its own: the
// host credential is persisted the moment it arrives, before the next call —
// the service hands it out exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  onPoll, onHeartbeatFailure, runHostLink, claimLink, LinkState, LinkStore, LinkShow, ALLOW_CACHE_MAX_AGE_MS,
} from '../src/host-claim.js';
import { AccountsError, AccountsClient } from '../src/accounts-client.js';

const claiming: LinkState = { kind: 'claiming', code: 'ABCD2345', hostSecret: 's', expiresAt: 10_000 };

test('poll transitions: pending stays, expiry and credential-less claimed go back to unlinked', () => {
  assert.deepEqual(onPoll(claiming, { status: 'pending' }, 5_000), claiming);
  assert.deepEqual(onPoll(claiming, { status: 'pending' }, 10_000), { kind: 'unlinked' }, 'past expiresAt');
  assert.deepEqual(onPoll(claiming, { status: 'expired' }, 1), { kind: 'unlinked' });
  assert.deepEqual(onPoll(claiming, { status: 'claimed', hostCredential: 'cred' }, 1), { kind: 'linked', hostCredential: 'cred' });
  assert.deepEqual(onPoll(claiming, { status: 'claimed' }, 1), { kind: 'unlinked' }, 'claimed but the credential was handed to a poll we lost: re-claim');
});

test('a 401 heartbeat unlinks; any other failure keeps the credential', () => {
  const linked: LinkState = { kind: 'linked', hostCredential: 'cred' };
  assert.deepEqual(onHeartbeatFailure(linked, new AccountsError(401, 'nope')), { kind: 'unlinked' });
  assert.deepEqual(onHeartbeatFailure(linked, new AccountsError(503, 'later')), linked);
  assert.deepEqual(onHeartbeatFailure(linked, new Error('ECONNRESET')), linked);
});

test('the QR payload is belay://claim?c=<code>&n=<nodeId>', () => {
  assert.equal(claimLink('ABCD2345', 'ab'.repeat(32)), `belay://claim?c=ABCD2345&n=${'ab'.repeat(32)}`);
});

interface Script { readonly calls: string[]; readonly client: AccountsClient; readonly store: LinkStore & { cred: string | null; cache: unknown }; readonly show: LinkShow & { lines: string[]; qrs: string[]; popups: string[] } }

function script(steps: Array<() => unknown>, cred: string | null = null, cache: unknown = null): Script {
  const calls: string[] = [];
  const next = (name: string, ...args: unknown[]) => {
    calls.push([name, ...args.map(String)].join(' '));
    const step = steps.shift();
    if (!step) throw new Error('script over');
    const out = step();
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out as never);
  };
  const store = {
    cred, cache,
    readCredential: () => store.cred,
    writeCredential: (c: string) => { calls.push(`write ${c}`); store.cred = c; },
    clearCredential: () => { calls.push('clear'); store.cred = null; },
    readCache: () => store.cache as never,
    writeCache: (c: unknown) => { store.cache = c; },
  };
  const show = {
    lines: [] as string[], qrs: [] as string[], popups: [] as string[],
    line: (t: string) => { show.lines.push(t); }, qr: (l: string) => { show.qrs.push(l); },
    popup: (t: string, b: string) => { show.popups.push(`${t}|${b}`); },
  };
  return {
    calls, store, show,
    client: {
      createClaim: (b) => next('createClaim', b.nodeId, b.ts, b.sig),
      pollClaim: (c, s) => next('poll', c, s),
      heartbeat: (c) => next('heartbeat', c),
    },
  };
}

async function run(s: Script, rounds: number, onAllowList: (ids: readonly string[], relays: readonly string[]) => void = () => {}) {
  const ctl = new AbortController();
  let left = rounds;
  await runHostLink({
    client: s.client, store: s.store, show: s.show, onAllowList, signal: ctl.signal,
    nodeId: 'ab'.repeat(32), name: 'mac', platform: 'darwin',
    sign: async (m) => `sig(${m})`,
    now: () => 1_000_000, sleep: async () => { if (--left <= 0) ctl.abort(); },
  });
}

test('happy path: claim, show QR, poll, persist credential before anything else, heartbeat, allow-list', async () => {
  const s = script([
    () => ({ claimCode: 'ABCD2345', hostSecret: 'hs', expiresAt: 1_000_000 + 600_000 }),
    () => ({ status: 'pending' }),
    () => ({ status: 'claimed', hostCredential: 'cred-1', maskedEmail: 'm***@gmail.com' }),
    () => ({ allowedNodeIds: ['n1', 'n2'], relayUrls: ['https://relay.example'] }),
  ]);
  const seen: unknown[] = [];
  await run(s, 4, (ids, relays) => seen.push([ids, relays]));
  assert.deepEqual(s.calls, [
    `createClaim ${'ab'.repeat(32)} 1000 sig(belay-claim:v1:${'ab'.repeat(32)}:1000)`,
    'poll ABCD2345 hs', 'poll ABCD2345 hs', 'write cred-1', 'heartbeat cred-1',
  ]);
  assert.deepEqual(s.show.qrs, [`belay://claim?c=ABCD2345&n=${'ab'.repeat(32)}`]);
  assert.ok(s.show.popups.length === 1 && s.show.popups[0].includes('ABCD2345'));
  assert.ok(s.show.lines.some((l) => l.includes('Linked to m***@gmail.com')));
  assert.deepEqual(seen, [[['n1', 'n2'], ['https://relay.example']]]);
  assert.deepEqual(s.store.cache, { allowedNodeIds: ['n1', 'n2'], relayUrls: ['https://relay.example'], at: 1_000_000 });
});

test('an expired claim is replaced by a new one', async () => {
  const s = script([
    () => ({ claimCode: 'OLD', hostSecret: 'a', expiresAt: 1 }),
    () => ({ status: 'expired' }),
    () => ({ claimCode: 'NEW', hostSecret: 'b', expiresAt: 1_000_000 + 600_000 }),
    () => ({ status: 'pending' }),
  ]);
  await run(s, 4);
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('createClaim')), ['poll OLD a', 'poll NEW b']);
  assert.equal(s.show.qrs.length, 2);
});

test('a 401 heartbeat clears the credential and starts a new claim', async () => {
  const s = script([
    () => new AccountsError(401, 'revoked'),
    () => ({ claimCode: 'AGAIN', hostSecret: 'c', expiresAt: 1_000_000 + 600_000 }),
  ], 'stale-cred');
  await run(s, 2);
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('createClaim')), ['heartbeat stale-cred', 'clear']);
  assert.equal(s.store.cred, null);
});

test('a cached allow-list is applied before the first heartbeat, and a failed heartbeat keeps the link', async () => {
  const s = script([() => new Error('offline')], 'cred', { allowedNodeIds: ['n9'], relayUrls: [], at: 5 });
  const seen: unknown[] = [];
  await run(s, 1, (ids) => seen.push(ids));
  assert.deepEqual(seen, [['n9']]);
  assert.deepEqual(s.calls, ['heartbeat cred']);
  assert.equal(s.store.cred, 'cred');
});

test('a cached allow-list is NOT applied while no credential exists', async () => {
  const s = script([
    () => ({ claimCode: 'X', hostSecret: 'x', expiresAt: 1_000_000 + 600_000 }),
    () => ({ status: 'pending' }),
  ], null, { allowedNodeIds: ['n9'], relayUrls: [], at: 999_999 });
  const seen: unknown[] = [];
  await run(s, 2, (ids) => seen.push(ids));
  assert.deepEqual(seen, [], 'an unlinked host admits nobody, whatever the disk says');
});

test('a cache older than 72 h is not replayed', async () => {
  const s = script([() => new Error('offline')], 'cred', { allowedNodeIds: ['n9'], relayUrls: [], at: 1_000_000 - ALLOW_CACHE_MAX_AGE_MS });
  const seen: unknown[] = [];
  await run(s, 1, (ids) => seen.push(ids));
  assert.deepEqual(seen, []);
  assert.deepEqual(s.calls, ['heartbeat cred'], 'the link itself is kept; only the stale list is dropped');
});

test('a 401 heartbeat empties the allow-list and its cache immediately, keeping the relays', async () => {
  const s = script([
    () => new AccountsError(401, 'revoked'),
    () => ({ claimCode: 'AGAIN', hostSecret: 'c', expiresAt: 1_000_000 + 600_000 }),
  ], 'stale-cred', { allowedNodeIds: ['n1'], relayUrls: ['r'], at: 999_999 });
  const seen: unknown[] = [];
  await run(s, 2, (ids, relays) => seen.push([ids, relays]));
  assert.deepEqual(seen, [[['n1'], ['r']], [[], ['r']]], 'cache replayed at start, then revoked; the relays are kept');
  assert.deepEqual(s.store.cache, { allowedNodeIds: [], relayUrls: ['r'], at: 1_000_000 });
});

test('a credential-less "claimed" while holding none re-claims', async () => {
  const s = script([
    () => ({ claimCode: 'X', hostSecret: 'x', expiresAt: 1_000_000 + 600_000 }),
    () => ({ status: 'claimed' }),
    () => ({ claimCode: 'Y', hostSecret: 'y', expiresAt: 1_000_000 + 600_000 }),
  ]);
  await run(s, 3);
  assert.equal(s.calls.filter((c) => c.startsWith('createClaim')).length, 2);
  assert.equal(s.store.cred, null);
});
