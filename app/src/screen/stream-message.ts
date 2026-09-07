// The JSON and binary envelopes on the `/ws/screen` socket.
//
// Split from stream.ts so the untrusted-input parsing is a pure module the
// node test runner can import without React.

import { numberOf } from './model.ts';
import { bytesToBase64, decodeBinaryFrame, isBinaryFramePayload } from './frame-codec.ts';

export interface FramePayload {
  readonly data: string;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
  readonly bytes: number;
}

export type StreamMessage =
  | { readonly type: 'frame'; readonly frame: FramePayload }
  | { readonly type: 'error'; readonly error: string };

/**
 * Parses an untrusted socket payload. Returns null for anything unrecognised.
 *
 * Two wire shapes arrive on one socket. A binary message is a pixel frame in
 * the compact layout of frame-codec.ts (the host only sends these once we ask
 * with `?bin=1`, so an old host that keeps sending JSON still works); a string
 * is the JSON envelope — still the carrier for errors and, from old hosts,
 * for frames. The codec bounds-checks every header field before slicing, so a
 * malformed or truncated buffer degrades to "unrecognised", never a crash.
 */
export function parseStreamMessage(raw: unknown): StreamMessage | null {
  if (isBinaryFramePayload(raw)) {
    const decoded = decodeBinaryFrame(raw);
    if (!decoded) return null;
    return {
      type: 'frame',
      frame: {
        data: bytesToBase64(decoded.jpeg),
        w: decoded.w,
        h: decoded.h,
        sw: decoded.sw,
        sh: decoded.sh,
        bytes: decoded.jpeg.length,
      },
    };
  }
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type === 'frame' && typeof msg.data === 'string') {
    return {
      type: 'frame',
      frame: {
        data: msg.data,
        w: numberOf(msg.w),
        h: numberOf(msg.h),
        sw: numberOf(msg.sw),
        sh: numberOf(msg.sh),
        bytes: numberOf(msg.bytes),
      },
    };
  }
  if (msg.type === 'error') {
    const error = typeof msg.error === 'string' && msg.error ? msg.error : 'The host reported a capture error.';
    return { type: 'error', error };
  }
  return null;
}
