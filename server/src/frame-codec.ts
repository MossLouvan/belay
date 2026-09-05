// The binary frame wire format for the screen and window streams.
//
// Every stream frame used to travel as `JSON.stringify({type:'frame', data:
// <base64>})` — +33% bytes and a full UTF-8 encode/decode on the largest
// payload in the system, at the frame rate. A client that opts in (`?bin=1`
// on the stream URL) instead receives each frame as one binary WebSocket
// message; JSON remains the carrier for everything that is not pixels
// (errors, `gone`, config replies, and the rare window frame with no image
// data), so a client sniffs binary-vs-string per message and both kinds
// interleave freely on one socket.
//
// Wire layout, version 1 — all integers big-endian:
//
//   offset  size  field
//   0       1     magic      0xBF ("Belay Frame")
//   1       1     version    0x01
//   2       2     metaLen    u16 — byte length of the JSON meta block
//   4       4     w          u32 — encoded frame width, px
//   8       4     h          u32 — encoded frame height, px
//   12      4     sw         u32 — source (capture) width, px
//   16      4     sh         u32 — source (capture) height, px
//   20      4     jpegLen    u32 — byte length of the JPEG payload, ≥ 1
//   24      m     meta       UTF-8 JSON object (window rect/title/hidden);
//                            absent when metaLen is 0
//   24+m    j     jpeg       exactly jpegLen raw JPEG bytes
//
// jpegLen makes the frame self-delimiting: a message truncated anywhere —
// even mid-JPEG — decodes to null instead of a torn image, and trailing
// garbage is rejected rather than silently folded into the picture.
//
// This module is PURE — no Node Buffer, no imports — because it is mirrored
// byte-for-byte as app/src/screen/frame-codec.ts and its decode path runs on
// an untrusted network boundary in React Native. Keep the two copies
// identical; the round-trip test suites on both sides hold the contract.
//
// Decode returns null for anything malformed rather than throwing: to a
// stream client an unreadable frame and an unrecognised message are the same
// event (skip it), and a hostile peer must not be able to throw past the
// parser. Encode throws: a malformed frame on the sending side is a bug.

export const BINARY_FRAME_MAGIC = 0xbf;
export const BINARY_FRAME_VERSION = 0x01;
export const BINARY_FRAME_HEADER_BYTES = 24;

/** Sanity ceiling for any single dimension field — beyond 1M px it is noise. */
export const MAX_FRAME_DIMENSION = 1_048_576;

const MAX_META_BYTES = 0xffff; // metaLen is a u16

export interface BinaryFrameFields {
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
  /** Extra JSON-serialisable fields (a window's rect/title/hidden), or absent. */
  readonly meta?: Readonly<Record<string, unknown>> | null;
}

export interface DecodedBinaryFrame {
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
  readonly meta: Readonly<Record<string, unknown>> | null;
  /** A copy of the JPEG bytes — never a view aliasing the wire buffer. */
  readonly jpeg: Uint8Array;
}

const isValidDimension = (n: number): boolean =>
  Number.isInteger(n) && n >= 0 && n <= MAX_FRAME_DIMENSION;

/** True for the payload shapes a WebSocket delivers for a binary message. */
export const isBinaryFramePayload = (payload: unknown): payload is ArrayBuffer | ArrayBufferView =>
  payload instanceof ArrayBuffer || ArrayBuffer.isView(payload);

const asBytes = (payload: ArrayBuffer | ArrayBufferView): Uint8Array =>
  payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

/**
 * Encode one frame for the wire. Throws on invalid input — the sender owns
 * its own frames, so a bad one is a bug to surface, not a byte stream to emit.
 */
export function encodeBinaryFrame(fields: BinaryFrameFields, jpeg: Uint8Array): Uint8Array {
  const { w, h, sw, sh } = fields;
  for (const [name, value] of [['w', w], ['h', h], ['sw', sw], ['sh', sh]] as const) {
    if (!isValidDimension(value)) {
      throw new Error(`binary frame: ${name} must be an integer in 0..${MAX_FRAME_DIMENSION}, got ${value}`);
    }
  }
  if (jpeg.length === 0) throw new Error('binary frame: refusing to encode an empty JPEG payload');

  const meta = fields.meta ?? null;
  const metaBytes = meta === null
    ? new Uint8Array(0)
    : new TextEncoder().encode(JSON.stringify(meta));
  if (metaBytes.length > MAX_META_BYTES) {
    throw new Error(`binary frame: meta block is ${metaBytes.length} bytes, the maximum is ${MAX_META_BYTES}`);
  }

  const wire = new Uint8Array(BINARY_FRAME_HEADER_BYTES + metaBytes.length + jpeg.length);
  const view = new DataView(wire.buffer);
  view.setUint8(0, BINARY_FRAME_MAGIC);
  view.setUint8(1, BINARY_FRAME_VERSION);
  view.setUint16(2, metaBytes.length);
  view.setUint32(4, w);
  view.setUint32(8, h);
  view.setUint32(12, sw);
  view.setUint32(16, sh);
  view.setUint32(20, jpeg.length);
  wire.set(metaBytes, BINARY_FRAME_HEADER_BYTES);
  wire.set(jpeg, BINARY_FRAME_HEADER_BYTES + metaBytes.length);
  return wire;
}

/**
 * Decode one wire frame from an untrusted peer. Every field is bounds-checked
 * before any slice; anything malformed returns null. The returned JPEG bytes
 * are a copy, so the caller may keep them after the wire buffer is reused.
 */
export function decodeBinaryFrame(payload: unknown): DecodedBinaryFrame | null {
  if (!isBinaryFramePayload(payload)) return null;
  const wire = asBytes(payload);
  if (wire.length < BINARY_FRAME_HEADER_BYTES + 1) return null; // header + ≥1 JPEG byte
  if (wire[0] !== BINARY_FRAME_MAGIC || wire[1] !== BINARY_FRAME_VERSION) return null;

  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const metaLen = view.getUint16(2);
  const w = view.getUint32(4);
  const h = view.getUint32(8);
  const sw = view.getUint32(12);
  const sh = view.getUint32(16);
  if (![w, h, sw, sh].every(isValidDimension)) return null;

  const jpegLen = view.getUint32(20);
  const jpegStart = BINARY_FRAME_HEADER_BYTES + metaLen;
  // Exact framing: nothing missing (truncation, even mid-JPEG) and nothing
  // extra (trailing garbage) — the declared lengths must account for it all.
  if (jpegLen < 1 || jpegStart + jpegLen !== wire.length) return null;

  let meta: Record<string, unknown> | null = null;
  if (metaLen > 0) {
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true })
          .decode(wire.subarray(BINARY_FRAME_HEADER_BYTES, jpegStart)),
      );
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return { w, h, sw, sh, meta, jpeg: wire.slice(jpegStart, jpegStart + jpegLen) };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Standard base64 with padding, dependency-free — React Native has neither
 * Buffer nor btoa-on-bytes, and the app still renders frames via a data URI.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    parts.push(
      BASE64_ALPHABET[(triple >> 18) & 63],
      BASE64_ALPHABET[(triple >> 12) & 63],
      i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '=',
      i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '=',
    );
  }
  return parts.join('');
}
