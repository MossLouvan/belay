// The presence/lease model: reachability as a pure function of recent
// announces, with replay and clock-trust properties pinned down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAnnounce,
  acceptAnnounce,
  createLeaseTable,
  isLive,
  LEASE_LIMITS,
  type HostLease,
} from '../src/lease.js';

const MAILBOX = 'a1b2c3d4e5f6a7b8';

function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('validateAnnounce accepts a well-formed announce and clamps ttl', () => {
  const ok = validateAnnounce({ mailboxId: MAILBOX, seq: 1, ttlSec: 60, hints: ['region:iad'] });
  assert.equal(ok.ok, true);

  const low = validateAnnounce({ mailboxId: MAILBOX, seq: 1, ttlSec: 1 });
  assert.equal(low.ok && low.ttlSec === LEASE_LIMITS.minTtlSec, true);
  const high = validateAnnounce({ mailboxId: MAILBOX, seq: 1, ttlSec: 100_000 });
  assert.equal(high.ok && high.ttlSec === LEASE_LIMITS.maxTtlSec, true);
  const dflt = validateAnnounce({ mailboxId: MAILBOX, seq: 1 });
  assert.equal(dflt.ok && dflt.ttlSec === LEASE_LIMITS.defaultTtlSec, true);
});

test('validateAnnounce rejects hostile shapes', () => {
  assert.equal(validateAnnounce(null).ok, false);
  assert.equal(validateAnnounce({ mailboxId: 'x', seq: 1 }).ok, false); // too short
  assert.equal(validateAnnounce({ mailboxId: 'bad id!'.repeat(2), seq: 1 }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: -1 }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: 1.5 }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: 1, ttlSec: 'soon' }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: 1, hints: new Array(9).fill('h') }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: 1, hints: ['x'.repeat(129)] }).ok, false);
  assert.equal(validateAnnounce({ mailboxId: MAILBOX, seq: 1, hints: [7] }).ok, false);
});

test('expiry comes from the server clock, never the announcer', () => {
  const validated = validateAnnounce({ mailboxId: MAILBOX, seq: 1, ttlSec: 60 });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const outcome = acceptAnnounce(undefined, validated.announce, validated.ttlSec, 1_000_000);
  assert.equal(outcome.accepted, true);
  if (outcome.accepted) assert.equal(outcome.lease.expiresAtMs, 1_000_000 + 60_000);
});

test('a live lease rejects replayed/stale seq; a dead one accepts a reset', () => {
  const announce = { mailboxId: MAILBOX, seq: 5, hints: [] as readonly string[] };
  const live: HostLease = { mailboxId: MAILBOX, seq: 5, expiresAtMs: 2_000_000, hints: [] };

  // Replay of the same seq against a live lease: rejected.
  assert.equal(acceptAnnounce(live, announce, 60, 1_000_000).accepted, false);
  // Older seq: rejected.
  assert.equal(acceptAnnounce(live, { ...announce, seq: 4 }, 60, 1_000_000).accepted, false);
  // Newer seq: accepted.
  assert.equal(acceptAnnounce(live, { ...announce, seq: 6 }, 60, 1_000_000).accepted, true);
  // Same (even lower) seq once the lease is dead: accepted — a restarted host
  // that reset its counter must not be locked out for the old lease's TTL.
  assert.equal(acceptAnnounce(live, { ...announce, seq: 1 }, 60, 3_000_000).accepted, true);
});

test('lease table: announce → live, silence → offline within one TTL', () => {
  const c = clock(1_000_000);
  const table = createLeaseTable(c.now);

  assert.equal(table.announce({ mailboxId: MAILBOX, seq: 1, ttlSec: 30 }).accepted, true);
  assert.notEqual(table.lookup(MAILBOX), null);

  c.advance(29_999);
  assert.notEqual(table.lookup(MAILBOX), null);
  c.advance(2);
  assert.equal(table.lookup(MAILBOX), null); // reachable-or-not, no tombstone needed
});

test('renewals extend the lease and bump seq', () => {
  const c = clock(1_000_000);
  const table = createLeaseTable(c.now);
  table.announce({ mailboxId: MAILBOX, seq: 1, ttlSec: 30 });

  c.advance(15_000);
  assert.equal(table.announce({ mailboxId: MAILBOX, seq: 2, ttlSec: 30 }).accepted, true);
  c.advance(20_000); // 35s after first announce — dead without the renewal
  const lease = table.lookup(MAILBOX);
  assert.notEqual(lease, null);
  assert.equal(lease!.seq, 2);
});

test('a replayed announce cannot resurrect or extend presence', () => {
  const c = clock(1_000_000);
  const table = createLeaseTable(c.now);
  table.announce({ mailboxId: MAILBOX, seq: 7, ttlSec: 30 });

  c.advance(10_000);
  // Captured announce replayed while live: rejected, expiry unchanged.
  assert.equal(table.announce({ mailboxId: MAILBOX, seq: 7, ttlSec: 30 }).accepted, false);
  c.advance(20_001);
  assert.equal(table.lookup(MAILBOX), null);
});

test('table refuses new hosts at capacity but keeps serving existing ones', () => {
  const c = clock(1_000_000);
  const table = createLeaseTable(c.now, 2);
  assert.equal(table.announce({ mailboxId: 'hostaaaa', seq: 1 }).accepted, true);
  assert.equal(table.announce({ mailboxId: 'hostbbbb', seq: 1 }).accepted, true);
  assert.equal(table.announce({ mailboxId: 'hostcccc', seq: 1 }).accepted, false);
  // Renewal of an existing host still works at capacity.
  assert.equal(table.announce({ mailboxId: 'hostaaaa', seq: 2 }).accepted, true);
});

test('expired leases are pruned; size converges to live hosts', () => {
  const c = clock(1_000_000);
  const table = createLeaseTable(c.now);
  table.announce({ mailboxId: 'hostaaaa', seq: 1, ttlSec: 30 });
  table.announce({ mailboxId: 'hostbbbb', seq: 1, ttlSec: 120 });
  assert.equal(table.size(), 2);
  c.advance(60_000);
  assert.equal(table.size(), 1);
  c.advance(120_000);
  assert.equal(table.size(), 0);
});

test('isLive is a pure threshold', () => {
  const lease: HostLease = { mailboxId: MAILBOX, seq: 1, expiresAtMs: 100, hints: [] };
  assert.equal(isLive(lease, 99), true);
  assert.equal(isLive(lease, 100), false);
  assert.equal(isLive(undefined, 0), false);
});
