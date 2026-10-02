// Parser for the macOS helper's video pipe (fd 3).
//
// The stdio protocol is one JSON line per message, which is the wrong shape
// for 30–60 encoded video frames a second: base64 would cost +33% and a JSON
// parse of the largest payload in the system at the frame rate. So the helper
// writes H.264 frames to a fourth pipe instead, as records:
//
//   offset  size  field
//   0       4     len     u32 big-endian — byte length of everything after it
//   4       1     flags   bit 0 = keyframe
//   5       len-1 frame   a complete binary screen frame (frame-codec.ts
//                         layout, meta `{"codec":"h264"[,"key":true]}`), sent
//                         to the phone byte-for-byte
//
// The frame is already in wire format so Node never re-encodes it; the flags
// byte is there so the relay can honour backpressure (drop until the next
// keyframe) without parsing the frame's JSON meta.

export const VIDEO_RECORD_KEYFRAME = 0x01;

/** A record cannot be larger than this: a single 4K keyframe is well under. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const LENGTH_BYTES = 4;
const FLAGS_BYTES = 1;

export interface VideoRecord {
  readonly keyframe: boolean;
  /** A copy of the frame bytes, independent of the pipe's buffer. */
  readonly frame: Buffer;
}

export interface SplitVideoRecords {
  readonly records: readonly VideoRecord[];
  /** Bytes of an incomplete trailing record, to prepend to the next chunk. */
  readonly rest: Buffer;
}

/**
 * Splits whatever has arrived so far into complete records and a remainder.
 * Throws on a length the helper could never legitimately write, so a corrupt
 * pipe fails loudly instead of waiting forever for 4 GB to arrive.
 */
export function splitVideoRecords(chunk: Buffer): SplitVideoRecords {
  const records: VideoRecord[] = [];
  let offset = 0;
  while (chunk.length - offset >= LENGTH_BYTES) {
    const len = chunk.readUInt32BE(offset);
    if (len < FLAGS_BYTES || len > MAX_RECORD_BYTES) {
      throw new Error(`video pipe: implausible record length ${len}`);
    }
    const end = offset + LENGTH_BYTES + len;
    if (end > chunk.length) break;
    const flags = chunk[offset + LENGTH_BYTES];
    records.push({
      keyframe: (flags & VIDEO_RECORD_KEYFRAME) !== 0,
      frame: Buffer.from(chunk.subarray(offset + LENGTH_BYTES + FLAGS_BYTES, end)),
    });
    offset = end;
  }
  return { records, rest: Buffer.from(chunk.subarray(offset)) };
}
