// When to ask for the H.264 stream, and when to give it up.
//
// BWP is the default whenever it can work: the host advertises it on /health,
// this build has the native receiver, and a UDP port was reserved. Everything
// that can go wrong after that — a host that refuses, a firewall eating the
// UDP packets, a decoder that never shows a frame — must drop back to JPEG
// over the WebSocket on its own, because a black screen with a working
// control socket looks to a user exactly like a broken app.
//
// Pure and react-free so every branch can be tested without a socket.

export type BwpPreference = 'auto' | 'on' | 'off';

/** How long an offered stream may go without a decoded frame. */
export const BWP_FIRST_FRAME_TIMEOUT_MS = 3000;

/** After a failure, how long auto mode stays on JPEG before asking again. */
export const BWP_RETRY_AFTER_MS = 60_000;

export type BwpSkipReason = 'off' | 'no-native' | 'no-port' | 'host-unsupported' | 'cooling-down';

/** Why the stream fell back after having been asked for. */
export type BwpFallbackReason = 'timeout' | 'refused' | 'ended' | 'decoder';

export type BwpDecision =
  | { readonly request: true }
  | { readonly request: false; readonly reason: BwpSkipReason };

export interface BwpDecisionInputs {
  readonly preference: BwpPreference;
  readonly gaming: boolean;
  readonly nativeAvailable: boolean;
  readonly reservedPort: number;
  /** The host's /health flag; undefined from a host too old to report one. */
  readonly hostBwp: boolean | undefined;
  /** When BWP last failed on this connection (epoch ms), or null. */
  readonly lastFailureAt: number | null;
  readonly now: number;
}

/** Whether to send `bwpStart` on this socket open. */
export function shouldRequestBwp(i: BwpDecisionInputs): BwpDecision {
  if (!i.nativeAvailable) return { request: false, reason: 'no-native' };
  if (i.reservedPort <= 0) return { request: false, reason: 'no-port' };
  if (i.preference === 'off') return { request: false, reason: 'off' };
  if (i.preference === 'on') return { request: true };
  // A host that never reported the flag is asked anyway: an old host ignores
  // an unknown message, so the worst case is the JPEG stream it was going to
  // send regardless.
  if (i.hostBwp === false) return { request: false, reason: 'host-unsupported' };
  if (!i.gaming && i.lastFailureAt !== null && i.now - i.lastFailureAt < BWP_RETRY_AFTER_MS) {
    return { request: false, reason: 'cooling-down' };
  }
  return { request: true };
}

/**
 * Liveness of an offered stream. Every transition returns a new value.
 *
 * `hostSendingSince` is when the host first reported a non-zero frame rate
 * after our last decoded frame. It matters because an idle desktop
 * legitimately sends nothing — the streamer skips unchanged frames — so
 * silence alone is not a fault. Silence while the host says it is sending is.
 */
export interface BwpHealth {
  readonly offeredAt: number;
  readonly lastDecodedAt: number | null;
  readonly hostSendingSince: number | null;
}

export const bwpOffered = (now: number): BwpHealth =>
  Object.freeze({ offeredAt: now, lastDecodedAt: null, hostSendingSince: null });

/** A frame reached the display: whatever the host was sending is arriving. */
export const bwpDecoded = (h: BwpHealth, now: number): BwpHealth =>
  Object.freeze({ ...h, lastDecodedAt: now, hostSendingSince: null });

/** The host reported encoding frames during the last second. */
export const bwpHostSent = (h: BwpHealth, now: number): BwpHealth =>
  Object.freeze({ ...h, hostSendingSince: h.hostSendingSince ?? now });

/** True when the stream should be abandoned for JPEG. */
export function bwpStalled(h: BwpHealth, now: number): boolean {
  if (h.lastDecodedAt === null) return now - h.offeredAt >= BWP_FIRST_FRAME_TIMEOUT_MS;
  if (h.hostSendingSince === null) return false;
  return now - h.hostSendingSince >= BWP_FIRST_FRAME_TIMEOUT_MS;
}

/** The `bwp` flag from a /health or /screen/info body, read strictly. */
export function readBwpCapability(body: unknown): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const flag = (body as Record<string, unknown>).bwp;
  return typeof flag === 'boolean' ? flag : undefined;
}

const REASON_TEXT: Readonly<Record<BwpSkipReason | BwpFallbackReason, string>> = Object.freeze({
  off: 'H.264 is switched off',
  'no-native': 'this build has no H.264 receiver',
  'no-port': 'no UDP port could be reserved',
  'host-unsupported': 'the host cannot stream H.264',
  'cooling-down': 'H.264 failed recently; retrying later',
  timeout: 'no H.264 frames arrived',
  refused: 'the host refused to start H.264',
  ended: 'the H.264 stream ended',
  decoder: 'the H.264 decoder failed',
});

export function fallbackReasonText(reason: BwpSkipReason | BwpFallbackReason): string {
  return REASON_TEXT[reason];
}
