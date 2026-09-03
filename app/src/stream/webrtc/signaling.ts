// WebRTC signaling handshake — the pure state machine, no sockets.
//
// For the LAN/Tailscale-only slice there is no cloud rendezvous: the phone and
// host already hold a mutually-authenticated connection (the existing WS), and
// signaling is just SDP + ICE candidates relayed across it. This module owns the
// STATE of that handshake — who offers, what is a valid transition, when the
// negotiation has failed and must restart — while the transport layer owns the
// bytes.
//
// Split out as pure logic for the reason the screen-stream playtest made
// painfully clear: the old stream's failure handling was tangled into its socket
// callbacks, so half-open sockets never reconnected and a revoked peer retried
// forever. Here the lifecycle is a table that a test drives directly, and the
// terminal states are explicit rather than emergent.

export type SignalPhase =
  | 'idle'
  | 'offering'      // caller: local offer created, awaiting remote answer
  | 'answering'     // callee: remote offer applied, local answer being produced
  | 'negotiating'   // answer exchanged, ICE candidates flowing, not yet connected
  | 'connected'
  | 'failed'        // recoverable: restart negotiation
  | 'closed';       // terminal: peer gone / revoked / stopped, do not retry

export type SignalRole = 'caller' | 'callee';

/**
 * An ICE candidate as it crosses the wire and is handed to
 * `RTCPeerConnection.addIceCandidate`.
 *
 * WHY the extra two fields: addIceCandidate takes an init dict, and
 * react-native-webrtc (and every browser) REQUIRE at least one of `sdpMid` /
 * `sdpMLineIndex` to be non-null — the candidate string alone does not say which
 * m-line / media stream it belongs to. A bare `{ candidate }` throws TypeError
 * and the candidate is silently discarded, so trickle ICE can never complete.
 * They are therefore carried end-to-end: read off the local RTCIceCandidate when
 * sending, relayed on the wire, and passed through on receive.
 *
 * `sdpMid` is a string|null and `sdpMLineIndex` is a number|null (the same
 * nullability the browser RTCIceCandidate exposes); a candidate with BOTH null
 * is unusable and is rejected at the trust boundary in `receive`.
 */
