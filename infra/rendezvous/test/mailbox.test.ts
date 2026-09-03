// Session brokering through mailboxes: attach-order race, bounded buffering,
// side exclusivity, session binding, terminal bye.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMailboxRegistry, Mailbox, MAILBOX_LIMITS } from '../src/mailbox.js';
import type { ValidSignal } from '../src/signal.js';

const ID = 'mbox-0001-abcdef';

function collector(): { deliver: (m: ValidSignal) => void; got: ValidSignal[] } {
  const got: ValidSignal[] = [];
  return { deliver: (m) => got.push(m), got };
}

function openBox(nowMs = 1_000_000): { box: Mailbox; now: { t: number } } {
  const now = { t: nowMs };
  const registry = createMailboxRegistry(() => now.t);
  const opened = registry.open(ID);
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error('unreachable');
  return { box: opened.mailbox, now };
}

test('relays validated signaling between attached sides, both directions', () => {
  const { box } = openBox();
  const host = collector();
  const client = collector();
  assert.equal(box.attach('host', host).ok, true);
  assert.equal(box.attach('client', client).ok, true);

  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0' }).ok, true);
  assert.equal(box.ingest('host', { kind: 'answer', sessionId: 's1', sdp: 'v=0' }).ok, true);
  assert.equal(host.got.length, 1);
  assert.equal(host.got[0].kind, 'offer');
  assert.equal(client.got.length, 1);
  assert.equal(client.got[0].kind, 'answer');
});

test('the attach-order race: frames for an absent host buffer and flush in order', () => {
  const { box } = openBox();
  const client = collector();
  box.attach('client', client);

  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0' }).ok, true);
  assert.equal(box.ingest('client', { kind: 'ice', sessionId: 's1', candidate: 'candidate:1' }).ok, true);
  assert.equal(box.ingest('client', { kind: 'ice', sessionId: 's1', candidate: 'candidate:2' }).ok, true);

  const host = collector();
  assert.equal(box.attach('host', host).ok, true);
  assert.deepEqual(
    host.got.map((m) => m.kind === 'ice' ? m.candidate : m.kind),
    ['offer', 'candidate:1', 'candidate:2'],
  );
});

test('the buffer is bounded by frames and bytes; overflow is a clean rejection', () => {
  const { box } = openBox();
  const client = collector();
  box.attach('client', client);

  let rejected = 0;
  for (let i = 0; i < MAILBOX_LIMITS.maxBufferedFrames + 5; i++) {
    const r = box.ingest('client', { kind: 'ice', sessionId: 's1', candidate: `candidate:${i}` });
    if (!r.ok) rejected++;
  }
  assert.equal(rejected, 5);

  // Byte cap: a fresh mailbox, few frames but huge SDPs.
  const { box: box2 } = openBox();
  box2.attach('client', collector());
  const bigSdp = 'a'.repeat(48 * 1024);
  assert.equal(box2.ingest('client', { kind: 'offer', sessionId: 's1', sdp: bigSdp }).ok, true);
  const second = box2.ingest('client', { kind: 'offer', sessionId: 's1', sdp: bigSdp });
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /buffer full/);
});

test('one host and one client per mailbox; re-attach only after detach', () => {
  const { box } = openBox();
  assert.equal(box.attach('host', collector()).ok, true);
  const takeover = box.attach('host', collector());
  assert.equal(takeover.ok, false); // no silent hijack of a live side

  box.detach('host');
  assert.equal(box.attach('host', collector()).ok, true); // blip recovery
});

test('binds the first session id and rejects stale ids', () => {
  const { box } = openBox();
  box.attach('host', collector());
  box.attach('client', collector());

  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0' }).ok, true);
  const stale = box.ingest('client', { kind: 'ice', sessionId: 's2', candidate: 'c' });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /stale session/);
});

test('malformed frames are rejected without throwing', () => {
  const { box } = openBox();
  box.attach('client', collector());
  assert.equal(box.ingest('client', null).ok, false);
  assert.equal(box.ingest('client', { kind: 'exec', sessionId: 's' }).ok, false);
  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's', sdp: 'x'.repeat(65 * 1024) }).ok, false);
  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 'bad id', sdp: 'v=0' }).ok, false);
});

test('the seal rides through the mailbox untouched', () => {
  const { box } = openBox();
  const host = collector();
  box.attach('host', host);
  box.attach('client', collector());
  const seal = 'v1.1700000000000.aabb.tag';
  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0', seal }).ok, true);
  assert.equal(host.got[0].seal, seal);
});

