// The speaker-sink adapter: the pure, platform-free half of "play the received
// audio on the phone". It turns one jitter-buffer decision (audio-jitter.ts's
// PopAction) into a self-contained instruction the WebView player (the actual
// Web Audio sink, audio-player.tsx) can act on, and does the sample-format
// conversion the sink needs.
//
// WHY a WebView sink, and WHY this split:
//   * Expo/RN has no first-party way to push RAW PCM frames at a speaker.
//     expo-audio / expo-av only play encoded media from a URI or file — there
//     is no "here are 20 ms of s16le, play them gaplessly" API, so streaming a
//     live socket through them would mean wrapping every frame in a WAV and
//     spawning thousands of one-shot players. Unworkable for low latency.
//   * A native AudioQueue/AudioUnit module is the eventual "right" answer, but
//     it needs an Xcode build + config plugin that cannot be compiled or tested
//     in this environment, and is a permanent native maintenance surface.
//   * WKWebView's Web Audio API already does exactly what we need — schedule
//     Float32 PCM AudioBuffers gaplessly on one playhead at 48 kHz — with ZERO
//     native code and ZERO new dependency (react-native-webview is already a
//     dep, already used by the file viewers). So the sink is a hidden WebView.
//
// This module stays pure so the format conversion and the tick→instruction
// mapping are unit-tested under `node --test`, exactly like the framing and
// jitter policy it sits on top of. All the side effects (the socket, the 20 ms
// timer, the WebView bridge, the iOS audio session) live in audio-player.tsx.
//
// pcm16 FIRST: today's wire payload is 48 kHz interleaved stereo s16le (the
// codec byte the frame carries is `pcm16`). Opus is future work — when libopus
// is vendored the receiver will decode Opus → PCM upstream of this sink, and
// the only change here is that `instructionFor` starts seeing pcm16 payloads
// that were Opus on the wire. The codec guard below is what keeps an
// as-yet-undecodable Opus frame from being mis-played as noise.

import { AUDIO_SAMPLE_RATE } from './webrtc/audio-frames.ts';
import type { PopAction } from './webrtc/audio-jitter.ts';

/** Interleaved stereo, s16le — the format AudioCapture.swift emits and the
 *  wire carries. Re-exported so the sink and its tests share one source. */
export const AUDIO_OUTPUT = Object.freeze({
  sampleRate: AUDIO_SAMPLE_RATE, // 48 kHz
  channels: 2,
  bytesPerSample: 2, // s16
});

/**
 * Decode one PCM16 payload (interleaved s16le) to interleaved Float32 in
 * [-1, 1) — the shape Web Audio's `AudioBuffer` wants.
 *
 * Tolerant by contract: audio bytes are untrusted, so an odd trailing byte is
 * dropped rather than throwing, and an empty input yields an empty array. The
 * framing layer has already validated length bounds; this never crashes on a
 * short or malformed payload.
 */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const usableBytes = bytes.length - (bytes.length % AUDIO_OUTPUT.bytesPerSample);
  const sampleCount = usableBytes / AUDIO_OUTPUT.bytesPerSample;
  const out = new Float32Array(sampleCount);
  // A fresh DataView over the exact window: `byteOffset`/length honour a
  // Uint8Array that is a subarray of a larger buffer (frame.payload can be).
  const view = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
  for (let i = 0; i < sampleCount; i++) {
    // /32768 maps the full s16 range symmetrically into [-1, 1); the tiny
    // positive-side asymmetry (+32767 → 0.99997) is inaudible and standard.
    out[i] = view.getInt16(i * 2, true /* little-endian */) / 0x8000;
  }
  return out;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode raw bytes without Node's `Buffer` (absent in React Native) and
 * without `btoa` (which only takes a binary string and mangles high bytes).
 * The WebView bridge carries strings, so a play frame crosses as base64; the
 * player `atob`s it straight back to bytes. Pure and hand-rolled so it behaves
 * identically in the test runner and on-device.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + BASE64_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * What the playback loop should do with one jitter-buffer tick:
 *   * play    — schedule these interleaved-Float32 bytes (base64) on the sink;
 *   * silence — advance the playhead one frame with no audio (a concealed gap),
 *               so playout stays aligned instead of pulling later audio early;
 *   * idle    — emit nothing (still prebuffering, or the stream is over).
 */
export type PlayInstruction =
  | { readonly kind: 'play'; readonly floatB64: string }
  | { readonly kind: 'silence' }
  | { readonly kind: 'idle' };

const IDLE: PlayInstruction = Object.freeze({ kind: 'idle' });
const SILENCE: PlayInstruction = Object.freeze({ kind: 'silence' });

/**
 * Map one AudioReceiver.tick() result to a sink instruction. The conversion to
 * Float32 (the exact tested `pcm16ToFloat32`) happens HERE, on the RN side, so
 * the WebView JS stays a thin scheduler with no format logic to keep in sync.
 *
 * `encode` is injectable purely so a test can assert the byte payload without
 * re-deriving base64; production always uses `bytesToBase64`.
 */
export function instructionFor(
  action: PopAction,
  encode: (bytes: Uint8Array) => string = bytesToBase64,
): PlayInstruction {
  if (action.kind === 'wait') return IDLE;
  if (action.kind === 'conceal') return SILENCE;

  // kind === 'play'. Only PCM16 is playable today; an Opus frame that reached
  // here (no decoder yet) is concealed as silence rather than fed to the sink
  // as garbage — the playhead still advances, so timing survives until libopus
  // lands and PCM is all this ever sees.
  if (action.frame.codec !== 'pcm16') return SILENCE;

  const floats = pcm16ToFloat32(action.frame.payload);
  if (floats.length === 0) return SILENCE;
  const floatBytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  return { kind: 'play', floatB64: encode(floatBytes) };
}
