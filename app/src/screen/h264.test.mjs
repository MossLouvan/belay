// Unit tests for the pure half of the H.264-over-WebSocket path: what the
// phone asks for, how it reads the host's codec announcement, and how it
// recognises a Blob-delivered binary message without touching its bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blobRefOf, parseCodecMessage, streamCodecParams } from './h264.ts';

test('the phone advertises H.264 only when it can decode it natively', () => {
  assert.deepEqual(streamCodecParams(true), { codec: 'h264' });
  assert.deepEqual(streamCodecParams(false), {});
});

test('a codec announcement carries the frame geometry', () => {
  const msg = parseCodecMessage(JSON.stringify({ type: 'codec', codec: 'h264', w: 1280, h: 800, sw: 2560, sh: 1600 }));
  assert.deepEqual(msg, { codec: 'h264', w: 1280, h: 800, sw: 2560, sh: 1600 });
});

test('a jpeg announcement needs no geometry', () => {
  assert.deepEqual(parseCodecMessage(JSON.stringify({ type: 'codec', codec: 'jpeg' })), { codec: 'jpeg', w: 0, h: 0, sw: 0, sh: 0 });
});

test('anything else is not a codec announcement', () => {
  for (const junk of [null, 42, 'nope', '{"type":"codec","codec":"vp9"}', '{"type":"frame"}', JSON.stringify({ type: 'codec' })]) {
    assert.equal(parseCodecMessage(junk), null, `must ignore ${String(junk)}`);
  }
});

test('a React Native Blob is recognised by its native handle, bytes untouched', () => {
  const blob = { data: { blobId: 'abc-123', offset: 0, size: 51234 } };
  assert.deepEqual(blobRefOf(blob), { blobId: 'abc-123', offset: 0, size: 51234 });
});

test('strings, ArrayBuffers and malformed blobs are not blob refs', () => {
  for (const junk of ['text', new ArrayBuffer(4), null, undefined, {}, { data: {} }, { data: { blobId: 1, offset: 0, size: 1 } }, { data: { blobId: 'x', offset: -1, size: 1 } }]) {
    assert.equal(blobRefOf(junk), null);
  }
});
