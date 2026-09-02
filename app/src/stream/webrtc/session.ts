// StreamSession — the orchestration seam between the pure signaling state
// machine and a real peer connection.
//
// The device layer owns exactly one thing: an RTCPeerConnection and a transport
// to send signaling bytes. Everything else — when to offer, how to buffer ICE,
// what a failure means, how latency and the direct/relayed ratio are tallied —
// lives here and in the pure modules it composes, so the device file stays a
// thin adapter and the whole controller is testable with a fake peer connection.
//
// The adapter is injected (not a concrete RTCPeerConnection) precisely so this
// runs under the test runner: a fake adapter records what the controller asked
// it to do, and the assertions pin the wiring without a browser.

import { IceStats, candidateType, classifyPair, type ConnectionKind } from './ice.ts';
import { LatencyWindow, type FrameTiming } from './latency.ts';
import {
  begin, close, connectionStateChanged, initialState, isTerminal,
  localDescription, receive,
  type SignalEffect, type SignalMessage, type SignalRole, type SignalState, type Transition,
} from './signaling.ts';

/** What the device layer must provide. Each call maps to one RTCPeerConnection
 *  operation; none of them are performed here. */
export interface PeerAdapter {
  createOffer(): Promise<string>;
  createAnswer(): Promise<string>;
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>;
  addIceCandidate(candidate: string): Promise<void>;
  send(message: SignalMessage): void;
  teardown(reason: string): void;
}

export interface SessionCallbacks {
  onPhaseChange?(phase: SignalState['phase']): void;
  onError?(message: string): void;
}

export class StreamSession {
  private state: SignalState;
  private readonly latency = new LatencyWindow();
  private readonly ice = new IceStats();
  private clockOffsetMs = 0;
  /** Local candidate type of the selected pair, held until the remote type is
   *  known so the pair can be classified once, on connect. */
  private localSelected: ReturnType<typeof candidateType> | null = null;
  private remoteSelected: ReturnType<typeof candidateType> | null = null;

  private readonly peer: PeerAdapter;
  private readonly cb: SessionCallbacks;

  constructor(
    role: SignalRole,
    sessionId: string,
    peer: PeerAdapter,
    cb: SessionCallbacks = {},
  ) {
    this.peer = peer;
    this.cb = cb;
    this.state = initialState(role, sessionId);
  }

  get phase(): SignalState['phase'] {
    return this.state.phase;
  }

  /** Kick the handshake off (caller offers, callee waits). */
  async start(): Promise<void> {
    await this.apply(begin(this.state));
  }

  /** A signaling message arrived from the peer over the transport. */
  async onSignal(message: SignalMessage): Promise<void> {
    await this.apply(receive(this.state, message));
  }

  /** The peer connection reported an ICE/connection-state change. */
  async onConnectionState(
    iceState: 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed',
  ): Promise<void> {
    await this.apply(connectionStateChanged(this.state, iceState));
  }

  /** Stop deliberately (user left / revoked). Terminal. */
  async stop(reason: string): Promise<void> {
    await this.apply(close(this.state, reason));
  }

  setClockOffset(ms: number): void {
    this.clockOffsetMs = ms;
  }

  /** Record a presented frame for glass-to-glass accounting. */
  recordFrame(frame: FrameTiming): void {
    this.latency.add(frame, this.clockOffsetMs);
  }

  /** Note the selected candidate pair's types so the session's routing (direct
   *  vs relayed) is tallied exactly once, when it connects. */
  noteSelectedPair(local: string, remote: string): void {
    this.localSelected = candidateType(local);
    this.remoteSelected = candidateType(remote);
  }

  metrics(): SessionMetrics {
    const local = this.localSelected;
    const remote = this.remoteSelected;
    const kind: ConnectionKind | null = local && remote ? classifyPair(local, remote) : null;
    return {
      phase: this.state.phase,
      latency: this.latency.snapshot(),
      connectionKind: kind,
      iceTotals: this.ice.snapshot(),
    };
  }

  // ── the effect interpreter: pure Transition -> real adapter calls ──────────

  private async apply(transition: Transition): Promise<void> {
    const phaseChanged = transition.state.phase !== this.state.phase;
    this.state = transition.state;
    for (const effect of transition.effects) {
      await this.run(effect);
    }
    // Tally routing the moment the session connects, from the pair already noted.
    if (phaseChanged && this.state.phase === 'connected' && this.localSelected && this.remoteSelected) {
      this.ice.recordPair(this.localSelected, this.remoteSelected);
    }
    if (phaseChanged) this.cb.onPhaseChange?.(this.state.phase);
  }

  private async run(effect: SignalEffect): Promise<void> {
    try {
      switch (effect.do) {
        case 'create-offer': {
          const sdp = await this.peer.createOffer();
          await this.apply(localDescription(this.state, 'offer', sdp));
          break;
        }
        case 'create-answer': {
          const sdp = await this.peer.createAnswer();
          await this.apply(localDescription(this.state, 'answer', sdp));
          break;
        }
        case 'set-remote':
          await this.peer.setRemoteDescription(effect.sdp, effect.type);
          break;
        case 'add-ice':
          await this.peer.addIceCandidate(effect.candidate);
          break;
        case 'flush-candidates':
          for (const candidate of this.state.pendingRemoteCandidates) {
            await this.peer.addIceCandidate(candidate);
          }
          break;
        case 'send':
          this.peer.send(effect.message);
          break;
        case 'teardown':
          this.peer.teardown(effect.reason);
          break;
      }
    } catch (error) {
      // An adapter failure must not wedge the controller: surface it and let the
      // connection-state path (or the caller) drive recovery, rather than
      // throwing out of a signaling callback the way the old stream did.
      this.cb.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  get isTerminal(): boolean {
    return isTerminal(this.state.phase);
  }
}

export interface SessionMetrics {
  readonly phase: SignalState['phase'];
  readonly latency: ReturnType<LatencyWindow['snapshot']>;
  readonly connectionKind: ConnectionKind | null;
  readonly iceTotals: ReturnType<IceStats['snapshot']>;
}
