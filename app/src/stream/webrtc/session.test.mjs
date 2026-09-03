// StreamSession: the controller wiring the pure signaling machine to a peer
// connection, driven with a fake adapter — no browser, no RTCPeerConnection.
//
//   cd app && node --test src/stream/webrtc/session.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamSession } from './session.ts';

/** Records every adapter call; scripts the SDP the peer connection would make. */
function fakeAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    sent: [],
    async createOffer() { calls.push('createOffer'); return overrides.offer ?? 'SDP-OFFER'; },
    async createAnswer() { calls.push('createAnswer'); return overrides.answer ?? 'SDP-ANSWER'; },
    async setRemoteDescription(sdp, type) { calls.push(`setRemote:${type}`); if (overrides.remoteThrows) throw new Error('boom'); },
    async addIceCandidate(c) { calls.push(`ice:${c.candidate}`); },
    send(m) { this.sent.push(m); calls.push(`send:${m.kind}`); },
    teardown(r) { calls.push(`teardown:${r}`); },
  };
}

test('caller offers on start and sends the offer', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  assert.deepEqual(a.calls, ['createOffer', 'send:offer']);
  assert.equal(a.sent[0].sdp, 'SDP-OFFER');
  assert.equal(s.phase, 'offering');
});

test('callee answers a received offer', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('callee', 'sid', a);
  await s.onSignal({ kind: 'offer', sessionId: 'sid', sdp: 'REMOTE-OFFER' });
  assert.deepEqual(a.calls, ['setRemote:offer', 'createAnswer', 'send:answer']);
  assert.equal(s.phase, 'negotiating');
});

test('buffered ICE is flushed to the peer once the answer applies', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  // Candidates arrive before the answer — must be buffered, not added yet.
  await s.onSignal({ kind: 'ice', sessionId: 'sid', candidate: 'cand-1', sdpMid: '0', sdpMLineIndex: 0 });
  await s.onSignal({ kind: 'ice', sessionId: 'sid', candidate: 'cand-2', sdpMid: '0', sdpMLineIndex: 0 });
  assert.ok(!a.calls.some((c) => c.startsWith('ice:')), 'nothing added pre-answer');
  await s.onSignal({ kind: 'answer', sessionId: 'sid', sdp: 'REMOTE-ANSWER' });
  assert.ok(a.calls.includes('ice:cand-1') && a.calls.includes('ice:cand-2'), 'flushed on answer');
});

test('connecting tallies the routing exactly once from the noted pair', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  await s.onSignal({ kind: 'answer', sessionId: 'sid', sdp: 'x' });
  s.noteSelectedPair('candidate:1 1 udp 1 1.2.3.4 5 typ srflx', 'candidate:2 1 udp 1 5.6.7.8 9 typ host');
  await s.onConnectionState('connected');
  const m = s.metrics();
  assert.equal(m.phase, 'connected');
  assert.equal(m.connectionKind, 'direct-reflexive');
  assert.equal(m.iceTotals['direct-reflexive'], 1);
  assert.equal(m.iceTotals.directRatio, 1);
});

test('glass-to-glass frames flow into the latency window', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  s.setClockOffset(1000);
  s.recordFrame({ captureHostMs: 100, presentClientMs: 1140, seq: 1 }); // 40ms
  s.recordFrame({ captureHostMs: 200, presentClientMs: 1250, seq: 2 }); // 50ms
  const m = s.metrics();
  assert.equal(m.latency.count, 2);
  assert.equal(m.latency.p50, 40);
});

test('a phase change notifies the callback', async () => {
  const a = fakeAdapter();
  const phases = [];
  const s = new StreamSession('caller', 'sid', a, { onPhaseChange: (p) => phases.push(p) });
  await s.start();
  assert.deepEqual(phases, ['offering']);
});

test('an adapter failure surfaces via onError instead of throwing out', async () => {
  const a = fakeAdapter({ remoteThrows: true });
  const errs = [];
  const s = new StreamSession('callee', 'sid', a, { onError: (e) => errs.push(e) });
  await assert.doesNotReject(s.onSignal({ kind: 'offer', sessionId: 'sid', sdp: 'x' }));
  assert.equal(errs[0], 'boom');
});

test('a reconnect does not double-count the session in directRatio', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  await s.onSignal({ kind: 'answer', sessionId: 'sid', sdp: 'x' });
  s.noteSelectedPair('candidate:1 1 udp 1 1.2.3.4 5 typ host', 'candidate:2 1 udp 1 5.6.7.8 9 typ host');
  await s.onConnectionState('connected');
  await s.onConnectionState('disconnected'); // transient
  await s.onConnectionState('connected');    // re-enters connected without a restart
  const totals = s.metrics().iceTotals;
  assert.equal(totals['direct-local'], 1, 'counted once despite two connected transitions');
});

