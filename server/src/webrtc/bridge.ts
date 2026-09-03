// The host's signaling-only relay: a validated bridge between the two peers of
// one WebRTC session.
//
// In the LAN/Tailscale slice there is no cloud rendezvous. The phone (the ICE
// *caller*) already holds an authenticated WebSocket to the host; the host's
// native helper is the ICE *callee* and owns the real peer connection. Node sees
// neither the media nor the encoder — it only shuttles SDP/ICE between those two
// peers, and its single job at this boundary is to VALIDATE every frame (via
// relay.ts) before it reaches the peer-connection layer, because everything
// crossing the socket is attacker-controlled the moment a device is paired.
//
// This module is that shuttle, expressed as pure forwarding over two sinks so it
// is exercised end-to-end under the test runner with fake peers — no sockets, no
// RTCPeerConnection, no GPU. The `/ws/webrtc` route in index.ts wires the real
// sinks (WebSocket one side, the native helper the other); the integration test
// wires two real StreamSessions.

import { validateSignal, type ValidSignal, type ValidationResult } from './relay.js';

/** Which peer a frame came from. `client` = the phone over the WS; `host` = the
 *  native helper (the callee peer). */
export type RelaySide = 'client' | 'host';

/** A destination toward one peer. `deliver` is handed only messages that have
 *  already passed `validateSignal`, so a sink never re-validates. */
export interface SignalSink {
  deliver(message: ValidSignal): void;
}

/**
 * Bridges exactly two peers of one session. It is deliberately 1:1 and
 * session-scoped: a `/ws/webrtc` connection creates one bridge binding that
 * socket to the helper, and it is thrown away when either side goes.
 *
 * The bridge binds a session id the first time it sees a valid frame (or is
 * given one up front from the upgrade URL); any later frame carrying a different
 * id is rejected as stale rather than forwarded. That is the exact
 * "resurrected dead session" guard the connect-lifecycle audit flagged, applied
 * at the relay instead of only inside the client state machine.
 */
export class SignalingBridge {
  private closed = false;
  private boundSessionId: string | null;

  constructor(
    private readonly toClient: SignalSink,
    private readonly toHost: SignalSink,
    sessionId?: string,
  ) {
    this.boundSessionId = sessionId ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The session this bridge is pinned to, or null before the first frame. */
  get sessionId(): string | null {
    return this.boundSessionId;
  }

  /**
   * A raw frame arrived from one peer. Validate it, enforce the session
   * binding, and forward the validated message to the OPPOSITE peer. Never
   * throws — a malformed or stale frame is a clean rejection the caller logs,
   * never a crash (the unauthenticated-parse DoS class the playtest found).
   *
   * A `bye` is forwarded and then closes the bridge: it is terminal for the
   * session, mirroring the client state machine's terminal `closed` phase.
   */
  ingest(from: RelaySide, raw: unknown): ValidationResult {
    if (this.closed) return { ok: false, error: 'session already closed' };

    const result = validateSignal(raw);
    if (!result.ok) return result;

    const { sessionId } = result.message;
    if (this.boundSessionId === null) {
      // Only the client — the authenticated phone that opened this socket — may
      // establish the binding. A host push is broadcast to every /ws/webrtc
      // bridge; if an as-yet-unbound bridge were allowed to adopt the first
      // host frame it saw, it would bind to (and then forward) another
      // session's answer/ICE. The client always speaks first (it is the ICE
      // caller), so a host frame before that is simply not ours to route.
      if (from === 'host') {
        return { ok: false, error: 'host signal before the session is bound' };
      }
      this.boundSessionId = sessionId;
    } else if (sessionId !== this.boundSessionId) {
      return { ok: false, error: `stale session '${sessionId}' (bridge is bound to '${this.boundSessionId}')` };
    }

    const target = from === 'client' ? this.toHost : this.toClient;
    target.deliver(result.message);

    if (result.message.kind === 'bye') this.close();
    return result;
  }

  /** Tear the bridge down. Idempotent; further ingest is rejected. */
  close(): void {
    this.closed = true;
  }
}
