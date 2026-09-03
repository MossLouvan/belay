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
  const sealed = sealSignal(OFFER, signalKey, 'host', now);

  const result = verifySealedSignal(sealed, signalKey, createReplayGuard(), 'client', now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message.kind, 'offer');
    assert.equal(result.message.sdp, OFFER.sdp);
  }
});

test('the sealed message still passes plain envelope validation (relay path unchanged)', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const sealed = sealSignal(OFFER, signalKey, 'host');
  const validated = validateSignal(sealed);
  assert.equal(validated.ok, true);
  if (validated.ok) assert.equal(validated.message.seal, sealed.seal);
});

test('tampering with any sealed field breaks verification', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, 'host', now);

  const tampered: Record<string, unknown>[] = [
    { ...sealed, sdp: sealed.sdp + ' ' },
    { ...sealed, sessionId: 'sess-2' },
    { ...sealed, kind: 'answer' },
    { ...sealed, seal: sealed.seal.slice(0, -2) + 'ZZ' },
  ];
  for (const frame of tampered) {
    const result = verifySealedSignal(frame, signalKey, createReplayGuard(), 'client', now);
    assert.equal(result.ok, false, `tampered frame accepted: ${JSON.stringify(frame).slice(0, 80)}`);
  }
});

test('a seal minted under one pairing never verifies under another', () => {
  const a = deriveRendezvousIdentity(TOKEN_A);
  const b = deriveRendezvousIdentity(TOKEN_B);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, a.signalKey, 'host', now);

  const result = verifySealedSignal(sealed, b.signalKey, createReplayGuard(), 'client', now);
  assert.equal(result.ok, false);
});

test('field-boundary shifting cannot forge an equivalent canonical encoding', () => {
  // sdp ends with X vs candidate begins with X — length prefixes must keep
  // these distinct. Seal an ice message, then try to pass its tag off on a
  // frame whose bytes concatenate the same but split differently.
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const ice = { kind: 'ice' as const, sessionId: 's', candidate: 'candidate:ab' };
  const sealed = sealSignal(ice, signalKey, 'host', now);
  const shifted = { kind: 'ice', sessionId: 'sc', candidate: 'andidate:ab', seal: sealed.seal };
  assert.equal(verifySealedSignal(shifted, signalKey, createReplayGuard(), 'client', now).ok, false);
});

test('rejects a replayed seal, and only authentic frames consume the guard', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const guard = createReplayGuard();
  const sealed = sealSignal(OFFER, signalKey, 'host', now);

  assert.equal(verifySealedSignal(sealed, signalKey, guard, 'client', now).ok, true);
  const replayed = verifySealedSignal(sealed, signalKey, guard, 'client', now);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.match(replayed.error, /replay/);

  // A forged frame reusing the nonce must not have consumed guard capacity.
  const before = guard.size();
  const forged = { ...sealed, sdp: sealed.sdp + '!' };
  assert.equal(verifySealedSignal(forged, signalKey, guard, 'client', now).ok, false);
  assert.equal(guard.size(), before);
});

test('rejects seals outside the clock-skew window', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const base = 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, 'host', () => base);

  const late = verifySealedSignal(sealed, signalKey, createReplayGuard(), 'client', () => base + ENVELOPE_LIMITS.maxSkewMs + 1);
  assert.equal(late.ok, false);
  const early = verifySealedSignal(sealed, signalKey, createReplayGuard(), 'client', () => base - ENVELOPE_LIMITS.maxSkewMs - 1);
  assert.equal(early.ok, false);
  const edge = verifySealedSignal(sealed, signalKey, createReplayGuard(), 'client', () => base + ENVELOPE_LIMITS.maxSkewMs);
  assert.equal(edge.ok, true);
});

test('rejects missing and malformed seals', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const guard = createReplayGuard();
  assert.equal(verifySealedSignal(OFFER, signalKey, guard, 'client').ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'v0.1.2.3' }, signalKey, guard, 'client').ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'garbage' }, signalKey, guard, 'client').ok, false);
  assert.equal(verifySealedSignal({ ...OFFER, seal: 'v2.host.NaN.aa.bb' }, signalKey, guard, 'client').ok, false);
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

// --- Direction binding (reflection defence) -------------------------------

test('a genuine opposite-direction frame verifies', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  // Host seals; the client verifies with its own local side = 'client'.
  const sealed = sealSignal(OFFER, signalKey, 'host', now);
  assert.equal(verifySealedSignal(sealed, signalKey, createReplayGuard(), 'client', now).ok, true);

  // And symmetrically, client → host.
  const fromClient = sealSignal(OFFER, signalKey, 'client', now);
  assert.equal(verifySealedSignal(fromClient, signalKey, createReplayGuard(), 'host', now).ok, true);
});

test('a reflected same-direction frame is rejected (rendezvous cannot bounce our own seal back)', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const bye = { kind: 'bye' as const, sessionId: 'sess-1', reason: 'done' };
  // The host sent this; a hostile rendezvous reflects it back to the host.
  const sealed = sealSignal(bye, signalKey, 'host', now);
  const reflected = verifySealedSignal(sealed, signalKey, createReplayGuard(), 'host', now);
  assert.equal(reflected.ok, false);
  if (!reflected.ok) assert.match(reflected.error, /direction/);
});

test('tampering with the from segment breaks the tag', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const now = () => 1_700_000_000_000;
  const sealed = sealSignal(OFFER, signalKey, 'host', now);
  // Flip host → client in the seal so the direction check would pass at a
  // 'host' verifier, but the tag (which covers `from`) must now fail.
  const parts = sealed.seal.split('.');
  parts[1] = 'client';
  const forged = { ...sealed, seal: parts.join('.') };
  const result = verifySealedSignal(forged, signalKey, createReplayGuard(), 'host', now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /verification failed/);
});

test('rejects a seal with an unknown direction segment', () => {
  const { signalKey } = deriveRendezvousIdentity(TOKEN_A);
  const guard = createReplayGuard();
  assert.equal(
    verifySealedSignal({ ...OFFER, seal: 'v2.rogue.1700000000000.' + 'a'.repeat(32) + '.zz' }, signalKey, guard, 'client').ok,
    false,
  );
});
