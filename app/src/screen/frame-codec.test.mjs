// Unit tests for the app's copy of the binary frame codec.
//
//   cd app && node --test src/screen/frame-codec.test.mjs
//
// The module is a byte-identical mirror of server/src/frame-codec.ts (the
// header comment there explains the wire layout). This suite proves the app's
// copy independently: the encode/decode round-trip, the bounds checks that
// guard the untrusted network boundary, and — because the two files must never
// drift — that this copy still matches the host's byte-for-byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BINARY_FRAME_MAGIC,
  BINARY_FRAME_VERSION,
  MAX_FRAME_DIMENSION,
  bytesToBase64,
  decodeBinaryFrame,
  encodeBinaryFrame,
  isBinaryFramePayload,
} from './frame-codec.ts';

const jpeg = (...bytes) => Uint8Array.from(bytes);

test('the app copy is byte-identical to the server copy', async () => {
  const mine = await readFile(new URL('./frame-codec.ts', import.meta.url), 'utf8');
  const theirs = await readFile(new URL('../../../server/src/frame-codec.ts', import.meta.url), 'utf8');
  assert.equal(mine, theirs, 'run: cp server/src/frame-codec.ts app/src/screen/frame-codec.ts');
});

test('a screen frame round-trips: dimensions and pixels come back exactly', () => {
  const pixels = jpeg(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
  const frame = decodeBinaryFrame(encodeBinaryFrame({ w: 1280, h: 800, sw: 2560, sh: 1600 }, pixels));
  assert.ok(frame);
  assert.deepEqual(
    { w: frame.w, h: frame.h, sw: frame.sw, sh: frame.sh, meta: frame.meta },
    { w: 1280, h: 800, sw: 2560, sh: 1600, meta: null },
  );
  assert.deepEqual(Array.from(frame.jpeg), Array.from(pixels));
});

test('a window frame round-trips its metadata', () => {
  const meta = { rect: { X: -120, Y: 40, W: 640, H: 480 }, title: 'éditor ✓', hidden: true };
  const frame = decodeBinaryFrame(encodeBinaryFrame({ w: 640, h: 480, sw: 640, sh: 480, meta }, jpeg(1, 2, 3)));
  assert.ok(frame);
  assert.deepEqual(frame.meta, meta);
});

test('decode accepts an ArrayBuffer, the shape a WebSocket actually delivers', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(9, 9));
  const buffer = wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength);
  const frame = decodeBinaryFrame(buffer);
  assert.ok(frame);
  assert.deepEqual(Array.from(frame.jpeg), [9, 9]);
});

test('boundary dimensions round-trip: zero and the maximum', () => {
  for (const d of [0, 1, MAX_FRAME_DIMENSION]) {
    const frame = decodeBinaryFrame(encodeBinaryFrame({ w: d, h: d, sw: d, sh: d }, jpeg(9)));
    assert.ok(frame, `dimension ${d} must round-trip`);
    assert.equal(frame.sh, d);
  }
});

test('decode rejects every truncated prefix of a valid frame', () => {
  const wire = encodeBinaryFrame({ w: 320, h: 200, sw: 640, sh: 400, meta: { title: 't' } }, jpeg(1, 2, 3, 4));
  for (let len = 0; len < wire.length; len++) {
    assert.equal(decodeBinaryFrame(wire.subarray(0, len)), null, `length ${len} must be rejected`);
  }
  assert.ok(decodeBinaryFrame(wire));
});

test('decode rejects wrong magic, wrong version, oversized dimension, bad metaLen', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1));
  const flip = (offset, value) => {
    const copy = wire.slice();
    copy[offset] = value;
    return copy;
  };
  assert.equal(decodeBinaryFrame(flip(0, 0x00)), null, 'magic');
  assert.equal(decodeBinaryFrame(flip(1, 99)), null, 'version');
  assert.equal(decodeBinaryFrame(flip(4, 0xff)), null, 'w beyond MAX_FRAME_DIMENSION');
  assert.equal(decodeBinaryFrame(flip(3, 200)), null, 'metaLen past the end of the buffer');
});

test('decode returns pixels that do not alias the wire buffer', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1, 2, 3));
  const frame = decodeBinaryFrame(wire);
  assert.ok(frame);
  wire.fill(0);
  assert.deepEqual(Array.from(frame.jpeg), [1, 2, 3]);
});

test('isBinaryFramePayload sniffs binary payloads, never strings', () => {
  assert.equal(isBinaryFramePayload(new ArrayBuffer(4)), true);
  assert.equal(isBinaryFramePayload(new Uint8Array(4)), true);
  assert.equal(isBinaryFramePayload('{"type":"frame"}'), false);
  assert.equal(isBinaryFramePayload(null), false);
});

test('bytesToBase64 matches Buffer for every padding remainder', () => {
  for (const len of [0, 1, 2, 3, 4, 255, 256, 1000]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${len}`);
  }
});

test('a decoded binary frame renders as the same data URI the JSON path built', () => {
  const pixels = jpeg(0xff, 0xd8, 0xff, 0xd9);
  const frame = decodeBinaryFrame(encodeBinaryFrame({ w: 2, h: 2, sw: 2, sh: 2 }, pixels));
  assert.ok(frame);
  assert.equal(bytesToBase64(frame.jpeg), Buffer.from(pixels).toString('base64'));
});
