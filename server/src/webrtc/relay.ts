// Host-side signaling validation and relay for the LAN/Tailscale WebRTC slice.
//
// There is no cloud rendezvous here: the phone and host already share an
// authenticated WebSocket, so signaling is just SDP + ICE relayed across it. The
// host's job at this boundary is not to interpret the SDP — it never parses the
// media — but to VALIDATE the envelope before it reaches the peer-connection
// layer, because everything crossing this socket is attacker-controlled the
// moment a device is paired.
//
// Pure functions over the message shape, so the WS handler stays thin and the
// rules are tested directly. Mirrors the discipline the JPEG path's input
// validation already follows.

/** Caps sized for real SDP/ICE, small enough that a flood can't exhaust memory.
 *  A full offer with a couple of media sections is a few KB; 64KB is generous. */
export const SIGNAL_LIMITS = Object.freeze({
  maxSdpBytes: 64 * 1024,
  maxCandidateBytes: 1024,
  /** An m-line media id ("audio"/"video"/"0"…) — a handful of bytes; capped
   *  well above any real value so a hostile frame can't smuggle bulk here. */
  maxSdpMidBytes: 64,
  /** m-line index: a session has at most a few media sections. */
  maxSdpMLineIndex: 128,
  maxReasonBytes: 256,
  maxSessionIdBytes: 128,
  /** Optional end-to-end seal (envelope.ts) for signaling that crosses the
   *  cloud rendezvous. Opaque at this layer; capped so it cannot be abused as
   *  a bulk side channel. Mirrored in infra/rendezvous/src/signal.ts. */
  maxSealBytes: 512,
});

export type SignalKind = 'offer' | 'answer' | 'ice' | 'bye';

export interface ValidSignal {
  readonly kind: SignalKind;
  readonly sessionId: string;
  readonly sdp?: string;
  readonly candidate?: string;
  /** ICE identification: the receiver needs at least one of these to satisfy
   *  RTCPeerConnection.addIceCandidate's init-dict rule, so the relay must
   *  carry them through rather than strip them. */
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly reason?: string;
  /** End-to-end authenticity seal — verified by envelope.ts on the cloud
   *  path, absent and unused on the LAN path. */
  readonly seal?: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly message: ValidSignal }
  | { readonly ok: false; readonly error: string };

/**
 * Validates one decoded signaling message. Rejects unknown kinds, missing or
 * oversized fields, and a session id that isn't a plain token — never throws, so
 * a malformed frame is a clean 4xx-equivalent rejection rather than a crash
 * (the unauthenticated-WS-upgrade DoS the playtest found came from exactly this
 * kind of unguarded parse).
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
      // Carry the ICE identification through. Either may be null (WebRTC allows
      // one absent), but the two are all that lets the far peer add the
      // candidate — dropping them here silently broke trickle ICE end to end.
      const sdpMid = typeof msg.sdpMid === 'string' ? msg.sdpMid : null;
      if (typeof msg.sdpMid === 'string' && byteLen(msg.sdpMid) > SIGNAL_LIMITS.maxSdpMidBytes) {
        return fail('sdpMid too large');
      }
      const sdpMLineIndex = typeof msg.sdpMLineIndex === 'number' && Number.isInteger(msg.sdpMLineIndex)
        && msg.sdpMLineIndex >= 0 && msg.sdpMLineIndex <= SIGNAL_LIMITS.maxSdpMLineIndex
        ? msg.sdpMLineIndex
        : null;
      return ok({ kind, sessionId, candidate: msg.candidate, sdpMid, sdpMLineIndex, seal });
    }
    case 'bye': {
      const reason = typeof msg.reason === 'string' ? truncateBytes(msg.reason, SIGNAL_LIMITS.maxReasonBytes) : '';
      return ok({ kind, sessionId, reason, seal });
    }
  }
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point
 *  or emitting a lone surrogate — String.slice counts UTF-16 units, which let up
 *  to 4x the intended bytes through. */
function truncateBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  // Decoding with fatal:false replaces a trailing partial code point with U+FFFD;
  // trim that so a caller never receives a stray replacement char.
  return new TextDecoder('utf-8').decode(buf).replace(/\uFFFD+$/, '');
}

function byteLen(s: string): number {
  // Bytes, not UTF-16 code units — a caps check on .length lets a multibyte
  // payload slip past the intended memory bound.
  return Buffer.byteLength(s, 'utf8');
}

function ok(message: ValidSignal): ValidationResult {
  return { ok: true, message };
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}