test('bye is terminal: forwarded, then the mailbox refuses everything', () => {
  const { box } = openBox();
  const host = collector();
  box.attach('host', host);
  box.attach('client', collector());

  assert.equal(box.ingest('client', { kind: 'bye', sessionId: 's1', reason: 'done' }).ok, true);
  assert.equal(host.got[0].kind, 'bye');
  assert.equal(box.isClosed, true);
  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0' }).ok, false);
  assert.equal(box.attach('client', collector()).ok, false);
});

test('bye buffered for an absent peer is delivered when it attaches shortly after', () => {
  // The sending side ends the session while its peer is briefly detached (a
  // blip, or the peer simply hasn't attached yet). The terminal bye must still
  // reach the peer when it (re)attaches — losing it leaves the sender believing
  // the session ended cleanly while the peer never learns it is over.
  const now = { t: 1_000_000 };
  const registry = createMailboxRegistry(() => now.t);
  const opened = registry.open(ID);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const box = opened.mailbox;

  // Only the client is attached; host is absent.
  box.attach('client', collector());
  assert.equal(box.ingest('client', { kind: 'bye', sessionId: 's1', reason: 'done' }).ok, true);

  // Re-opening the same id must return the SAME mailbox (not a fresh one that
  // dropped the bye) so the returning host can drain the terminal frame.
  const reopened = registry.open(ID);
  assert.equal(reopened.ok && reopened.mailbox === box, true);

  const host = collector();
  assert.equal(box.attach('host', host).ok, true);
  assert.equal(host.got.length, 1);
  assert.equal(host.got[0].kind, 'bye');

  // Once the terminal frame is drained the mailbox tears down (bounded — no
  // lingering retention) and the registry drops it.
  assert.equal(box.isClosed, true);
  assert.equal(registry.size(), 0);
});

test('a mailbox awaiting bye drain still refuses further frames and is reaped if abandoned', () => {
  const now = { t: 1_000_000 };
  const registry = createMailboxRegistry(() => now.t);
  const opened = registry.open('mbox-abandoned01');
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const box = opened.mailbox;

  box.attach('client', collector());
  assert.equal(box.ingest('client', { kind: 'bye', sessionId: 's1', reason: 'done' }).ok, true);
  // The session is over: the sender cannot smuggle more frames through.
  assert.equal(box.ingest('client', { kind: 'offer', sessionId: 's1', sdp: 'v=0' }).ok, false);

  // If the peer never returns, retention is bounded by the idle reaper.
  now.t += MAILBOX_LIMITS.idleTtlMs + 1000;
  registry.reap();
  assert.equal(box.isClosed, true);
  assert.equal(registry.size(), 0);
});

test('registry: same id → same mailbox; closed mailboxes are replaced', () => {
  const registry = createMailboxRegistry(() => 1_000_000);
  const a = registry.open(ID);
  const b = registry.open(ID);
  assert.equal(a.ok && b.ok && a.mailbox === b.mailbox, true);

  if (a.ok) a.mailbox.close();
  assert.equal(registry.size(), 0);
  const c = registry.open(ID);
  assert.equal(c.ok, true);
  if (a.ok && c.ok) assert.notEqual(a.mailbox, c.mailbox);
});

test('registry rejects invalid ids and enforces its capacity', () => {
  const registry = createMailboxRegistry(() => 1_000_000, 2);
  assert.equal(registry.open('short').ok, false);
  assert.equal(registry.open('has spaces here').ok, false);
  assert.equal(registry.open('mbox-aaaa-0001').ok, true);
  assert.equal(registry.open('mbox-aaaa-0002').ok, true);
  assert.equal(registry.open('mbox-aaaa-0003').ok, false);
});

test('idle mailboxes are reaped after the TTL; active ones survive', () => {
  const now = { t: 1_000_000 };
  const registry = createMailboxRegistry(() => now.t);
  const idle = registry.open('mbox-idle-0001');
  const active = registry.open('mbox-actv-0001');
  assert.equal(idle.ok && active.ok, true);
  if (!idle.ok || !active.ok) return;

  now.t += MAILBOX_LIMITS.idleTtlMs - 1000;
  active.mailbox.ingest('client', { kind: 'ice', sessionId: 's', candidate: 'c' });
  now.t += 2000;
  registry.reap();
  assert.equal(registry.size(), 1);
  assert.equal(idle.mailbox.isClosed, true);
  assert.equal(active.mailbox.isClosed, false);
});
