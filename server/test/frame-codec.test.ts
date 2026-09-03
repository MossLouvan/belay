// Unit tests for the binary frame codec.
//
// The codec is the wire contract between the host's screen/window stream and
// every client that opts into binary frames (`?bin=1`). Both sides carry a
// byte-identical copy of the module (server/src/frame-codec.ts and
// app/src/screen/frame-codec.ts), so this suite is the round-trip proof for
// both: what encode produces, decode must read back exactly — and decode must
// reject, with null rather than a throw, every truncated or corrupted buffer a
// hostile or half-dead peer could send.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BINARY_FRAME_MAGIC,
  BINARY_FRAME_VERSION,
  BINARY_FRAME_HEADER_BYTES,
  MAX_FRAME_DIMENSION,
  bytesToBase64,
  decodeBinaryFrame,
  encodeBinaryFrame,
  isBinaryFramePayload,
} from '../src/frame-codec.js';

const jpeg = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

test('a screen frame round-trips: dimensions and pixels come back exactly', () => {
  const pixels = jpeg(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
  const wire = encodeBinaryFrame({ w: 1280, h: 800, sw: 2560, sh: 1600 }, pixels);
  const frame = decodeBinaryFrame(wire);
  assert.ok(frame, 'decode must accept its own encoder output');
  assert.equal(frame.w, 1280);
  assert.equal(frame.h, 800);
  assert.equal(frame.sw, 2560);
  assert.equal(frame.sh, 1600);
  assert.equal(frame.meta, null);
  assert.deepEqual(Array.from(frame.jpeg), Array.from(pixels));
});

test('a window frame round-trips its metadata (rect, title, hidden)', () => {
  const meta = { rect: { X: -120, Y: 40, W: 640, H: 480 }, title: 'Naïve — “editor” ✓', hidden: false };
  const wire = encodeBinaryFrame({ w: 640, h: 480, sw: 640, sh: 480, meta }, jpeg(1, 2, 3));
  const frame = decodeBinaryFrame(wire);
  assert.ok(frame);
  assert.deepEqual(frame.meta, meta);
  assert.deepEqual(Array.from(frame.jpeg), [1, 2, 3]);
});

test('the wire layout is exactly the documented header', () => {
  const wire = encodeBinaryFrame({ w: 1, h: 2, sw: 3, sh: 4 }, jpeg(0xab));
  assert.equal(wire.length, BINARY_FRAME_HEADER_BYTES + 1);
  assert.equal(wire[0], BINARY_FRAME_MAGIC);
  assert.equal(wire[1], BINARY_FRAME_VERSION);
  assert.equal((wire[2] << 8) | wire[3], 0, 'metaLen is zero without meta');
  // w/h/sw/sh as big-endian u32 at offsets 4/8/12/16, jpegLen at 20.
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  assert.equal(view.getUint32(4), 1);
  assert.equal(view.getUint32(8), 2);
  assert.equal(view.getUint32(12), 3);
  assert.equal(view.getUint32(16), 4);
  assert.equal(view.getUint32(20), 1, 'jpegLen counts the payload bytes');
  assert.equal(wire[BINARY_FRAME_HEADER_BYTES], 0xab);
});

test('boundary dimensions round-trip: zero and the maximum', () => {
  for (const d of [0, 1, MAX_FRAME_DIMENSION]) {
    const frame = decodeBinaryFrame(encodeBinaryFrame({ w: d, h: d, sw: d, sh: d }, jpeg(9)));
    assert.ok(frame, `dimension ${d} must round-trip`);
    assert.equal(frame.w, d);
  }
});

test('encode rejects invalid input rather than emitting a bad wire frame', () => {
  const ok = { w: 10, h: 10, sw: 10, sh: 10 };
  assert.throws(() => encodeBinaryFrame({ ...ok, w: -1 }, jpeg(1)));
  assert.throws(() => encodeBinaryFrame({ ...ok, h: 1.5 }, jpeg(1)));
  assert.throws(() => encodeBinaryFrame({ ...ok, sw: MAX_FRAME_DIMENSION + 1 }, jpeg(1)));
  assert.throws(() => encodeBinaryFrame({ ...ok, sh: Number.NaN }, jpeg(1)));
  assert.throws(() => encodeBinaryFrame(ok, jpeg()), /empty/i);
  // A title long enough to overflow the u16 metaLen field must be refused, not
  // silently truncated into a frame the decoder mis-slices.
  assert.throws(() => encodeBinaryFrame({ ...ok, meta: { title: 'x'.repeat(70000) } }, jpeg(1)));
});

test('decode rejects every truncated prefix of a valid frame', () => {
  const wire = encodeBinaryFrame(
    { w: 320, h: 200, sw: 640, sh: 400, meta: { title: 't' } },
    jpeg(1, 2, 3, 4),
  );
  for (let len = 0; len < wire.length; len++) {
    assert.equal(decodeBinaryFrame(wire.subarray(0, len)), null, `length ${len} must be rejected`);
  }
  assert.ok(decodeBinaryFrame(wire), 'the full frame still decodes');
});

test('decode rejects a wrong magic, wrong version, or oversized dimension', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1));
  const flip = (offset: number, value: number): Uint8Array => {
    const copy = wire.slice();
    copy[offset] = value;
    return copy;
  };
  assert.equal(decodeBinaryFrame(flip(0, 0x00)), null, 'magic');
  assert.equal(decodeBinaryFrame(flip(1, 99)), null, 'version');
  assert.equal(decodeBinaryFrame(flip(4, 0xff)), null, 'w beyond MAX_FRAME_DIMENSION');
});

