// The host side of the audio wire contract — pure functions, no sockets, no
// helper process, so every rule is asserted under the test runner.
//
// Three jobs:
//   1. validate the frames the native helper pushes (`type:'audio'` lines on
//      stdout) — the helper is trusted code but its output crosses a process
//      boundary and a wedged/mismatched helper must degrade to dropped frames,
//      never a crash;
//   2. encode the binary wire frame the phone's decoder expects. The layout is
//      defined in app/src/stream/webrtc/audio-frames.ts and pinned by an
//      identical golden-vector test on BOTH sides — change one, both fail;
//   3. the drop policy for a congested socket: audio is a live stream, so when
//      the transport backs up we shed frames (the receiver's jitter buffer
//      conceals them) instead of queueing latency we can never get back.

/** Mirror of app/src/stream/webrtc/audio-frames.ts — keep in lockstep. */
export const AUDIO_WIRE_MAGIC = 0xa5;
export const AUDIO_WIRE_VERSION = 1;
export const AUDIO_HEADER_BYTES = 11;
export const MAX_AUDIO_PAYLOAD_BYTES = 4096;
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_FRAME_MS = 20;

/** Past this much unsent data on the socket, new audio frames are dropped.
 *  64 KB ≈ 330 ms of PCM16 stereo — far beyond any jitter buffer's reach, so
 *  everything behind it would arrive dead anyway. */
export const MAX_AUDIO_BUFFERED_BYTES = 64 * 1024;

export type AudioCodec = 'opus' | 'pcm16';

const CODEC_TO_BYTE: Readonly<Record<AudioCodec, number>> = Object.freeze({ opus: 0, pcm16: 1 });

/** Base64 of MAX_AUDIO_PAYLOAD_BYTES plus padding slack. */
const MAX_DATA_CHARS = Math.ceil((MAX_AUDIO_PAYLOAD_BYTES * 4) / 3) + 8;
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface HelperAudioFrame {
  readonly seq: number;
  readonly timestamp: number;
  readonly codec: AudioCodec;
  readonly payload: Buffer;
}

export type HelperAudioResult =
  | { readonly ok: true; readonly frame: HelperAudioFrame }
  | { readonly ok: false; readonly error: string };

/**
 * Validates one `type:'audio'` push from the native helper:
 * `{ type:'audio', seq, ts, codec, data }` with base64 `data`. Never throws.
 */
export function validateHelperAudioFrame(input: unknown): HelperAudioResult {
  if (!input || typeof input !== 'object') return fail('audio push is not an object');
  const msg = input as Record<string, unknown>;
  if (msg.type !== 'audio') return fail('not an audio push');

  const seq = msg.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
    return fail('seq must be an integer 0..65535');
  }
  const ts = msg.ts;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0 || ts > 0xffffffff) {
    return fail('ts must be an integer 0..2^32-1');
  }
  const codec = msg.codec;
  if (codec !== 'opus' && codec !== 'pcm16') return fail(`unknown codec: ${String(codec)}`);

  const data = msg.data;
  if (typeof data !== 'string' || data.length === 0) return fail('missing data');
  if (data.length > MAX_DATA_CHARS) return fail('data too large');
  if (!BASE64_SHAPE.test(data)) return fail('data is not base64');

  const payload = Buffer.from(data, 'base64');
  if (payload.length === 0 || payload.length > MAX_AUDIO_PAYLOAD_BYTES) {
    return fail(`decoded payload must be 1..${MAX_AUDIO_PAYLOAD_BYTES} bytes`);
  }
  return { ok: true, frame: { seq, timestamp: ts, codec, payload } };
}

/**
 * Serializes one validated helper frame into the binary wire format the
 * phone's decodeAudioFrame parses. Input is already validated, so violations
 * here are host bugs and throw.
 */
export function encodeAudioWireFrame(frame: HelperAudioFrame): Buffer {
  if (frame.payload.length === 0 || frame.payload.length > MAX_AUDIO_PAYLOAD_BYTES) {
    throw new RangeError(`audio payload must be 1..${MAX_AUDIO_PAYLOAD_BYTES} bytes`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffff) {
    throw new RangeError(`audio seq out of u16 range: ${frame.seq}`);
  }
  if (!Number.isInteger(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > 0xffffffff) {
    throw new RangeError(`audio timestamp out of u32 range: ${frame.timestamp}`);
  }
  const out = Buffer.alloc(AUDIO_HEADER_BYTES + frame.payload.length);
  out[0] = AUDIO_WIRE_MAGIC;
  out[1] = (AUDIO_WIRE_VERSION << 4) | 0;
  out.writeUInt16BE(frame.seq, 2);
  out.writeUInt32BE(frame.timestamp, 4);
  out[8] = CODEC_TO_BYTE[frame.codec];
  out.writeUInt16BE(frame.payload.length, 9);
  frame.payload.copy(out, AUDIO_HEADER_BYTES);
  return out;
}

/** Live-stream backpressure: drop the frame rather than queue it dead. */
export function shouldDropAudioFrame(socketBufferedBytes: number): boolean {
  return socketBufferedBytes > MAX_AUDIO_BUFFERED_BYTES;
}

function fail(error: string): HelperAudioResult {
  return { ok: false, error };
}
