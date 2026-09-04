// Negotiating the BWP stream with the host.
//
// The pixels no longer come down the WebSocket — the socket's remaining job for
// video is to agree on where to send and with what key. That negotiation is
// pure message handling, so it lives here where it can be tested, rather than
// inside the effect that owns the socket.
//
// The ordering below is the part that must not be rearranged:
//
//   1. reserve a local UDP port
//   2. tell the host that port  (bwpStart)
//   3. host spawns the streamer and replies  (bwpOffer)
//   4. open the native session on the reserved port
//
// Binding after the offer arrives means the host's first frames land on a port
// nothing is listening to. They are simply lost, and the stream looks dead
// until the next keyframe rather than looking like the race it is.

/** What the host offers once its streamer is up. */
export interface BwpOffer {
  readonly port: number;
  readonly key: string;
  readonly salt: string;
  readonly width: number;
  readonly height: number;
  /** 'gpu' when the host is capturing zero-copy, 'cpu' otherwise. */
  readonly path: string;
}

export interface BwpStats {
  readonly fps: number;
  readonly kbps: number;
  readonly bitrate: number;
}

export type BwpMessage =
  | { readonly type: 'offer'; readonly offer: BwpOffer }
  | { readonly type: 'unavailable'; readonly error: string }
  | { readonly type: 'ended'; readonly error: string }
  | { readonly type: 'stats'; readonly stats: BwpStats }
  | { readonly type: 'bitrate'; readonly bps: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Read one host message relating to BWP, or null if it is not one.
 *
 * Every field is checked rather than cast. The host is trusted, but a host
 * running an older build is not the same as a host running this one, and a
 * missing `key` that arrives as `undefined` would be passed to the native layer
 * as the string "undefined" and fail somewhere far from the cause.
 */
export function parseBwpMessage(raw: unknown): BwpMessage | null {
  let msg: unknown = raw;
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(msg)) return null;

  switch (msg.type) {
    case 'bwpOffer': {
      const { port, key, salt, width, height, path } = msg;
      if (typeof port !== 'number' || port <= 0) return null;
      // A blank key or salt cannot produce a working session, and passing one
      // through would surface as "the video is black" instead of as the
      // negotiation failure it is.
      if (typeof key !== 'string' || key.length < 32) return null;
      if (typeof salt !== 'string' || salt.length !== 16) return null;
      return {
        type: 'offer',
        offer: {
          port,
          key,
          salt,
          width: typeof width === 'number' ? width : 0,
          height: typeof height === 'number' ? height : 0,
          path: typeof path === 'string' ? path : 'cpu',
        },
      };
    }
    case 'bwpUnavailable':
      return {
        type: 'unavailable',
        error: typeof msg.error === 'string' ? msg.error : 'the host cannot stream this way',
      };
    case 'bwpEnded':
      return {
        type: 'ended',
        error: typeof msg.error === 'string' ? msg.error : 'the stream ended',
      };
    case 'bwpStats':
      return {
        type: 'stats',
        stats: {
          fps: typeof msg.fps === 'number' ? msg.fps : 0,
          kbps: typeof msg.kbps === 'number' ? msg.kbps : 0,
          bitrate: typeof msg.bitrate === 'number' ? msg.bitrate : 0,
        },
      };
    case 'bwpBitrate':
      return { type: 'bitrate', bps: typeof msg.bps === 'number' ? msg.bps : 0 };
    default:
      return null;
  }
}

/** The message that asks the host to start streaming to us. */
export function buildBwpStart(localPort: number, preset: string, fps: number): string {
  return JSON.stringify({ type: 'bwpStart', port: localPort, preset, fps });
}

export function buildBwpStop(): string {
  return JSON.stringify({ type: 'bwpStop' });
}

/**
 * The host address to receive from, derived from the control socket's URL.
 *
 * Taken from the URL we already connected to rather than from anything the host
 * sends: the socket is the thing that was authenticated, and a host field in a
 * message would be a redirect we had no reason to honour.
 */
export function hostFromSocketUrl(url: string): string | null {
  // Hand-parsed because React Native's URL polyfill does not accept ws:// on
  // every platform, and a stream that works on one and not the other is worse
  // than one that works nowhere.
  const withoutScheme = url.replace(/^wss?:\/\//i, '');
  if (withoutScheme === url) return null; // not a websocket URL at all

  const authority = withoutScheme.split('/')[0];
  if (!authority) return null;

  // Bracketed IPv6 keeps its brackets stripped here; the native side re-adds
  // them when it builds the peer address.
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end > 1 ? authority.slice(1, end) : null;
  }
  const host = authority.split(':')[0];
  return host.length > 0 ? host : null;
}
