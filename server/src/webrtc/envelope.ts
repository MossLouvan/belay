// End-to-end authenticity for signaling that crosses an UNTRUSTED introducer.
//
// On the LAN/Tailscale path the phone and host share an authenticated socket,
// so a validated envelope (relay.ts) is enough. Through the cloud rendezvous
// (infra/rendezvous) it is not: the rendezvous is a public meeting point that
// can connect anyone to anyone, and the design treats it as compromised from
// day one. So every signaling message carries a SEAL — an HMAC over its
// content under a key derived from the PAIRING TOKEN, which the cloud never
// sees. The rendezvous relays the seal as opaque bytes; only the paired peer
// can verify it. A hostile or compromised rendezvous can drop or misroute
// signaling (denial of service), but it cannot forge an offer, splice itself
// into a session, or mint access to any host — "connects peers, never mints
// access" is exactly this property.
//
// The DTLS-SRTP media path then rides on the sealed SDP: the SDP carries the
// certificate fingerprint, the seal proves the SDP came from the paired peer,
// and DTLS proves the media peer holds that certificate — so a rendezvous MITM
// on media would need to forge a seal, which needs the pairing token.
//
// Key separation: the signaling key and the public mailbox id are both derived
// from the device token via HKDF with distinct info strings. Learning the
// mailboxId (the rendezvous must know it to route) reveals nothing about the
// signaling key or the token — HKDF outputs are independent.
//
// Direction binding: both peers hold the SAME signalKey, so without more the
// seal proves only "some holder of the token wrote this" — not WHICH end. A
// compromised rendezvous (in scope: "cannot forge a message either peer will
// accept") could then REFLECT a peer's own sealed ice/bye frame back to it and
// it would verify cleanly — reflected ICE pollutes candidate handling, a
// reflected earlier `bye` tears down a live session. So the seal carries the
// sender's side (`from: host|client`), bound into the HMAC, and a verifier
// accepts only frames from the OPPOSITE side — a peer rejects any frame that
// claims to come from itself. This makes reflection unforgeable without adding
// a second key.
//
// Everything here is pure over (message, from, key, now), tested in
// webrtc-envelope.test.ts with tamper/replay/skew/reflection cases.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { validateSignal, type ValidSignal, type ValidationResult } from './relay.js';

export const ENVELOPE_LIMITS = Object.freeze({
  /** A verifier rejects a seal timestamped further than this from its clock.
   *  Generous for real clock drift, tight enough that a captured frame is
   *  worthless by the time it could be replayed at scale. */
  maxSkewMs: 2 * 60 * 1000,
  nonceBytes: 16,
  /** Nonces remembered for replay rejection. Bounded so a flood of unique
   *  nonces cannot exhaust memory; 4096 comfortably covers one skew window of
   *  legitimate signaling (a session is tens of messages). */
  replayCapacity: 4096,
  maxSealBytes: 512,
});

// v2 adds the sender-side segment to the seal wire format (see sealSignal).
const SEAL_VERSION = 'v2';
const HKDF_SALT = 'belay-rendezvous-v1';

/** Which end of a pairing sealed a frame. Bound into the tag so a frame's
 *  direction cannot be forged, and checked on verify so a peer never accepts
 *  a frame claiming to originate from itself (reflection defence). */
export type SealSide = 'host' | 'client';

const otherSide = (side: SealSide): SealSide => (side === 'host' ? 'client' : 'host');

export interface RendezvousIdentity {
  /** 32-byte HMAC key for sealing signaling. NEVER leaves this process. */
  readonly signalKey: Buffer;
  /** Public routing id the rendezvous uses to match peers. Safe to disclose:
   *  derived one-way from the token, and possession grants nothing. */
  readonly mailboxId: string;
}

/**
 * Derive the rendezvous identity from the paired device token (the 256-bit hex
 * token pairing.ts mints). Deterministic: both ends of a pairing derive the
 * same identity with no extra exchange.
 */
export function deriveRendezvousIdentity(deviceTokenHex: string): RendezvousIdentity {
  if (!/^[0-9a-fA-F]{64}$/.test(deviceTokenHex)) {
    throw new Error('device token must be 64 hex chars (256 bits)');
  }
  const ikm = Buffer.from(deviceTokenHex, 'hex');
  const signalKey = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, 'signal-key', 32));
  const mailbox = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, 'mailbox-id', 16));
  return { signalKey, mailboxId: mailbox.toString('hex') };
}

