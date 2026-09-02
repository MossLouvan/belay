// End-to-end signaling seal: the property that makes the cloud rendezvous an
// untrusted introducer. Everything here is pure over (message, key, now).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRendezvousIdentity,
  sealSignal,
  verifySealedSignal,
  createReplayGuard,
  ENVELOPE_LIMITS,
} from '../src/webrtc/envelope.js';
import { validateSignal } from '../src/webrtc/relay.js';
import { cloudSignalingEnabled } from '../src/webrtc/flag.js';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const OFFER = { kind: 'offer' as const, sessionId: 'sess-1', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' };

test('identity derivation is deterministic and key-separated', () => {
  const one = deriveRendezvousIdentity(TOKEN_A);
  const two = deriveRendezvousIdentity(TOKEN_A);
  const other = deriveRendezvousIdentity(TOKEN_B);

  assert.equal(one.mailboxId, two.mailboxId);
  assert.deepEqual(one.signalKey, two.signalKey);
  assert.notEqual(one.mailboxId, other.mailboxId);
  // The public mailboxId must not leak signal-key bytes.
  assert.equal(one.signalKey.toString('hex').includes(one.mailboxId), false);
  // mailboxId satisfies the rendezvous id charset/length rule.
  assert.match(one.mailboxId, /^[A-Za-z0-9._-]{8,128}$/);
});

test('rejects a malformed device token', () => {
  assert.throws(() => deriveRendezvousIdentity('short'));
  assert.throws(() => deriveRendezvousIdentity('z'.repeat(64)));
});

test('seal → verify round trip', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, now);

  const result = verifySealedSignal(sealed, signalKey, createReplayGuard(), now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message.kind, 'offer');
    assert.equal(result.message.sdp, OFFER.sdp);
  }
});

test('the sealed message still passes plain envelope validation (relay path unchanged)', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const sealed = sealSignal(OFFER, signalKey);
  const validated = validateSignal(sealed);
  assert.equal(validated.ok, true);
  if (validated.ok) assert.equal(validated.message.seal, sealed.seal);
});

test('tampering with any sealed field breaks verification', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, now);

  const tampered: Record<string, unknown>[] = [
    { ...sealed, sdp: sealed.sdp + ' ' },
    { ...sealed, sessionId: 'sess-2' },
    { ...sealed, kind: 'answer' },
    { ...sealed, seal: sealed.seal.slice(0, -2) + 'ZZ' },
  ];
  for (const frame of tampered) {
    const result = verifySealedSignal(frame, signalKey, createReplayGuard(), now);
    assert.equal(result.ok, false, `tampered frame accepted: ${JSON.stringify(frame).slice(0, 80)}`);
  }
});

test('a seal minted under one pairing never verifies under another', () => {
  const a = deriveRendezvousIdentity(TOKEN_A);
  const b = deriveRendezvousIdentity(TOKEN_B);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, a.signalKey, now);

  const result = verifySealedSignal(sealed, b.signalKey, createReplayGuard(), now);
  assert.equal(result.ok, false);
});

test('field-boundary shifting cannot forge an equivalent canonical encoding', () => {
  // sdp ends with X vs candidate begins with X — length prefixes must keep
  // these distinct. Seal an ice message, then try to pass its tag off on a
  // frame whose bytes concatenate the same but split differently.
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const ice = { kind: 'ice' as const, sessionId: 's', candidate: 'candidate:ab' };
  const sealed = sealSignal(ice, signalKey, now);
  const shifted = { kind: 'ice', sessionId: 'sc', candidate: 'andidate:ab', seal: sealed.seal };
  assert.equal(verifySealedSignal(shifted, signalKey, createReplayGuard(), now).ok, false);
});

test('rejects a replayed seal, and only authentic frames consume the guard', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const guard = createReplayGuard();
  const sealed = sealSignal(OFFER, signalKey, now);

  assert.equal(verifySealedSignal(sealed, signalKey, guard, now).ok, true);
  const replayed = verifySealedSignal(sealed, signalKey, guard, now);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.match(replayed.error, /replay/);

  // A forged frame reusing the nonce must not have consumed guard capacity.
  const before = guard.size();
  const forged = { ...sealed, sdp: sealed.sdp + '!' };
  assert.equal(verifySealedSignal(forged, signalKey, guard, now).ok, false);
  assert.equal(guard.size(), before);
});

test('rejects seals outside the clock-skew window', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const base = 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, () => base);

  const late = verifySealedSignal(sealed, signalKey, createReplayGuard(), () => base + ENVELOPE_LIMITS.maxSkewMs + 1);
  assert.equal(late.ok, false);
  const early = verifySealedSignal(sealed, signalKey, createReplayGuard(), () => base - ENVELOPE_LIMITS.maxSkewMs - 1);
  assert.equal(early.ok, false);
  const edge = verifySealedSignal(sealed, signalKey, createReplayGuard(), () => base + ENVELOPE_LIMITS.maxSkewMs);
  assert.equal(edge.ok, true);
});

test('rejects missing and malformed seals', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const guard = createReplayGuard();
  assert.equal(verifySealedSignal(OFFER, signalKey, guard).ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'v0.1.2.3' }, signalKey, guard).ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'garbage' }, signalKey, guard).ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'v1.NaN.aa.bb' }, signalKey, guard).ok, false);
});

test('replay guard is bounded (FIFO eviction, no unbounded growth)', () => {
  const guard = createReplayGuard(4);
  for (let i = 0; i < 10; i++) assert.equal(guard.admit(`n${i}`), true);
  assert.equal(guard.size(), 4);
  assert.equal(guard.admit('n9'), false); // recent still remembered
  assert.equal(guard.admit('n0'), true); // oldest evicted — bounded memory beats perfect memory
});

test('validateSignal rejects an oversized or non-string seal', () => {
  assert.equal(validateSignal({ ...OFFER, seal: 'x'.repeat(513) }).ok, false);
  assert.equal(validateSignal({ ...OFFER, seal: 42 }).ok, false);
});

test('cloud signaling flag: off by default, requires BOTH flags, honours legacy prefix', () => {
  assert.equal(cloudSignalingEnabled({}), false);
  assert.equal(cloudSignalingEnabled({ BELAY_CLOUD_SIGNALING: '1' }), false); // webrtc off ⇒ cloud off
  assert.equal(cloudSignalingEnabled({ BELAY_WEBRTC: '1' }), false);
  assert.equal(cloudSignalingEnabled({ BELAY_WEBRTC: '1', BELAY_CLOUD_SIGNALING: '1' }), true);
  assert.equal(cloudSignalingEnabled({ TETHER_WEBRTC: 'on', TETHER_CLOUD_SIGNALING: 'yes' }), true);
  assert.equal(cloudSignalingEnabled({ BELAY_WEBRTC: '1', BELAY_CLOUD_SIGNALING: '0' }), false);
});
