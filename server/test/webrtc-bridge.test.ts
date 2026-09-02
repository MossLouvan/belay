// The signaling bridge: validated 1:1 relay between the two peers of a session.
//
//   cd server && npx tsx --test test/webrtc-bridge.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingBridge, type RelaySide } from '../src/webrtc/bridge.js';
import type { ValidSignal } from '../src/webrtc/relay.js';

/** A bridge whose two sinks just record what they were handed, so a test can
 *  assert which peer a frame reached and in what shape. */
function harness(sessionId?: string) {
  const toClient: ValidSignal[] = [];
  const toHost: ValidSignal[] = [];
  const bridge = new SignalingBridge(
    { deliver: (m) => toClient.push(m) },
    { deliver: (m) => toHost.push(m) },
    sessionId,
  );
  return { bridge, toClient, toHost };
}

const offer = (sessionId: string) => ({ kind: 'offer', sessionId, sdp: 'v=0\r\n' });
const answer = (sessionId: string) => ({ kind: 'answer', sessionId, sdp: 'v=0\r\n' });
const ice = (sessionId: string, c = 'candidate:1 1 udp 1 1.2.3.4 5 typ host') => ({ kind: 'ice', sessionId, candidate: c });

test('forwards a client offer to the host and a host answer to the client', () => {
  const { bridge, toClient, toHost } = harness('sid');
  const o = bridge.ingest('client', offer('sid'));
  assert.equal(o.ok, true);
  assert.equal(toHost.length, 1);
  assert.equal(toHost[0].kind, 'offer');
  assert.equal(toClient.length, 0);

  const a = bridge.ingest('host', answer('sid'));
  assert.equal(a.ok, true);
  assert.equal(toClient.length, 1);
  assert.equal(toClient[0].kind, 'answer');
});

test('ICE flows both ways to the opposite peer only', () => {
  const { bridge, toClient, toHost } = harness('sid');
  bridge.ingest('client', ice('sid', 'candidate:client'));
  bridge.ingest('host', ice('sid', 'candidate:host'));
  assert.deepEqual(toHost.map((m) => m.candidate), ['candidate:client']);
  assert.deepEqual(toClient.map((m) => m.candidate), ['candidate:host']);
});

test('a malformed frame is rejected and forwarded to no one', () => {
  const { bridge, toClient, toHost } = harness('sid');
  const r = bridge.ingest('client', { kind: 'offer', sessionId: 'sid' }); // no sdp
  assert.equal(r.ok, false);
  assert.equal(toHost.length, 0);
  assert.equal(toClient.length, 0);
});

test('binds the session on the first frame when none was pinned', () => {
  const { bridge, toHost } = harness(); // unbound
  assert.equal(bridge.sessionId, null);
  bridge.ingest('client', offer('learned'));
  assert.equal(bridge.sessionId, 'learned');
  assert.equal(toHost.length, 1);
});

test('a frame for a different session is rejected as stale, never forwarded', () => {
  const { bridge, toHost } = harness('sid');
  bridge.ingest('client', offer('sid'));
  const stale = bridge.ingest('client', offer('other-session'));
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? '' : stale.error, /stale session/);
  assert.equal(toHost.length, 1); // only the first offer got through
});

test('a bye is forwarded and then closes the bridge; later frames are rejected', () => {
  const { bridge, toHost } = harness('sid');
  const bye = bridge.ingest('client', { kind: 'bye', sessionId: 'sid', reason: 'user left' });
  assert.equal(bye.ok, true);
  assert.equal(bridge.isClosed, true);
  assert.equal(toHost.length, 1);
  assert.equal(toHost[0].kind, 'bye');

  const after = bridge.ingest('client', offer('sid'));
  assert.equal(after.ok, false);
  assert.equal(toHost.length, 1); // nothing new forwarded after close
});

test('close() is idempotent and rejects further ingest', () => {
  const { bridge } = harness('sid');
  bridge.close();
  bridge.close();
  const r = bridge.ingest('host', answer('sid'));
  assert.equal(r.ok, false);
});

test('the host peer is validated on the same boundary as the client', () => {
  // A garbage frame pushed FROM the helper is dropped exactly like a garbage
  // frame from the phone — no path skips validateSignal.
  const { bridge, toClient } = harness('sid');
  const r = bridge.ingest('host' as RelaySide, { kind: 'nonsense', sessionId: 'sid' });
  assert.equal(r.ok, false);
  assert.equal(toClient.length, 0);
});