test('decode rejects trailing garbage after the declared JPEG length', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1, 2));
  const padded = new Uint8Array(wire.length + 1);
  padded.set(wire, 0);
  assert.equal(decodeBinaryFrame(padded), null);
});

test('decode rejects a metaLen that points past the end of the buffer', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1, 2)).slice();
  wire[3] = 200; // claims 200 bytes of meta in a 2-byte payload
  assert.equal(decodeBinaryFrame(wire), null);
});

test('decode rejects meta bytes that are not a JSON object', () => {
  const bad = new TextEncoder().encode('not json');
  const good = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8, meta: { a: 1 } }, jpeg(7));
  const wire = good.slice();
  wire.set(bad, BINARY_FRAME_HEADER_BYTES); // same length as {"a":1} + '7' — corrupt in place
  assert.equal(decodeBinaryFrame(wire), null);
});

test('decode never mutates or aliases its input', () => {
  const wire = encodeBinaryFrame({ w: 8, h: 8, sw: 8, sh: 8 }, jpeg(1, 2, 3));
  const before = Array.from(wire);
  const frame = decodeBinaryFrame(wire);
  assert.ok(frame);
  wire.fill(0); // clobber the wire buffer after decode
  assert.deepEqual(Array.from(frame.jpeg), [1, 2, 3], 'decoded pixels must be a copy');
  assert.deepEqual(before.slice(0, 4), [BINARY_FRAME_MAGIC, BINARY_FRAME_VERSION, 0, 0]);
});

test('isBinaryFramePayload sniffs ArrayBuffer and views, never strings', () => {
  assert.equal(isBinaryFramePayload(new ArrayBuffer(4)), true);
  assert.equal(isBinaryFramePayload(new Uint8Array(4)), true);
  assert.equal(isBinaryFramePayload('{"type":"frame"}'), false);
  assert.equal(isBinaryFramePayload(null), false);
  assert.equal(isBinaryFramePayload(undefined), false);
  assert.equal(isBinaryFramePayload(42), false);
});

test('bytesToBase64 matches Buffer for every padding remainder', () => {
  for (const len of [0, 1, 2, 3, 4, 255, 256, 1000]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${len}`);
  }
});
