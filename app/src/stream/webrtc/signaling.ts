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

/** The wire messages, kept small and explicit — this is what crosses the WS. */
export type SignalMessage =
  | { readonly kind: 'offer'; readonly sdp: string; readonly sessionId: string }
  | { readonly kind: 'answer'; readonly sdp: string; readonly sessionId: string }
  | { readonly kind: 'ice'; readonly candidate: string; readonly sessionId: string }
  | { readonly kind: 'bye'; readonly sessionId: string; readonly reason: string };

export interface SignalState {
  readonly phase: SignalPhase;
  readonly role: SignalRole;
  readonly sessionId: string;
  /** ICE candidates that arrived before the remote description was set. */
  readonly pendingRemoteCandidates: readonly string[];
}

/** Side effects the machine asks the transport to perform. Never executed here. */
export type SignalEffect =
  | { readonly do: 'create-offer' }
  | { readonly do: 'create-answer' }
  | { readonly do: 'set-remote'; readonly sdp: string; readonly type: 'offer' | 'answer' }
  | { readonly do: 'add-ice'; readonly candidate: string }
  | { readonly do: 'send'; readonly message: SignalMessage }
  | { readonly do: 'flush-candidates' }
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
  const message: SignalMessage = { kind: type, sdp, sessionId: state.sessionId };
  const nextPhase: SignalPhase = type === 'offer' ? 'offering' : 'negotiating';
  return { state: { ...state, phase: nextPhase }, effects: [{ do: 'send', message }] };
}

/** A signaling message arrived from the peer. The heart of the machine. */
export function receive(state: SignalState, message: SignalMessage): Transition {
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
          { do: 'create-answer' },
        ],
      };
    }
    case 'answer': {
      if (state.role !== 'caller' || state.phase !== 'offering') {
        return { state, effects: [] };
      }
      return {
        state: { ...state, phase: 'negotiating' },
        effects: [
          { do: 'set-remote', sdp: message.sdp, type: 'answer' },
          { do: 'flush-candidates' },
        ],
      };
    }
    case 'ice': {
      // Candidates can outrun the description they belong to. Buffer them until
      // the remote description exists, then the transport flushes on transition
      // to negotiating; adding to a peer connection with no remote description
      // throws.
      if (state.phase === 'offering' || state.phase === 'idle') {
        return {
          state: { ...state, pendingRemoteCandidates: [...state.pendingRemoteCandidates, message.candidate] },
          effects: [],
        };
      }
      return { state, effects: [{ do: 'add-ice', candidate: message.candidate }] };
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
