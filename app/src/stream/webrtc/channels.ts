// The three WebRTC data channels and the policy that routes traffic onto them.
//
// Video and audio ride an SRTP media track. Everything else — input and control
// — rides one of three RTCDataChannels, each configured with the reliability its
// traffic actually needs. Getting this wrong is a class of bug the JPEG path
// cannot even express (it has one ordered reliable TCP stream for everything):
//
//   * a dropped key-UP on an unreliable channel is a STUCK KEY on the host, so
//     keys must be reliable and ordered;
//   * a retransmitted stale mouse delta is worse than a dropped one — newest
//     always wins — so pointer motion must be UNRELIABLE and unordered;
//   * config/resize, force-keyframe and ABR feedback are small and must arrive
//     in order, so they get their own reliable control channel rather than
//     queueing behind bursts of input.
//
// Pure data + a pure routing function, so the policy is tested (docs/
// PERFORMANCE-PLAN.md §5, M2) without a peer connection. The device layer reads
// CHANNELS to open the RTCDataChannels and calls channelFor() to pick one.

export type ChannelId = 'input' | 'cursor' | 'control' | 'audio';

/** An RTCDataChannelInit-compatible spec (the subset we set). `maxRetransmits: 0`
 *  with `ordered: false` is the unreliable/unordered "newest wins" mode. */
export interface ChannelSpec {
  readonly id: ChannelId;
  readonly ordered: boolean;
  /** Omitted = fully reliable. 0 = never retransmit (unreliable). */
  readonly maxRetransmits?: number;
  /** Human note on what rides here and why it is configured this way. */
  readonly rationale: string;
}

export const CHANNELS: Readonly<Record<ChannelId, ChannelSpec>> = Object.freeze({
  input: Object.freeze({
    id: 'input',
    ordered: true,
    rationale: 'reliable+ordered: key/click down-up and typed text — a dropped up-event is a stuck key',
  }),
  cursor: Object.freeze({
    id: 'cursor',
    ordered: false,
    maxRetransmits: 0,
    rationale: 'unreliable+unordered: high-rate pointer motion and scroll — newest wins, never resend a stale delta',
  }),
  control: Object.freeze({
    id: 'control',
    ordered: true,
    rationale: 'reliable+ordered: config/resize, force-keyframe, latency pings, ABR feedback',
  }),
  audio: Object.freeze({
    id: 'audio',
    ordered: false,
    maxRetransmits: 0,
    rationale: 'unreliable+unordered: 20 ms encoded audio frames — a retransmit that misses its '
      + 'playout deadline is wasted bandwidth; the jitter buffer (audio-jitter.ts) conceals the gap. '
      + 'Interim home for audio until it rides an SRTP media track.',
  }),
});

/** Every event kind the input/control layer emits. */
export type EventKind =
  // input (reliable)
  | 'key'
  | 'text'
  | 'click'
  | 'down'
  | 'up'
  // cursor (unreliable, newest-wins)
  | 'move'
  | 'scroll'
  // audio (unreliable, jitter-buffered)
  | 'audioframe'
  // control (reliable)
  | 'config'
  | 'keyframe'
  | 'ping'
  | 'stats';

const ROUTE: Readonly<Record<EventKind, ChannelId>> = Object.freeze({
  key: 'input',
  text: 'input',
  click: 'input',
  down: 'input',
  up: 'input',
  move: 'cursor',
  scroll: 'cursor',
  audioframe: 'audio',
  config: 'control',
  keyframe: 'control',
  ping: 'control',
  stats: 'control',
});

/**
 * Which channel an event kind belongs on. Unknown kinds route to the reliable
 * `control` channel: an unrecognised event is safer delivered-late than dropped,
 * and never silently lost — the fail-safe direction for a control surface.
 */
export function channelFor(kind: string): ChannelId {
  return (ROUTE as Record<string, ChannelId | undefined>)[kind] ?? 'control';
}

/** True when this channel never retransmits (the newest-wins path). */
export function isUnreliable(spec: ChannelSpec): boolean {
  return spec.maxRetransmits === 0 && spec.ordered === false;
}
