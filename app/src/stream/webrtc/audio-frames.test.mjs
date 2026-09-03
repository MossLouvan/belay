// The audio wire format — framing, validation, wraparound seq arithmetic.
//
//   cd app && node --test src/stream/webrtc/audio-frames.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_HEADER_BYTES,
  AUDIO_SAMPLES_PER_FRAME,
  AUDIO_WIRE_MAGIC,
  MAX_AUDIO_PAYLOAD_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
  nextSeq,
  seqDelta,
  seqNewer,
} from './audio-frames.ts';

test('encode/decode round-trips every field', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const bytes = encodeAudioFrame({ seq: 4242, timestamp: 96_000, codec: 'opus', payload });
  const decoded = decodeAudioFrame(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.frame.seq, 4242);
  assert.equal(decoded.frame.timestamp, 96_000);
  assert.equal(decoded.frame.codec, 'opus');
  assert.deepEqual([...decoded.frame.payload], [1, 2, 3, 4, 5]);
});

test('golden vector: the exact bytes the server-side encoder must also produce', () => {
  // Mirrored byte-for-byte in server/test/audio.test.ts. If either side changes
  // the layout, both golden tests fail together — that is the compatibility pin.
  const bytes = encodeAudioFrame({
    seq: 0x0102,
    timestamp: 0x03040506,
    codec: 'pcm16',
    payload: new Uint8Array([0xaa, 0xbb]),
  });
  assert.deepEqual(
    [...bytes],
    [0xa5, 0x10, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x01, 0x00, 0x02, 0xaa, 0xbb],
  );
});

test('boundary values survive: max seq, max timestamp, max payload', () => {
  const payload = new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES).fill(7);
  const bytes = encodeAudioFrame({ seq: 0xffff, timestamp: 0xffffffff, codec: 'opus', payload });
  const decoded = decodeAudioFrame(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.frame.seq, 0xffff);
  assert.equal(decoded.frame.timestamp, 0xffffffff);
  assert.equal(decoded.frame.payload.length, MAX_AUDIO_PAYLOAD_BYTES);
});

test('encode rejects out-of-contract input (trusted-side bugs fail loudly)', () => {
  const payload = new Uint8Array([1]);
  assert.throws(() => encodeAudioFrame({ seq: 0x10000, timestamp: 0, codec: 'opus', payload }), RangeError);
  assert.throws(() => encodeAudioFrame({ seq: -1, timestamp: 0, codec: 'opus', payload }), RangeError);
  assert.throws(() => encodeAudioFrame({ seq: 0, timestamp: 2 ** 32, codec: 'opus', payload }), RangeError);
  assert.throws(() => encodeAudioFrame({ seq: 0, timestamp: 0, codec: 'opus', payload: new Uint8Array(0) }), RangeError);
  assert.throws(
    () => encodeAudioFrame({ seq: 0, timestamp: 0, codec: 'opus', payload: new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES + 1) }),
    RangeError,
  );
});

test('decode never throws on hostile bytes — every rejection is a clean error', () => {
  const good = encodeAudioFrame({ seq: 1, timestamp: 960, codec: 'opus', payload: new Uint8Array([9, 9]) });

  // Too short.
  assert.equal(decodeAudioFrame(new Uint8Array(0)).ok, false);
  assert.equal(decodeAudioFrame(good.slice(0, AUDIO_HEADER_BYTES)).ok, false);
  // Wrong magic (a JSON text frame, say).
  const badMagic = Uint8Array.from(good); badMagic[0] = 0x7b; // '{'
  assert.equal(decodeAudioFrame(badMagic).ok, false);
  // Unknown version.
  const badVersion = Uint8Array.from(good); badVersion[1] = 0x20;
  assert.equal(decodeAudioFrame(badVersion).ok, false);
  // Unknown codec byte.
  const badCodec = Uint8Array.from(good); badCodec[8] = 9;
  assert.equal(decodeAudioFrame(badCodec).ok, false);
  // Declared length disagreeing with actual bytes (both directions).
  const shortLen = Uint8Array.from(good); shortLen[10] = 1;
  assert.equal(decodeAudioFrame(shortLen).ok, false);
  const longLen = Uint8Array.from(good); longLen[10] = 200;
  assert.equal(decodeAudioFrame(longLen).ok, false);
  // Zero-length payload declaration.
  const zeroLen = Uint8Array.from(good.slice(0, AUDIO_HEADER_BYTES + 1)); zeroLen[9] = 0; zeroLen[10] = 0;
  assert.equal(decodeAudioFrame(zeroLen).ok, false);
  // A hostile length field cannot make decode allocate beyond the cap.
  const hugeLen = Uint8Array.from(good); hugeLen[9] = 0xff; hugeLen[10] = 0xff;
  assert.equal(decodeAudioFrame(hugeLen).ok, false);

  assert.equal(good[0], AUDIO_WIRE_MAGIC);
});

test('seq arithmetic is wraparound-aware (the 65535 -> 0 boundary)', () => {
  assert.equal(nextSeq(0), 1);
  assert.equal(nextSeq(0xffff), 0);
  // 65535 -> 0 is "+1", not "-65535".
  assert.equal(seqDelta(0xffff, 0), 1);
  assert.equal(seqDelta(0, 0xffff), -1);
  assert.equal(seqDelta(5, 5), 0);
  assert.equal(seqDelta(10, 13), 3);
  assert.equal(seqNewer(0, 0xffff), true, '0 is newer than 65535 across the wrap');
  assert.equal(seqNewer(0xffff, 0), false);
  assert.equal(seqNewer(7, 7), false);
});

test('a 20 ms frame is 960 samples at 48 kHz', () => {
  assert.equal(AUDIO_SAMPLES_PER_FRAME, 960);
});
