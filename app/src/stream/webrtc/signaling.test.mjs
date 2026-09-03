// WebRTC signaling state machine: the offer/answer handshake, ICE buffering,
// glare, stale-session rejection, and the terminal-vs-recoverable distinction
// the screen-stream playtest showed was missing before.
//
//   cd app && node --test src/stream/webrtc/signaling.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  begin, close, connectionStateChanged, initialState, isTerminal,
  localDescription, receive, restart,
} from './signaling.ts';

const SID = 'sess-1';

test('caller begins by creating an offer; callee waits', () => {
  const caller = begin(initialState('caller', SID));
  assert.equal(caller.state.phase, 'offering');
  assert.deepEqual(caller.effects, [{ do: 'create-offer' }]);

  const callee = begin(initialState('callee', SID));
  assert.equal(callee.state.phase, 'idle');
  assert.deepEqual(callee.effects, []);
});

test('caller sends its local offer, then applies the answer and flushes ICE', () => {
  let s = begin(initialState('caller', SID)).state;
  const sent = localDescription(s, 'offer', 'v=0 offer');
  assert.deepEqual(sent.effects, [{ do: 'send', message: { kind: 'offer', sdp: 'v=0 offer', sessionId: SID } }]);
  s = sent.state;

  const ans = receive(s, { kind: 'answer', sdp: 'v=0 answer', sessionId: SID });
  assert.equal(ans.state.phase, 'negotiating');
  assert.deepEqual(ans.effects, [
    { do: 'set-remote', sdp: 'v=0 answer', type: 'answer' },
    { do: 'flush-candidates', candidates: [] },
  ]);
  assert.deepEqual(ans.state.pendingRemoteCandidates, [], 'buffer cleared to prevent a double-flush');
});

test('callee applies the offer and creates an answer', () => {
  const s = initialState('callee', SID);
  const t = receive(s, { kind: 'offer', sdp: 'v=0 offer', sessionId: SID });
  assert.equal(t.state.phase, 'answering');
  assert.deepEqual(t.effects, [
    { do: 'set-remote', sdp: 'v=0 offer', type: 'offer' },
    { do: 'flush-candidates', candidates: [] },
    { do: 'create-answer' },
  ]);
});

// A well-formed ICE frame now carries sdpMid/sdpMLineIndex, since addIceCandidate
// needs at least one of them (see coerceIceCandidate / IceCandidatePayload).
const ice = (candidate, sdpMid = '0', sdpMLineIndex = 0) => ({ kind: 'ice', candidate, sdpMid, sdpMLineIndex, sessionId: SID });
const cand = (candidate, sdpMid = '0', sdpMLineIndex = 0) => ({ candidate, sdpMid, sdpMLineIndex });

test('ICE candidates arriving before the remote description are buffered', () => {
  let s = begin(initialState('caller', SID)).state; // 'offering', no remote desc yet
  const t = receive(s, ice('cand-A'));
  assert.deepEqual(t.effects, [], 'not added to the peer connection yet');
  assert.deepEqual(t.state.pendingRemoteCandidates, [cand('cand-A')]);
});

test('callee flushes candidates buffered before the offer (the dropped-ICE bug)', () => {
  let s = initialState('callee', SID);
  s = receive(s, ice('early-1')).state; // pre-offer, buffered
  s = receive(s, ice('early-2')).state;
  assert.deepEqual(s.pendingRemoteCandidates, [cand('early-1'), cand('early-2')]);
  const t = receive(s, { kind: 'offer', sdp: 'o', sessionId: SID });
  const flush = t.effects.find((e) => e.do === 'flush-candidates');
  assert.deepEqual(flush.candidates, [cand('early-1'), cand('early-2')], 'buffered candidates are flushed, not dropped');
  assert.deepEqual(t.state.pendingRemoteCandidates, []);
});

test('ICE candidates after negotiation is live are added immediately', () => {
  let s = begin(initialState('caller', SID)).state;
  s = receive(s, { kind: 'answer', sdp: 'a', sessionId: SID }).state; // now negotiating
  const t = receive(s, ice('cand-B'));
  assert.deepEqual(t.effects, [{ do: 'add-ice', candidate: cand('cand-B') }]);
});

test('an ICE frame carrying neither sdpMid nor sdpMLineIndex is rejected, not buffered', () => {
  // addIceCandidate would throw TypeError on such a frame, so the machine drops
  // it at the trust boundary rather than forwarding a doomed candidate.
  let s = begin(initialState('caller', SID)).state; // 'offering' — would otherwise buffer
  const t = receive(s, { kind: 'ice', candidate: 'orphan', sdpMid: null, sdpMLineIndex: null, sessionId: SID });
  assert.deepEqual(t.effects, []);
  assert.deepEqual(t.state.pendingRemoteCandidates, [], 'unusable candidate is not buffered');
});

