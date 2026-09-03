// The audio wire frame: how one encoded audio packet travels from the host to
// the phone, whatever transport carries it (the interim /ws/audio binary
// WebSocket today, the `audio` RTCDataChannel when the libdatachannel peer is
// built, an SRTP audio track eventually — the header survives all three).
//
// Deliberately codec-agnostic bytes: the payload is an opaque encoded packet
// (Opus once libopus is vendored into the helpers, PCM16 until then), and this
// module only frames it — sequence number for loss/reorder detection, a sample
// timestamp for the jitter buffer's playout clock, and a codec tag so a
// receiver never guesses. Pure functions over Uint8Array, no platform APIs, so
// the exact same bytes are asserted in app and server tests (the golden-vector
// tests pin cross-package compatibility).
//
// Layout (big-endian), AUDIO_HEADER_BYTES = 11:
//   [0]     magic 0xA5 — rejects a stray JSON/text frame instantly
//   [1]     version<<4 | flags (version 1, flags reserved 0)
//   [2..3]  sequence number, u16, wraps
//   [4..7]  timestamp, u32, samples at 48 kHz, wraps
//   [8]     codec: 0 = opus, 1 = pcm16 (48 kHz interleaved s16le)
//   [9..10] payload length, u16
//   [11..]  payload

export const AUDIO_WIRE_MAGIC = 0xa5;
export const AUDIO_WIRE_VERSION = 1;
export const AUDIO_HEADER_BYTES = 11;

/** The stream's fixed clock. Opus's native rate; SCK/WASAPI capture is
 *  resampled to it in the helper so every timestamp means the same thing. */
export const AUDIO_SAMPLE_RATE = 48_000;
/** One frame = 20 ms — Opus's sweet spot and the jitter buffer's tick. */
export const AUDIO_FRAME_MS = 20;
export const AUDIO_SAMPLES_PER_FRAME = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000; // 960

/** Opus caps a packet at 1275 bytes per 20 ms frame at its highest bitrate;
 *  PCM16 stereo at 20 ms is 3840 bytes. 4096 covers both with no slack for a
 *  hostile length field to allocate against. */
export const MAX_AUDIO_PAYLOAD_BYTES = 4096;

const SEQ_SPAN = 0x10000; // u16
const TS_SPAN = 0x1_0000_0000; // u32

export type AudioCodec = 'opus' | 'pcm16';

const CODEC_TO_BYTE: Readonly<Record<AudioCodec, number>> = Object.freeze({ opus: 0, pcm16: 1 });
const BYTE_TO_CODEC: readonly AudioCodec[] = Object.freeze(['opus', 'pcm16']);

export interface AudioFrame {
  /** u16, wraps at 65536. Consecutive per stream; gaps mean loss. */
  readonly seq: number;
  /** u32 samples at 48 kHz, wraps. The playout clock, not wall time. */
  readonly timestamp: number;
  readonly codec: AudioCodec;
  readonly payload: Uint8Array;
}

export type DecodeResult =
  | { readonly ok: true; readonly frame: AudioFrame }
  | { readonly ok: false; readonly error: string };

/** Serialize one frame. Throws on out-of-contract input — encoding happens on
 *  the trusted side, so a violation here is a bug, not bad network data. */
export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq >= SEQ_SPAN) {
    throw new RangeError(`audio seq out of u16 range: ${frame.seq}`);
  }
  if (!Number.isInteger(frame.timestamp) || frame.timestamp < 0 || frame.timestamp >= TS_SPAN) {
    throw new RangeError(`audio timestamp out of u32 range: ${frame.timestamp}`);
  }
  if (frame.payload.length === 0 || frame.payload.length > MAX_AUDIO_PAYLOAD_BYTES) {
    throw new RangeError(`audio payload must be 1..${MAX_AUDIO_PAYLOAD_BYTES} bytes, got ${frame.payload.length}`);
  }
  const out = new Uint8Array(AUDIO_HEADER_BYTES + frame.payload.length);
  out[0] = AUDIO_WIRE_MAGIC;
  out[1] = (AUDIO_WIRE_VERSION << 4) | 0;
  out[2] = (frame.seq >>> 8) & 0xff;
  out[3] = frame.seq & 0xff;
  out[4] = (frame.timestamp >>> 24) & 0xff;
  out[5] = (frame.timestamp >>> 16) & 0xff;
  out[6] = (frame.timestamp >>> 8) & 0xff;
  out[7] = frame.timestamp & 0xff;
  out[8] = CODEC_TO_BYTE[frame.codec];
  out[9] = (frame.payload.length >>> 8) & 0xff;
  out[10] = frame.payload.length & 0xff;
  out.set(frame.payload, AUDIO_HEADER_BYTES);
  return out;
}

/** Parse one wire frame. Never throws: everything arriving over a transport is
 *  untrusted, so malformed bytes are a clean rejection, not a crash. */
export function decodeAudioFrame(bytes: Uint8Array): DecodeResult {
  if (bytes.length < AUDIO_HEADER_BYTES + 1) {
    return { ok: false, error: `frame too short: ${bytes.length} bytes` };
  }
  if (bytes[0] !== AUDIO_WIRE_MAGIC) {
    return { ok: false, error: 'bad magic byte (not an audio frame)' };
  }
  const version = bytes[1] >>> 4;
  if (version !== AUDIO_WIRE_VERSION) {
    return { ok: false, error: `unsupported audio frame version ${version}` };
  }
  const codec = BYTE_TO_CODEC[bytes[8]];
  if (!codec) return { ok: false, error: `unknown codec byte ${bytes[8]}` };

  const declared = (bytes[9] << 8) | bytes[10];
  if (declared === 0 || declared > MAX_AUDIO_PAYLOAD_BYTES) {
    return { ok: false, error: `payload length ${declared} out of bounds` };
  }
  if (bytes.length !== AUDIO_HEADER_BYTES + declared) {
    return { ok: false, error: `payload length mismatch: declared ${declared}, have ${bytes.length - AUDIO_HEADER_BYTES}` };
  }
  return {
    ok: true,
    frame: {
      seq: (bytes[2] << 8) | bytes[3],
      // >>> 0 keeps the top bit unsigned — (b<<24) alone goes negative.
      timestamp: (((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0),
      codec,
      payload: bytes.slice(AUDIO_HEADER_BYTES),
    },
  };
}

/** Next sequence number after `seq`, wrapping at u16. */
export function nextSeq(seq: number): number {
  return (seq + 1) % SEQ_SPAN;
}

/**
 * Signed distance from `from` to `to` in wraparound u16 space, in
 * [-32768, 32767]. Positive = `to` is ahead. This is the RTP trick that makes
 * 65535 → 0 read as "+1", not "-65535".
 */
export function seqDelta(from: number, to: number): number {
  const raw = (to - from) & 0xffff;
  return raw >= SEQ_SPAN / 2 ? raw - SEQ_SPAN : raw;
}

/** True when `a` is a newer sequence number than `b`, wrap-aware. */
export function seqNewer(a: number, b: number): boolean {
  return seqDelta(b, a) > 0;
}
