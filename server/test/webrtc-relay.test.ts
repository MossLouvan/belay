// Host-side signaling validation: the boundary that keeps attacker-controlled
// SDP/ICE from reaching the peer-connection layer unchecked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSignal, SIGNAL_LIMITS } from '../src/webrtc/relay.js';
import { webrtcEnabled } from '../src/webrtc/flag.js';

test('accepts a well-formed offer and answer', () => {
  const offer = validateSignal({ kind: 'offer', sessionId: 'sess-1', sdp: 'v=0\r\n' });
  assert.equal(offer.ok, true);
  const answer = validateSignal({ kind: 'answer', sessionId: 'sess-1', sdp: 'v=0\r\n' });
  assert.equal(answer.ok, true);
});

test('accepts an ice candidate and a bye', () => {
  assert.equal(validateSignal({ kind: 'ice', sessionId: 'a', candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' }).ok, true);
  const bye = validateSignal({ kind: 'bye', sessionId: 'a', reason: 'user left' });
  assert.equal(bye.ok, true);
});

test('rejects unknown kinds', () => {
  assert.equal(validateSignal({ kind: 'exec', sessionId: 'a' }).ok, false);
  assert.equal(validateSignal({ kind: 'offer' }).ok, false);
});

test('rejects a missing, empty, or illegal sessionId', () => {
  assert.equal(validateSignal({ kind: 'ice', candidate: 'c' }).ok, false);
  assert.equal(validateSignal({ kind: 'ice', sessionId: '', candidate: 'c' }).ok, false);
  assert.equal(validateSignal({ kind: 'ice', sessionId: 'a b/../c', candidate: 'c' }).ok, false);
});

test('rejects oversized sdp and candidate by BYTE length', () => {
  const bigSdp = 'v'.repeat(SIGNAL_LIMITS.maxSdpBytes + 1);
  assert.equal(validateSignal({ kind: 'offer', sessionId: 'a', sdp: bigSdp }).ok, false);
  const bigCand = 'c'.repeat(SIGNAL_LIMITS.maxCandidateBytes + 1);
  assert.equal(validateSignal({ kind: 'ice', sessionId: 'a', candidate: bigCand }).ok, false);
  // Multibyte payload that is under the code-unit count but over the byte cap.
  const multibyte = '★'.repeat(SIGNAL_LIMITS.maxSdpBytes); // 3 bytes each
  assert.equal(validateSignal({ kind: 'offer', sessionId: 'a', sdp: multibyte }).ok, false);
});

test('never throws on junk input', () => {
  for (const junk of [null, undefined, 42, 'string', [], { kind: 42 }]) {
    assert.doesNotThrow(() => validateSignal(junk));
    assert.equal(validateSignal(junk).ok, false);
  }
});

test('bye truncates an over-long reason rather than rejecting', () => {
  const r = validateSignal({ kind: 'bye', sessionId: 'a', reason: 'x'.repeat(9999) });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok((r.message.reason ?? '').length <= SIGNAL_LIMITS.maxReasonBytes);
});

test('bye reason truncates by BYTES without a trailing replacement char', () => {
  const star = '\u2605'; // 3 UTF-8 bytes each
  const r = validateSignal({ kind: 'bye', sessionId: 'a', reason: star.repeat(200) });
  assert.equal(r.ok, true);
  if (r.ok) {
    const bytes = Buffer.byteLength(r.message.reason ?? '', 'utf8');
    assert.ok(bytes <= SIGNAL_LIMITS.maxReasonBytes, `reason is ${bytes} bytes, within cap`);
    assert.ok(!(r.message.reason ?? '').endsWith('\uFFFD'), 'no lone replacement char at the cut');
  }
});

test('the webrtc path is OFF by default and only on for explicit truthy flags', () => {
  assert.equal(webrtcEnabled({}), false);
  assert.equal(webrtcEnabled({ BELAY_WEBRTC: '' }), false);
  assert.equal(webrtcEnabled({ BELAY_WEBRTC: 'false' }), false);
  assert.equal(webrtcEnabled({ BELAY_WEBRTC: '1' }), true);
  assert.equal(webrtcEnabled({ BELAY_WEBRTC: 'true' }), true);
  assert.equal(webrtcEnabled({ BELAY_WEBRTC: 'on' }), true);
  // legacy fallback honoured
  assert.equal(webrtcEnabled({ TETHER_WEBRTC: '1' }), true);
});