export interface IceCandidatePayload {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** The wire messages, kept small and explicit — this is what crosses the WS. */
export type SignalMessage =
  | { readonly kind: 'offer'; readonly sdp: string; readonly sessionId: string }
  | { readonly kind: 'answer'; readonly sdp: string; readonly sessionId: string }
  | {
      readonly kind: 'ice';
      readonly candidate: string;
      // Present so the receiver can satisfy addIceCandidate's init-dict rule.
      // Optional on the type only for backward tolerance of frames from an older
      // peer that predates this fix; `receive` coerces missing -> null and then
      // rejects the frame if BOTH end up null.
      readonly sdpMid?: string | null;
      readonly sdpMLineIndex?: number | null;
      readonly sessionId: string;
    }
  | { readonly kind: 'bye'; readonly sessionId: string; readonly reason: string };

export interface SignalState {
  readonly phase: SignalPhase;
  readonly role: SignalRole;
  readonly sessionId: string;
  /** ICE candidates that arrived before the remote description was set. Held as
   *  full payloads (candidate + sdpMid/sdpMLineIndex) so the flush hands
   *  addIceCandidate a complete init dict. */
  readonly pendingRemoteCandidates: readonly IceCandidatePayload[];
}

/** Side effects the machine asks the transport to perform. Never executed here. */
export type SignalEffect =
  | { readonly do: 'create-offer' }
  | { readonly do: 'create-answer' }
  | { readonly do: 'set-remote'; readonly sdp: string; readonly type: 'offer' | 'answer' }
  | { readonly do: 'add-ice'; readonly candidate: IceCandidatePayload }
  | { readonly do: 'send'; readonly message: SignalMessage }
  | { readonly do: 'flush-candidates'; readonly candidates: readonly IceCandidatePayload[] }
  | { readonly do: 'teardown'; readonly reason: string };

export interface Transition {
  readonly state: SignalState;
  readonly effects: readonly SignalEffect[];
}

export function initialState(role: SignalRole, sessionId: string): SignalState {
  return { phase: 'idle', role, sessionId, pendingRemoteCandidates: [] };
}

/** The caller kicks off negotiation; the callee waits for an offer. */
export function begin(state: SignalState): Transition {
  if (state.phase !== 'idle' && state.phase !== 'failed') {
    return { state, effects: [] };
  }
  if (state.role === 'caller') {
    return { state: { ...state, phase: 'offering', pendingRemoteCandidates: [] }, effects: [{ do: 'create-offer' }] };
  }
  return { state: { ...state, phase: 'idle' }, effects: [] };
}

/** Our own offer/answer SDP came back from the peer connection: send it. */
export function localDescription(state: SignalState, type: 'offer' | 'answer', sdp: string): Transition {
  // A create-offer/create-answer that resolves AFTER the session was closed must
  // not send SDP or un-close the session.
  if (state.phase === 'closed') return { state, effects: [] };
  const message: SignalMessage = { kind: type, sdp, sessionId: state.sessionId };
  const nextPhase: SignalPhase = type === 'offer' ? 'offering' : 'negotiating';
  return { state: { ...state, phase: nextPhase }, effects: [{ do: 'send', message }] };
}

/**
 * Coerce an untrusted ICE wire frame into a candidate the peer connection will
 * actually accept, or return null to drop it.
 *
 * This is a trust boundary: the frame is attacker-controlled bytes off the WS,
 * so every field is type-checked rather than assumed. The critical rule is
 * addIceCandidate's: at least one of sdpMid / sdpMLineIndex must be non-null, or
 * the native call throws TypeError and the candidate is lost. Rejecting here —
 * instead of buffering or forwarding a doomed frame — keeps a malformed or
 * hostile peer from stalling negotiation with candidates that can never apply.
 */
export function coerceIceCandidate(message: SignalMessage & { readonly kind: 'ice' }): IceCandidatePayload | null {
  if (typeof message.candidate !== 'string' || message.candidate.length === 0) return null;

  // Missing (older peer) is treated as null; a wrong type is a rejection, not a
  // coercion — we never guess an m-line index.
  const sdpMid =
    message.sdpMid === undefined || message.sdpMid === null
      ? null
      : typeof message.sdpMid === 'string'
        ? message.sdpMid
        : undefined; // sentinel: present-but-wrong-type
  const sdpMLineIndex =
    message.sdpMLineIndex === undefined || message.sdpMLineIndex === null
      ? null
      : typeof message.sdpMLineIndex === 'number' && Number.isInteger(message.sdpMLineIndex) && message.sdpMLineIndex >= 0
        ? message.sdpMLineIndex
        : undefined; // sentinel: present-but-wrong-type

  if (sdpMid === undefined || sdpMLineIndex === undefined) return null; // wrong-typed field
  if (sdpMid === null && sdpMLineIndex === null) return null; // addIceCandidate needs at least one

  return { candidate: message.candidate, sdpMid, sdpMLineIndex };
}

/** A signaling message arrived from the peer. The heart of the machine. */
export function receive(state: SignalState, message: SignalMessage): Transition {
  // A closed session is terminal: a late or replayed message must never
  // resurrect it. This mirrors connectionStateChanged/restart/close.
  if (state.phase === 'closed') return { state, effects: [] };

  // A message for a different session is stale (an old negotiation, a late
  // duplicate). Ignoring it is what stops the "resurrected dead session" class
  // of bug the connect-lifecycle audit flagged.
  if ('sessionId' in message && message.sessionId !== state.sessionId) {
    return { state, effects: [] };
  }

  switch (message.kind) {
    case 'offer': {
      if (state.role !== 'callee') {
        // Glare: both sides offered. The caller is authoritative here (LAN
        // slice has a fixed initiator), so the callee ignores a stray offer.
        return { state, effects: [] };
      }
      return {
        state: { ...state, phase: 'answering', pendingRemoteCandidates: [] },
        effects: [
          { do: 'set-remote', sdp: message.sdp, type: 'offer' },
          // Candidates buffered before the offer arrived are added now, after the
          // remote description exists — dropping them intermittently fails
          // negotiation on a CGNAT path that rides an early srflx/relay candidate.
          { do: 'flush-candidates', candidates: state.pendingRemoteCandidates },
          { do: 'create-answer' },
        ],
      };
    }
    case 'answer': {
      if (state.role !== 'caller' || state.phase !== 'offering') {
        return { state, effects: [] };
      }
      return {
        state: { ...state, phase: 'negotiating', pendingRemoteCandidates: [] },
        effects: [
          { do: 'set-remote', sdp: message.sdp, type: 'answer' },
          { do: 'flush-candidates', candidates: state.pendingRemoteCandidates },
        ],
      };
    }
    case 'ice': {
      // Validate at the trust boundary: a frame with no usable sdpMid/
      // sdpMLineIndex (or a wrong-typed one) can never be handed to
      // addIceCandidate, so drop it rather than buffer or forward a doomed
      // candidate.
      const candidate = coerceIceCandidate(message);
      if (candidate === null) return { state, effects: [] };

      // Candidates can outrun the description they belong to. Buffer them until
      // the remote description exists, then the transport flushes on transition
      // to negotiating; adding to a peer connection with no remote description
      // throws.
      if (state.phase === 'offering' || state.phase === 'idle') {
        return {
          state: { ...state, pendingRemoteCandidates: [...state.pendingRemoteCandidates, candidate] },
          effects: [],
        };
      }
      return { state, effects: [{ do: 'add-ice', candidate }] };
    }
    case 'bye': {
      return { state: { ...state, phase: 'closed' }, effects: [{ do: 'teardown', reason: message.reason }] };
    }
  }
}

/**
 * The peer connection reported its ICE/connection state. This is where the
 * playtest lessons live: 'failed' is recoverable and restarts negotiation;
 * a caller re-offers, a callee waits. 'connected' latches. Nothing here retries
 * forever — a closed session stays closed.
 */
export function connectionStateChanged(
  state: SignalState,
  iceState: 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed',
): Transition {
  if (state.phase === 'closed') return { state, effects: [] };

  switch (iceState) {
    case 'connected':
    case 'completed':
      return { state: { ...state, phase: 'connected' }, effects: [] };
    case 'disconnected':
      // Transient: ICE may recover on its own. Do not tear down yet; a
      // subsequent 'failed' or a stall timer escalates.
      return { state, effects: [] };
    case 'failed':
      return restart(state);
    case 'closed':
      return { state: { ...state, phase: 'closed' }, effects: [{ do: 'teardown', reason: 'peer connection closed' }] };
  }
}

/** Explicit restart of a failed negotiation, bumping nothing that would loop. */
export function restart(state: SignalState): Transition {
  if (state.phase === 'closed') return { state, effects: [] };
  const cleared: SignalState = { ...state, phase: 'failed', pendingRemoteCandidates: [] };
  if (state.role === 'caller') {
    return { state: { ...cleared, phase: 'offering' }, effects: [{ do: 'create-offer' }] };
  }
  return { state: cleared, effects: [] };
}

/** Deliberate local stop (user left, revoked, tab closed). Terminal. */
export function close(state: SignalState, reason: string): Transition {
  if (state.phase === 'closed') return { state, effects: [] };
  return {
    state: { ...state, phase: 'closed' },
    effects: [
      { do: 'send', message: { kind: 'bye', sessionId: state.sessionId, reason } },
      { do: 'teardown', reason },
    ],
  };
}

export const isTerminal = (phase: SignalPhase): boolean => phase === 'closed';