test('phase callback reports answering then negotiating, each once', async () => {
  const a = fakeAdapter();
  const phases = [];
  const s = new StreamSession('callee', 'sid', a, { onPhaseChange: (p) => phases.push(p) });
  await s.onSignal({ kind: 'offer', sessionId: 'sid', sdp: 'o' });
  assert.deepEqual(phases, ['answering', 'negotiating'], 'no duplicate negotiating, answering not skipped');
});

test('stop is terminal: sends bye, tears down, and ignores later signals', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  await s.stop('user left');
  assert.ok(a.calls.includes('send:bye') && a.calls.includes('teardown:user left'));
  assert.ok(s.isTerminal);
  const before = a.calls.length;
  await s.onConnectionState('failed'); // must not reopen
  assert.equal(a.calls.length, before, 'nothing runs after terminal');
});

test('a stale-session signal is ignored', async () => {
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  await s.start();
  const before = a.calls.length;
  await s.onSignal({ kind: 'answer', sessionId: 'OTHER', sdp: 'x' });
  assert.equal(a.calls.length, before);
  assert.equal(s.phase, 'offering');
});

// ── ABR (congestion.ts) and channel routing (channels.ts), wired into the
//    session/transport seam so they are actually used, not inert ─────────────

/** The fake adapter above omits the optional transport methods; this one adds
 *  them so the session's setpoint/routing decisions are observable. */
function transportAdapter(overrides = {}) {
  const base = fakeAdapter(overrides);
  return {
    ...base,
    bitrates: [],
    routed: [],
    setBitrate(bps) { this.bitrates.push(bps); base.calls.push(`bitrate:${bps}`); },
    sendOn(channel, kind, payload) { this.routed.push({ channel, kind, payload }); base.calls.push(`on:${channel}:${kind}`); },
  };
}

test('link feedback drives the ABR setpoint into the encoder (setBitrate)', () => {
  const a = transportAdapter();
  const s = new StreamSession('caller', 'sid', a, {}, { startBitrateBps: 2_000_000 });
  assert.equal(s.bitrateBps, 2_000_000);

  // A clean interval probes upward; the new setpoint is pushed to the adapter.
  const up = s.onLinkFeedback({ lossRatio: 0, rttMs: 20 });
  assert.ok(up > 2_000_000, 'clean feedback increases the setpoint');
  assert.equal(s.bitrateBps, up);
  assert.equal(a.bitrates.at(-1), up, 'the setpoint reached the encoder');

  // Heavy loss backs off hard.
  const down = s.onLinkFeedback({ lossRatio: 0.2, rttMs: 20 });
  assert.ok(down < up, 'heavy loss decreases the setpoint');
  assert.equal(a.bitrates.at(-1), down);
});

test('metrics expose the live bitrate setpoint', () => {
  const a = transportAdapter();
  const s = new StreamSession('caller', 'sid', a, {}, { startBitrateBps: 1_500_000 });
  assert.equal(s.metrics().bitrateBps, 1_500_000);
  s.onLinkFeedback({ lossRatio: 0, rttMs: 15 });
  assert.equal(s.metrics().bitrateBps, s.bitrateBps);
});

test('a key and a key-up always route to the reliable input channel (no stuck key)', () => {
  const a = transportAdapter();
  const s = new StreamSession('caller', 'sid', a);
  assert.equal(s.sendEvent('key', { vk: 65 }), 'input');
  assert.equal(s.sendEvent('up', { vk: 65 }), 'input');
  assert.equal(s.sendEvent('text', 'hi'), 'input');
  assert.deepEqual(a.routed.map((r) => r.channel), ['input', 'input', 'input']);
});

test('pointer motion routes to the unreliable cursor channel; control to control', () => {
  const a = transportAdapter();
  const s = new StreamSession('caller', 'sid', a);
  assert.equal(s.sendEvent('move', { x: 1, y: 2 }), 'cursor');
  assert.equal(s.sendEvent('scroll', { dy: 3 }), 'cursor');
  assert.equal(s.sendEvent('keyframe', {}), 'control');
  assert.equal(s.sendEvent('ping', {}), 'control');
  // Unknown kinds fail safe onto the reliable control channel.
  assert.equal(s.sendEvent('mystery', {}), 'control');
});

test('the session works with a signaling-only adapter that omits the transport hooks', () => {
  // The optional setBitrate/sendOn must be safe to call when absent — the JPEG
  // fallback path and the M1 fake adapter both lack them.
  const a = fakeAdapter();
  const s = new StreamSession('caller', 'sid', a);
  assert.doesNotThrow(() => s.onLinkFeedback({ lossRatio: 0, rttMs: 20 }));
  assert.doesNotThrow(() => s.sendEvent('key', { vk: 1 }));
  assert.equal(s.sendEvent('move', {}), 'cursor'); // still returns the routing decision
});
