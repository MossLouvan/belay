// The pure half of H.264 over the `/ws/screen` socket.
//
// A Mac host can send hardware-encoded H.264 access units as binary frames on
// the same socket that carries JPEG. The phone asks for it with `?codec=h264`
// (only when the native decoder is in this build), the host answers with a
// `{type:'codec'}` announcement BEFORE the first pixel frame, and from then on
// every binary message is one access unit for the native decoder.
//
// The bytes must never cross the JavaScript thread. With the socket's
// `binaryType` set to 'blob', React Native keeps each binary message in its
// native blob store and hands JS only a handle `{blobId, offset, size}`; the
// native stream module resolves that handle itself. Everything JS does with a
// frame is in this file, and none of it reads a byte of video.

export type ScreenCodec = 'jpeg' | 'h264';

export interface CodecAnnouncement {
  readonly codec: ScreenCodec;
  /** Encoded and source geometry; zero for JPEG, whose frames carry their own. */
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
}

/** The handle React Native gives JS for a Blob-delivered binary message. */
export interface BlobRef {
  readonly blobId: string;
  readonly offset: number;
  readonly size: number;
}

/** Query parameters that advertise what this build can decode. */
export const streamCodecParams = (canDecodeH264: boolean): Readonly<Record<string, string>> =>
  canDecodeH264 ? { codec: 'h264' } : {};

const dim = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Reads the host's codec announcement, or null if `raw` is anything else. */
export function parseCodecMessage(raw: unknown): CodecAnnouncement | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type !== 'codec') return null;
  if (msg.codec !== 'jpeg' && msg.codec !== 'h264') return null;
  return { codec: msg.codec, w: dim(msg.w), h: dim(msg.h), sw: dim(msg.sw), sh: dim(msg.sh) };
}

/**
 * A React Native Blob, recognised by its native handle without reading it.
 * Anything else — a string, an ArrayBuffer, a malformed object — is null.
 */
export function blobRefOf(payload: unknown): BlobRef | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const { blobId, offset, size } = data as Record<string, unknown>;
  if (typeof blobId !== 'string' || blobId.length === 0) return null;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return null;
  return { blobId, offset, size };
}
