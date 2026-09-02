// Signaling envelope validation at the rendezvous boundary.
//
// MIRRORS server/src/webrtc/relay.ts — same wire shapes, same caps, kept in
// sync by hand (the packages deliberately share no build). The rendezvous is a
// separate deployable with a hostile-by-default input surface: every frame that
// arrives here came off the public internet, so the same validate-before-touch
// discipline the host applies to a paired device applies here to everyone.
//
// The rendezvous validates ONLY the outer envelope: kind, sessionId, size caps.
// It never interprets the SDP, and it never sees — let alone verifies — the
// end-to-end `seal` that the host and client attach to each message
// (server/src/webrtc/envelope.ts). That seal is deliberately opaque bytes to
// this process: an honest-but-curious or fully compromised rendezvous can drop
// or misroute signaling, but it cannot forge a message either peer will accept.

/** Caps sized for real SDP/ICE, small enough that a flood can't exhaust memory. */
export const SIGNAL_LIMITS = Object.freeze({
  maxSdpBytes: 64 * 1024,
  maxCandidateBytes: 1024,
  maxReasonBytes: 256,
  maxSessionIdBytes: 128,
  /** The end-to-end seal (ts + nonce + HMAC tag) is opaque here; cap it so it
   *  cannot be abused as a bulk side channel through the relay. */
  maxSealBytes: 512,
});

export type SignalKind = 'offer' | 'answer' | 'ice' | 'bye';

export interface ValidSignal {
  readonly kind: SignalKind;
  readonly sessionId: string;
  readonly sdp?: string;
  readonly candidate?: string;
  readonly reason?: string;
  /** Opaque end-to-end authenticity seal, relayed verbatim, never verified here. */
  readonly seal?: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly message: ValidSignal }
  | { readonly ok: false; readonly error: string };

/**
 * Validates one decoded signaling message. Rejects unknown kinds, missing or
 * oversized fields, and a session id that isn't a plain token — never throws.
 */
export function validateSignal(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return fail('signal is not an object');
  const msg = input as Record<string, unknown>;

  const kind = msg.kind;
  if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice' && kind !== 'bye') {
    return fail(`unknown signal kind: ${String(kind)}`);
  }

  const sessionId = msg.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return fail('missing sessionId');
  if (byteLen(sessionId) > SIGNAL_LIMITS.maxSessionIdBytes) return fail('sessionId too long');
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return fail('sessionId has illegal characters');

  let seal: string | undefined;
  if (msg.seal !== undefined) {
    if (typeof msg.seal !== 'string' || msg.seal.length === 0) return fail('seal is not a string');
    if (byteLen(msg.seal) > SIGNAL_LIMITS.maxSealBytes) return fail('seal too large');
    seal = msg.seal;
  }

  switch (kind) {
    case 'offer':
    case 'answer': {
      if (typeof msg.sdp !== 'string' || msg.sdp.length === 0) return fail(`${kind} missing sdp`);
      if (byteLen(msg.sdp) > SIGNAL_LIMITS.maxSdpBytes) return fail('sdp too large');
      return ok({ kind, sessionId, sdp: msg.sdp, seal });
    }
    case 'ice': {
      if (typeof msg.candidate !== 'string' || msg.candidate.length === 0) return fail('ice missing candidate');
      if (byteLen(msg.candidate) > SIGNAL_LIMITS.maxCandidateBytes) return fail('candidate too large');
      return ok({ kind, sessionId, candidate: msg.candidate, seal });
    }
    case 'bye': {
      const reason = typeof msg.reason === 'string' ? truncateBytes(msg.reason, SIGNAL_LIMITS.maxReasonBytes) : '';
      return ok({ kind, sessionId, reason, seal });
    }
  }
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8').decode(buf).replace(/�+$/, '');
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function ok(message: ValidSignal): ValidationResult {
  return { ok: true, message };
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}
