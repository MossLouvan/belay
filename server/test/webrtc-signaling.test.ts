// End-to-end signaling: two REAL StreamSessions (the app's controller) driven
// against each other through the host's SignalingBridge, so an
// offer -> answer -> ICE -> connected round trip is proven to pass through
// validateSignal (relay.ts) and the client state machine together — no browser,
// no RTCPeerConnection, no GPU. This is milestone M1's acceptance test.
//
//   cd server && npx tsx --test test/webrtc-signaling.test.ts
//
// It crosses the package boundary on purpose: the whole point is that the app's
// controller and the server's relay agree on the wire. tsx resolves both the
// server's .js-suffixed imports and the app's .ts-suffixed ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SignalingBridge, type RelaySide } from '../src/webrtc/bridge.js';
import { StreamSession, type PeerAdapter } from '../../app/src/stream/webrtc/session.ts';
import type { SignalMessage } from '../../app/src/stream/webrtc/signaling.ts';

const SID = 'sess-m1';

/**
 * A fake RTCPeerConnection adapter for one side. It records what the controller
 * asked it to do and, crucially, forwards outgoing signaling into a shared
 * loopback so the OTHER controller receives it through the bridge. Local ICE is
 * simulated by `emitLocalCandidate`, exactly as the device layer would forward a
 * gathered candidate.
 */
function makeAdapter(side: RelaySide, loop: Loopback, tag: string): FakeAdapter {
  const calls: string[] = [];
  return {
    calls,
    async createOffer() { calls.push('createOffer'); return `OFFER-${tag}`; },
    async createAnswer() { calls.push('createAnswer'); return `ANSWER-${tag}`; },
    async setRemoteDescription(_sdp, type) { calls.push(`setRemote:${type}`); },
    async addIceCandidate(c) { calls.push(`addIce:${c}`); },
    send(message) { calls.push(`send:${message.kind}`); loop.fromController(side, message); },
    teardown(reason) { calls.push(`teardown:${reason}`); },
  };
}

interface FakeAdapter extends PeerAdapter {
  readonly calls: string[];
}

/**
 * The signaling fabric: outgoing messages from each controller go INTO the
 * bridge (validated) and, once forwarded, are queued for delivery to the
 * opposite controller. `pump()` drains the queues to quiescence, so the whole
 * asynchronous handshake settles deterministically with no timers.
 */
class Loopback {
  readonly bridge: SignalingBridge;
  private readonly toCaller: SignalMessage[] = [];
  private readonly toCallee: SignalMessage[] = [];
  private caller!: StreamSession;
  private callee!: StreamSession;

  constructor() {
    // client sink -> the caller (phone); host sink -> the callee (helper peer).
    this.bridge = new SignalingBridge(
      { deliver: (m) => this.toCaller.push(m as SignalMessage) },
      { deliver: (m) => this.toCallee.push(m as SignalMessage) },
      SID,
    );
  }

  bind(caller: StreamSession, callee: StreamSession): void {
    this.caller = caller;
    this.callee = callee;
  }

  /** A controller emitted a signaling message; run it through the bridge. */
  fromController(side: RelaySide, message: SignalMessage): void {
    this.bridge.ingest(side, message);
  }

  /** Simulate a locally-gathered ICE candidate the device layer forwards. */
  emitLocalCandidate(side: RelaySide, candidate: string): void {
    this.bridge.ingest(side, { kind: 'ice', sessionId: SID, candidate });
  }

  async pump(): Promise<void> {
    // Deliver queued frames to their target controller until both queues are
    // empty. Each onSignal may enqueue more (an offer produces an answer), so
    // this loop naturally follows the handshake to completion.
    while (this.toCaller.length || this.toCallee.length) {
      if (this.toCallee.length) await this.callee.onSignal(this.toCallee.shift()!);
      else if (this.toCaller.length) await this.caller.onSignal(this.toCaller.shift()!);
    }
  }
}

function setup() {
  const loop = new Loopback();
  const callerAdapter = makeAdapter('client', loop, 'caller');
  const calleeAdapter = makeAdapter('host', loop, 'callee');
  const caller = new StreamSession('caller', SID, callerAdapter);
  const callee = new StreamSession('callee', SID, calleeAdapter);
  loop.bind(caller, callee);
  return { loop, caller, callee, callerAdapter, calleeAdapter };
}

test('offer -> answer -> ICE -> connected round-trips through the bridge', async () => {
  const { loop, caller, callee, callerAdapter, calleeAdapter } = setup();

  // Caller offers; the bridge validates and forwards it to the callee, which
  // answers; the answer is validated and forwarded back.
  await caller.start();
  await loop.pump();

  assert.equal(caller.phase, 'negotiating');
  assert.equal(callee.phase, 'negotiating');
  assert.ok(callerAdapter.calls.includes('setRemote:answer'), 'caller applied the answer');
  assert.ok(calleeAdapter.calls.includes('setRemote:offer'), 'callee applied the offer');

  // ICE both ways, each candidate relayed to the opposite peer and added there.
  loop.emitLocalCandidate('client', 'candidate:caller-1');
  loop.emitLocalCandidate('host', 'candidate:callee-1');
  await loop.pump();
  assert.ok(calleeAdapter.calls.includes('addIce:candidate:caller-1'), 'callee added the caller candidate');
  assert.ok(callerAdapter.calls.includes('addIce:candidate:callee-1'), 'caller added the callee candidate');

  // The peer connections report connectivity; both latch to connected.
  await caller.onConnectionState('connected');
  await callee.onConnectionState('connected');
  assert.equal(caller.phase, 'connected');
  assert.equal(callee.phase, 'connected');
});

test('a stray offer from the callee (glare) is dropped, negotiation still completes', async () => {
  const { loop, caller, callee } = setup();
  await caller.start();
  await loop.pump();
  // The callee's controller ignores an inbound offer (it is not the initiator);
  // pushing one through the bridge must not derail the connected handshake.
  loop.bridge.ingest('host', { kind: 'offer', sessionId: SID, sdp: 'STRAY' });
  await loop.pump();
  await caller.onConnectionState('connected');
  await callee.onConnectionState('connected');
  assert.equal(caller.phase, 'connected');
  assert.equal(callee.phase, 'connected');
});

test('a frame for a stale session never reaches the peer', async () => {
  const { loop, callee, calleeAdapter } = setup();
  const before = calleeAdapter.calls.length;
  const r = loop.bridge.ingest('client', { kind: 'offer', sessionId: 'not-our-session', sdp: 'v=0' });
  assert.equal(r.ok, false);
  await loop.pump();
  assert.equal(calleeAdapter.calls.length, before, 'callee saw nothing from the stale session');
  assert.equal(callee.phase, 'idle');
});

test('bye tears the session down on both the bridge and the callee', async () => {
  const { loop, caller, callee, calleeAdapter } = setup();
  await caller.start();
  await loop.pump();

  await caller.stop('user left'); // caller emits a bye through its adapter.send
  await loop.pump();

  assert.equal(caller.phase, 'closed');
  assert.equal(loop.bridge.isClosed, true, 'the bridge closed on the forwarded bye');
  assert.ok(calleeAdapter.calls.some((c) => c.startsWith('teardown:')), 'callee tore down');
  assert.equal(callee.phase, 'closed');
});