/**
 * Seal one validated signaling message for transit through the rendezvous.
 *
 * `from` is the sealing peer's own side; it is folded into the tag AND carried
 * in the clear inside the seal so the verifier can enforce direction. Wire
 * format: `v2.<from>.<ts>.<nonceHex>.<tag>` (v1 had no `<from>` segment).
 */
export function sealSignal(
  message: ValidSignal,
  signalKey: Buffer,
  from: SealSide,
  now: () => number = Date.now,
  nonce: Buffer = randomBytes(ENVELOPE_LIMITS.nonceBytes),
): ValidSignal & { readonly seal: string } {
  const ts = now();
  const nonceHex = nonce.toString('hex');
  const tag = computeTag(message, from, ts, nonceHex, signalKey);
  return { ...message, seal: `${SEAL_VERSION}.${from}.${ts}.${nonceHex}.${tag}` };
}

/** Remembers recently seen nonces so a captured frame cannot be replayed
 *  within the skew window. Bounded FIFO eviction. */
export interface ReplayGuard {
  /** True the first time a nonce is seen; false on any repeat. */
  admit(nonceHex: string): boolean;
  size(): number;
}

export function createReplayGuard(capacity: number = ENVELOPE_LIMITS.replayCapacity): ReplayGuard {
  const seen = new Set<string>();
  return {
    admit(nonceHex: string): boolean {
      if (seen.has(nonceHex)) return false;
      if (seen.size >= capacity) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.add(nonceHex);
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}

/**
 * Verify one raw frame that arrived via the rendezvous: envelope validation
 * (relay.ts) first, then the seal — constant-time tag comparison, clock-skew
 * bound, replay rejection. Never throws.
 */
export function verifySealedSignal(
  input: unknown,
  signalKey: Buffer,
  replay: ReplayGuard,
  localSide: SealSide,
  now: () => number = Date.now,
): ValidationResult {
  const validated = validateSignal(input);
  if (!validated.ok) return validated;
  const message = validated.message;

  const seal = message.seal;
  if (typeof seal !== 'string' || seal.length === 0) return fail('missing seal');
  if (Buffer.byteLength(seal, 'utf8') > ENVELOPE_LIMITS.maxSealBytes) return fail('seal too large');

  const parts = seal.split('.');
  if (parts.length !== 5 || parts[0] !== SEAL_VERSION) return fail('malformed seal');
  const [, from, tsRaw, nonceHex, tag] = parts;

  if (from !== 'host' && from !== 'client') return fail('malformed seal direction');
  // Direction binding: accept only the OPPOSITE side. A rendezvous that bounces
  // our own sealed frame back at us hands us `from === localSide`; reject it
  // before spending a tag comparison. (The tag also covers `from`, so a forged
  // segment fails below even if this guard were bypassed — belt and braces.)
  if (from !== otherSide(localSide)) return fail('seal direction reflected to sender');

  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || ts <= 0) return fail('malformed seal timestamp');
  if (!/^[0-9a-f]{32}$/.test(nonceHex)) return fail('malformed seal nonce');

  const at = now();
  if (Math.abs(at - ts) > ENVELOPE_LIMITS.maxSkewMs) return fail('seal outside clock-skew window');

  const expected = Buffer.from(computeTag(message, from, ts, nonceHex, signalKey), 'utf8');
  const supplied = Buffer.from(tag, 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return fail('seal verification failed');
  }

  // Replay is checked AFTER the tag: only authentic frames may consume guard
  // capacity, so an attacker cannot flush real nonces with garbage.
  if (!replay.admit(nonceHex)) return fail('replayed seal');

  return { ok: true, message };
}

/**
 * Canonical tag input: length-prefixed fields, so no concatenation of
 * attacker-chosen strings can collide with another message's encoding.
 */
function computeTag(message: ValidSignal, from: SealSide, ts: number, nonceHex: string, signalKey: Buffer): string {
  const fields = [
    SEAL_VERSION,
    from,
    message.kind,
    message.sessionId,
    String(ts),
    nonceHex,
    message.sdp ?? '',
    message.candidate ?? '',
    message.reason ?? '',
  ];
  const canonical = fields.map((f) => `${Buffer.byteLength(f, 'utf8')}:${f}`).join('|');
  return createHmac('sha256', signalKey).update(canonical, 'utf8').digest('base64url');
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}
