// The react-native-webrtc PeerAdapter: the bridge between StreamSession's pure
// controller and a real RTCPeerConnection on the phone (the ICE caller).
//
// STATUS: the MAPPING logic in this file (PeerAdapter <-> RTCPeerConnection API,
// data-channel routing, the ABR setpoint -> RTCRtpSender.setParameters path) is
// pure JS and IS unit-tested with a fake peer connection (peer-adapter.test.mjs).
// What is HARDWARE-GATED is only the real native module: react-native-webrtc is
// a native module that cannot run in Expo Go or the web build, so the actual
// ICE/DTLS/SRTP, the display/media track, and the real glass-to-glass number
// need `expo prebuild && expo run:ios` on a dev-client + a phone. See the
// runbook in docs/WEBRTC-SLICE.md. This file therefore takes the peer connection
// as an INJECTED dependency (a structural RTCPeerConnection) rather than
// importing react-native-webrtc, so it compiles and is tested headless while the
// off-limits screen component supplies `new RTCPeerConnection(config)` from the
// native module at mount.

import { CHANNELS, channelFor, type ChannelId, type ChannelSpec } from './channels.ts';
import type { PeerAdapter } from './session.ts';
import type { IceCandidatePayload, SignalMessage } from './signaling.ts';

// ── the minimal structural surface we use from react-native-webrtc ──────────
// (kept local so this file needs no @types and no installed native module.)

export interface RTCSessionDescriptionInit {
  readonly type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  readonly sdp?: string;
}

export interface RTCIceCandidateInit {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export interface DataChannelLike {
  readonly label: string;
  /** react-native-webrtc accepts strings and binary; audio frames are binary. */
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface RTCRtpSenderLike {
  readonly track?: { readonly kind: string } | null;
  getParameters(): { encodings?: Array<{ maxBitrate?: number }> };
  setParameters(parameters: { encodings?: Array<{ maxBitrate?: number }> }): Promise<void>;
}

export interface PeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }): DataChannelLike;
  getSenders(): RTCRtpSenderLike[];
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}

/** How the adapter reaches the outside world: it sends signaling messages over
 *  the authenticated WS (the same transport the JPEG path uses) and reports the
 *  peer connection's ICE/connection state back to the controller. */
export interface PeerAdapterDeps {
  readonly pc: PeerConnectionLike;
  readonly sessionId: string;
  /** Send one signaling message to the host over the WS (-> /ws/webrtc). */
  send(message: SignalMessage): void;
  /** The peer connection changed ICE/connection state; hand it to
   *  StreamSession.onConnectionState. */
  onConnectionState(state: 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed'): void;
}

/** RTCDataChannelInit derived from a channels.ts spec — the only place the pure
 *  policy is turned into a real data-channel configuration. */
export function dataChannelInit(spec: ChannelSpec): { ordered: boolean; maxRetransmits?: number } {
  return spec.maxRetransmits === undefined
    ? { ordered: spec.ordered }
    : { ordered: spec.ordered, maxRetransmits: spec.maxRetransmits };
}

/** Map react-native-webrtc's connectionState string to the subset StreamSession
 *  understands, collapsing the ones it treats identically. */
export function mapConnectionState(
  state: string,
): 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed' | null {
  switch (state) {
    case 'connected': return 'connected';
    case 'completed': return 'completed';
    case 'disconnected': return 'disconnected';
    case 'failed': return 'failed';
    case 'closed': return 'closed';
    default: return null; // 'new' / 'connecting' — nothing for the controller to do
  }
}

/**
 * Build the adapter. Opens the data channels from channels.ts, wires the
 * peer connection's local-ICE and connection-state events back to the
 * controller, and implements every PeerAdapter operation as exactly one
 * RTCPeerConnection call.
 */
export function createPeerAdapter(deps: PeerAdapterDeps): PeerAdapter {
  const { pc, sessionId } = deps;

  // Open the data channels up front so both peers agree on them during
  // negotiation. The caller opens them; the callee receives them via
  // 'datachannel'. Keyed by id for sendOn().
  const channels = new Map<ChannelId, DataChannelLike>();
  for (const spec of Object.values(CHANNELS)) {
    channels.set(spec.id, pc.createDataChannel(spec.id, dataChannelInit(spec)));
  }

  // Local candidates as they gather -> relay to the host over the WS. We carry
  // sdpMid/sdpMLineIndex straight off the RTCIceCandidate: the remote peer needs
  // at least one of them to hand the candidate to addIceCandidate (a bare
  // candidate string throws TypeError there and is discarded), so stripping them
  // on send is what breaks trickle ICE on a real device.
  pc.addEventListener('icecandidate', (event) => {
    const candidate = (
      event as {
        candidate?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null;
      }
    ).candidate;
    if (candidate && candidate.candidate) {
      deps.send({
        kind: 'ice',
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        sessionId,
      });
    }
    // A null candidate is end-of-gathering; nothing to relay.
  });

  pc.addEventListener('connectionstatechange', () => {
    const mapped = mapConnectionState((pc as unknown as { connectionState?: string }).connectionState ?? '');
    if (mapped) deps.onConnectionState(mapped);
  });

  return {
    async createOffer(): Promise<string> {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return offer.sdp ?? '';
    },
    async createAnswer(): Promise<string> {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return answer.sdp ?? '';
    },
    async setRemoteDescription(sdp: string, type: 'offer' | 'answer'): Promise<void> {
      await pc.setRemoteDescription({ type, sdp });
    },
    async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
      // Pass sdpMid/sdpMLineIndex through unchanged: addIceCandidate requires an
      // init dict with at least one of them non-null (the signaling layer has
      // already rejected frames carrying neither), so we must NOT collapse to a
      // bare { candidate } here.
      await pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    },
    send(message: SignalMessage): void {
      deps.send(message);
    },
    teardown(_reason: string): void {
      for (const channel of channels.values()) {
        try { channel.close(); } catch { /* already gone */ }
      }
      pc.close();
    },
    setBitrate(bitrateBps: number): void {
      // Drive the sender's max bitrate; the negotiated encoder (VideoToolbox /
      // Media Foundation on the host) tracks it. Best-effort: a sender may not
      // exist yet before the track is added.
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) return;
      const params = sender.getParameters();
      const encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];
      encodings[0] = { ...encodings[0], maxBitrate: bitrateBps };
      void sender.setParameters({ ...params, encodings }).catch(() => { /* transient */ });
    },
    sendOn(channel: ChannelId, kind: string, payload: unknown): void {
      // The channel is decided by the pure policy; this only serializes onto it,
      // failing safe onto control if the requested channel is somehow absent.
      const target = channels.get(channel) ?? channels.get(channelFor(kind)) ?? channels.get('control');
      target?.send(JSON.stringify({ kind, payload }));
    },
    sendBytesOn(channel: ChannelId, bytes: Uint8Array): void {
      // Binary path for audio wire frames (audio-frames.ts): the frame IS the
      // message, so nothing is serialized around it. No control fallback here —
      // late audio on a reliable channel is worse than dropped audio.
      channels.get(channel)?.send(bytes);
    },
  };
}
