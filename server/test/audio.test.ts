// The host side of the audio wire contract: helper-push validation, the binary
// wire frame (pinned byte-for-byte against the app's decoder), and the
// live-stream drop policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_HEADER_BYTES,
  MAX_AUDIO_BUFFERED_BYTES,
  MAX_AUDIO_PAYLOAD_BYTES,
  encodeAudioWireFrame,
  shouldDropAudioFrame,
  validateHelperAudioFrame,
} from '../src/audio.js';

const push = (over: Record<string, unknown> = {}) => ({
  type: 'audio',
  seq: 7,
  ts: 6720,
  codec: 'opus',
  data: Buffer.from([1, 2, 3]).toString('base64'),
  ...over,
});

test('accepts a well-formed helper frame', () => {
  const r = validateHelperAudioFrame(push());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.frame.seq, 7);
  assert.equal(r.frame.timestamp, 6720);
  assert.equal(r.frame.codec, 'opus');
  assert.deepEqual([...r.frame.payload], [1, 2, 3]);
});

test('rejects every malformed helper push without throwing', () => {
  assert.equal(validateHelperAudioFrame(null).ok, false);
  assert.equal(validateHelperAudioFrame('audio').ok, false);
  assert.equal(validateHelperAudioFrame({ type: 'webrtc' }).ok, false);
  assert.equal(validateHelperAudioFrame(push({ seq: -1 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ seq: 0x10000 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ seq: 1.5 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ seq: '7' })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ ts: -1 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ ts: 2 ** 32 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ codec: 'mp3' })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ data: '' })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ data: 42 })).ok, false);
  assert.equal(validateHelperAudioFrame(push({ data: 'not base64 !!!' })).ok, false);
});

test('caps the payload: an oversized frame is rejected, not allocated', () => {
  const atCap = Buffer.alloc(MAX_AUDIO_PAYLOAD_BYTES).toString('base64');
  assert.equal(validateHelperAudioFrame(push({ data: atCap })).ok, true);
  const overCap = Buffer.alloc(MAX_AUDIO_PAYLOAD_BYTES + 1).toString('base64');
  assert.equal(validateHelperAudioFrame(push({ data: overCap })).ok, false);
});

test('golden vector: the exact bytes the app-side decoder expects', () => {
  // Mirrored byte-for-byte in app/src/stream/webrtc/audio-frames.test.mjs. If
  // either side changes the layout, both golden tests fail together.
  const bytes = encodeAudioWireFrame({
    seq: 0x0102,
    timestamp: 0x03040506,
    codec: 'pcm16',
    payload: Buffer.from([0xaa, 0xbb]),
  });
  assert.deepEqual(
    [...bytes],
    [0xa5, 0x10, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x01, 0x00, 0x02, 0xaa, 0xbb],
  );
  assert.equal(bytes.length, AUDIO_HEADER_BYTES + 2);
});

test('wire encode round-trips boundary values', () => {
  const bytes = encodeAudioWireFrame({
    seq: 0xffff,
    timestamp: 0xffffffff,
    codec: 'opus',
    payload: Buffer.from([9]),
  });
  assert.equal(bytes.readUInt16BE(2), 0xffff);
  assert.equal(bytes.readUInt32BE(4), 0xffffffff);
  assert.equal(bytes[8], 0, 'opus is codec byte 0');
});

test('wire encode refuses out-of-contract input loudly (host bugs, not network data)', () => {
  const payload = Buffer.from([1]);
  assert.throws(() => encodeAudioWireFrame({ seq: -1, timestamp: 0, codec: 'opus', payload }), RangeError);
  assert.throws(() => encodeAudioWireFrame({ seq: 0, timestamp: 2 ** 32, codec: 'opus', payload }), RangeError);
  assert.throws(() => encodeAudioWireFrame({ seq: 0, timestamp: 0, codec: 'opus', payload: Buffer.alloc(0) }), RangeError);
  assert.throws(
    () => encodeAudioWireFrame({ seq: 0, timestamp: 0, codec: 'opus', payload: Buffer.alloc(MAX_AUDIO_PAYLOAD_BYTES + 1) }),
    RangeError,
  );
});

test('helper push -> wire frame, end to end', () => {
  const validated = validateHelperAudioFrame(push({ seq: 258, ts: 0x03040506, codec: 'pcm16', data: Buffer.from([0xaa, 0xbb]).toString('base64') }));
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const bytes = encodeAudioWireFrame(validated.frame);
  assert.deepEqual([...bytes], [0xa5, 0x10, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x01, 0x00, 0x02, 0xaa, 0xbb]);
});

test('drop policy: shed frames once the socket is congested past the cap', () => {
  assert.equal(shouldDropAudioFrame(0), false);
  assert.equal(shouldDropAudioFrame(MAX_AUDIO_BUFFERED_BYTES), false);
  assert.equal(shouldDropAudioFrame(MAX_AUDIO_BUFFERED_BYTES + 1), true);
});
