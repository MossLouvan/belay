// The speaker-sink adapter: PCM16→Float32 conversion, Buffer-free base64, and
// the jitter-tick→instruction mapping. Pure logic, so it is pinned here exactly
// like the framing and jitter policy it feeds.
//
//   cd app && node --test src/stream/audio-output.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pcm16ToFloat32, bytesToBase64, instructionFor, AUDIO_OUTPUT } from './audio-output.ts';
import { AudioSender, AudioReceiver } from './webrtc/audio-stream.ts';
import { AUDIO_FRAME_MS } from './webrtc/audio-frames.ts';

// Decode base64 back to a 4-byte-aligned Float32Array, so a test can prove what
// crossed the bridge without trusting the encoder under test to also decode.
function base64ToFloat32(b64) {
  const bin = Buffer.from(b64, 'base64');
  const buf = new ArrayBuffer(bin.length);
  new Uint8Array(buf).set(bin);
  return new Float32Array(buf);
}

test('pcm16ToFloat32 maps the s16 range into [-1, 1), little-endian', () => {
  // 0x0000 = 0, 0x8000 = -32768 → -1, 0x7FFF = 32767 → ~0.99997.
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0xff, 0x7f]);
  const floats = pcm16ToFloat32(bytes);
  assert.equal(floats.length, 3);
  assert.equal(floats[0], 0);
  assert.equal(floats[1], -1);
  assert.ok(Math.abs(floats[2] - 32767 / 32768) < 1e-6);
});

test('pcm16ToFloat32 drops an odd trailing byte instead of throwing', () => {
  const floats = pcm16ToFloat32(new Uint8Array([0x00, 0x00, 0x7f])); // 3 bytes
  assert.equal(floats.length, 1);
  assert.equal(floats[0], 0);
});

test('pcm16ToFloat32 on empty input yields an empty array', () => {
  assert.equal(pcm16ToFloat32(new Uint8Array(0)).length, 0);
});

test('pcm16ToFloat32 honours a subarray byteOffset', () => {
  // frame.payload can be a view into a larger buffer; the window must be read,
  // not the whole backing store.
  const backing = new Uint8Array([0xaa, 0xbb, 0x00, 0x80, 0xff, 0x7f, 0xcc]);
  const window = backing.subarray(2, 6); // the -1 and +0.99997 samples
  const floats = pcm16ToFloat32(window);
  assert.equal(floats.length, 2);
  assert.equal(floats[0], -1);
  assert.ok(Math.abs(floats[1] - 32767 / 32768) < 1e-6);
});

test('bytesToBase64 matches Buffer for every length remainder (incl. empty)', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 255, 3840]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `len ${len}`);
  }
});

test('instructionFor: wait → idle, conceal → silence', () => {
  assert.deepEqual(instructionFor({ kind: 'wait' }), { kind: 'idle' });
  assert.deepEqual(instructionFor({ kind: 'conceal' }), { kind: 'silence' });
});

test('instructionFor: a pcm16 play frame carries the exact converted floats', () => {
  // One stereo sample: L = -1 (0x8000), R = +0.99997 (0x7FFF).
  const payload = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
  const instruction = instructionFor({ kind: 'play', frame: { codec: 'pcm16', payload } });
  assert.equal(instruction.kind, 'play');
  const floats = base64ToFloat32(instruction.floatB64);
  assert.equal(floats.length, 2);
  assert.equal(floats[0], -1);
  assert.ok(Math.abs(floats[1] - 32767 / 32768) < 1e-6);
});

test('instructionFor: an undecodable opus frame is silenced, not mis-played', () => {
  const instruction = instructionFor({ kind: 'play', frame: { codec: 'opus', payload: new Uint8Array([1, 2, 3]) } });
  assert.deepEqual(instruction, { kind: 'silence' });
});

test('instructionFor: an empty pcm payload is silence, never an empty play', () => {
  const instruction = instructionFor({ kind: 'play', frame: { codec: 'pcm16', payload: new Uint8Array(0) } });
  assert.deepEqual(instruction, { kind: 'silence' });
});

test('AUDIO_OUTPUT describes 48 kHz interleaved stereo s16', () => {
  assert.equal(AUDIO_OUTPUT.sampleRate, 48_000);
  assert.equal(AUDIO_OUTPUT.channels, 2);
  assert.equal(AUDIO_OUTPUT.bytesPerSample, 2);
});

test('end to end: sender → receiver → instructionFor plays the sent PCM', () => {
  const receiver = new AudioReceiver();
  const sender = new AudioSender((bytes) => receiver.onWireBytes(bytes, now), 'pcm16');

  // Two 1-sample stereo frames (prebuffer is 2 frames), distinct payloads.
  const frameA = new Uint8Array([0x00, 0x80, 0x00, 0x80]); // both channels -1
  const frameB = new Uint8Array([0x00, 0x00, 0x00, 0x00]); // both channels 0
  let now = 0;
  sender.pushEncodedFrame(frameA, 1);
  now += AUDIO_FRAME_MS;
  sender.pushEncodedFrame(frameB, 1);

  const played = [];
  for (let i = 0; i < 3; i++) {
    const instruction = instructionFor(receiver.tick());
    if (instruction.kind === 'play') played.push(base64ToFloat32(instruction.floatB64));
  }
  assert.equal(played.length, 2, 'both buffered frames play once prebuffer is met');
  assert.deepEqual(Array.from(played[0]), [-1, -1]);
  assert.deepEqual(Array.from(played[1]), [0, 0]);
});
