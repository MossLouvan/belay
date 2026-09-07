import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BINARY_FRAME, decodeBinaryFrame, decodeBase64Frame } from '../src/binary-frame.js';

function frame({ metaLen = 0, jpeg = [0xff, 0xd8, 0xff, 0xd9], w = 640, version = 1, jpegLen = jpeg.length, extra = [] } = {}) {
  const buffer = new ArrayBuffer(BINARY_FRAME.header + metaLen + jpeg.length + extra.length);
  const view = new DataView(buffer);
  view.setUint8(0, BINARY_FRAME.magic);
  view.setUint8(1, version);
  view.setUint16(2, metaLen);
  view.setUint32(4, w);
  view.setUint32(8, 360);
  view.setUint32(12, w);
  view.setUint32(16, 360);
  view.setUint32(20, jpegLen);
  new Uint8Array(buffer).set([...new Array(metaLen).fill(0x20), ...jpeg, ...extra], BINARY_FRAME.header);
  return buffer;
}

test('a well-formed frame yields exactly its JPEG bytes', () => {
  const decoded = decodeBinaryFrame(frame({ metaLen: 3 }));
  assert.deepEqual([...decoded.jpeg], [0xff, 0xd8, 0xff, 0xd9]);
});

test('truncation, trailing garbage, a wrong version and absurd sizes are all rejected', () => {
  assert.equal(decodeBinaryFrame(frame({ jpegLen: 10 })), null);
  assert.equal(decodeBinaryFrame(frame({ extra: [1] })), null);
  assert.equal(decodeBinaryFrame(frame({ version: 2 })), null);
  assert.equal(decodeBinaryFrame(frame({ w: BINARY_FRAME.maxDimension + 1 })), null);
  assert.equal(decodeBinaryFrame(new ArrayBuffer(5)), null);
  assert.equal(decodeBinaryFrame('not a buffer'), null);
});

test('a legacy base64 payload decodes to bytes and rubbish decodes to null', () => {
  assert.deepEqual([...decodeBase64Frame(Buffer.from([1, 2, 3]).toString('base64'))], [1, 2, 3]);
  assert.equal(decodeBase64Frame(''), null);
  assert.equal(decodeBase64Frame(42), null);
  assert.equal(decodeBase64Frame('***'), null);
});
