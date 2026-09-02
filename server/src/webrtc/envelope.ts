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
// Everything here is pure over (message, key, now), tested in
// webrtc-envelope.test.ts with tamper/replay/skew cases.

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

const SEAL_VERSION = 'v1';
const HKDF_SALT = 'belay-rendezvous-v1';

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

/** Seal one validated signaling message for transit through the rendezvous. */
export function sealSignal(
  message: ValidSignal,
  signalKey: Buffer,
  now: () => number = Date.now,
  nonce: Buffer = randomBytes(ENVELOPE_LIMITS.nonceBytes),
): ValidSignal & { readonly seal: string } {
  const ts = now();
  const nonceHex = nonce.toString('hex');
  const tag = computeTag(message, ts, nonceHex, signalKey);
  return { ...message, seal: `${SEAL_VERSION}.${ts}.${nonceHex}.${tag}` };
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
  now: () => number = Date.now,
): ValidationResult {
  const validated = validateSignal(input);
  if (!validated.ok) return validated;
  const message = validated.message;

  const seal = message.seal;
  if (typeof seal !== 'string' || seal.length === 0) return fail('missing seal');
  if (Buffer.byteLength(seal, 'utf8') > ENVELOPE_LIMITS.maxSealBytes) return fail('seal too large');

  const parts = seal.split('.');
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return fail('malformed seal');
  const [, tsRaw, nonceHex, tag] = parts;

  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || ts <= 0) return fail('malformed seal timestamp');
  if (!/^[0-9a-f]{32}$/.test(nonceHex)) return fail('malformed seal nonce');

  const at = now();
  if (Math.abs(at - ts) > ENVELOPE_LIMITS.maxSkewMs) return fail('seal outside clock-skew window');

  const expected = Buffer.from(computeTag(message, ts, nonceHex, signalKey), 'utf8');
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
function computeTag(message: ValidSignal, ts: number, nonceHex: string, signalKey: Buffer): string {
  const fields = [
    SEAL_VERSION,
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