test('an ICE frame with only sdpMLineIndex (sdpMid null) is accepted', () => {
  let s = begin(initialState('caller', SID)).state;
  s = receive(s, { kind: 'answer', sdp: 'a', sessionId: SID }).state; // negotiating
  const t = receive(s, { kind: 'ice', candidate: 'idx-only', sdpMid: null, sdpMLineIndex: 2, sessionId: SID });
  assert.deepEqual(t.effects, [{ do: 'add-ice', candidate: { candidate: 'idx-only', sdpMid: null, sdpMLineIndex: 2 } }]);
});

test('an ICE frame with a wrong-typed sdpMLineIndex is rejected', () => {
  let s = begin(initialState('caller', SID)).state;
  s = receive(s, { kind: 'answer', sdp: 'a', sessionId: SID }).state;
  const t = receive(s, { kind: 'ice', candidate: 'bad', sdpMid: null, sdpMLineIndex: '2', sessionId: SID });
  assert.deepEqual(t.effects, [], 'a string sdpMLineIndex is not coerced into a number');
});

test('an ICE frame from an older peer (no mid/index fields) is dropped, not crashed on', () => {
  let s = begin(initialState('caller', SID)).state;
  s = receive(s, { kind: 'answer', sdp: 'a', sessionId: SID }).state;
  // Backward tolerance: the frame is understood but unusable (both coerce to
  // null), so it is safely rejected rather than throwing downstream.
  const t = receive(s, { kind: 'ice', candidate: 'legacy', sessionId: SID });
  assert.deepEqual(t.effects, []);
});

test('a message for a different session is ignored (no resurrected sessions)', () => {
  const s = begin(initialState('caller', SID)).state;
  const t = receive(s, { kind: 'answer', sdp: 'a', sessionId: 'other-session' });
  assert.equal(t.state.phase, 'offering', 'unchanged');
  assert.deepEqual(t.effects, []);
});

test('glare: a callee ignores a stray offer when the caller is authoritative', () => {
  const s = { ...initialState('caller', SID), phase: 'offering' };
  const t = receive(s, { kind: 'offer', sdp: 'x', sessionId: SID });
  assert.deepEqual(t.effects, [], 'caller does not answer its own-role offer');
});

test("ICE 'failed' is recoverable: caller re-offers, callee waits", () => {
  const caller = connectionStateChanged({ ...initialState('caller', SID), phase: 'negotiating' }, 'failed');
  assert.equal(caller.state.phase, 'offering');
  assert.deepEqual(caller.effects, [{ do: 'create-offer' }]);

  const callee = connectionStateChanged({ ...initialState('callee', SID), phase: 'negotiating' }, 'failed');
  assert.equal(callee.state.phase, 'failed');
  assert.deepEqual(callee.effects, []);
});

test("'disconnected' does not tear down (ICE may self-heal)", () => {
  const t = connectionStateChanged({ ...initialState('caller', SID), phase: 'connected' }, 'disconnected');
  assert.equal(t.state.phase, 'connected');
  assert.deepEqual(t.effects, []);
});

test('connected latches', () => {
  const t = connectionStateChanged({ ...initialState('caller', SID), phase: 'negotiating' }, 'connected');
  assert.equal(t.state.phase, 'connected');
});

test('bye and close are terminal and never retry', () => {
  const bye = receive({ ...initialState('caller', SID), phase: 'connected' }, { kind: 'bye', sessionId: SID, reason: 'peer left' });
  assert.equal(bye.state.phase, 'closed');
  assert.ok(isTerminal(bye.state.phase));

  // Nothing reopens a closed session.
  assert.deepEqual(connectionStateChanged(bye.state, 'failed').effects, []);
  assert.deepEqual(restart(bye.state).effects, []);
  assert.deepEqual(begin(bye.state).effects, []);
});

test('local close sends bye then tears down', () => {
  const t = close({ ...initialState('caller', SID), phase: 'connected' }, 'user stopped');
  assert.deepEqual(t.effects, [
    { do: 'send', message: { kind: 'bye', sessionId: SID, reason: 'user stopped' } },
    { do: 'teardown', reason: 'user stopped' },
  ]);
  assert.equal(t.state.phase, 'closed');
});
