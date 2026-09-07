import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGamepad, decodeGamepad, newerSequence, NEUTRAL } from './gamepad-codec.ts';

test('17-byte little endian packet, normalized extrema and full bitmask round trip', () => {
  const state = { buttons: 0xffff, lt: 1, rt: 0, lx: -1, ly: 1, rx: 0, ry: -0.5, seq: 0x12345678 };
  const bytes = encodeGamepad(state);
  assert.equal(bytes.byteLength, 17);
  assert.deepEqual([...new Uint8Array(bytes).slice(0, 9)], [1,255,255,255,0,0,128,255,127]);
  const result = decodeGamepad(bytes);
  for (const key of Object.keys(state)) assert.ok(Math.abs(result[key] - state[key]) < 1 / 255);
  assert.deepEqual(decodeGamepad(encodeGamepad({...NEUTRAL, seq: 0})), {...NEUTRAL, seq: 0});
});
test('rejects wrong lengths, versions and invalid outgoing values', () => {
  for (const size of [0,16,18,100]) assert.equal(decodeGamepad(new ArrayBuffer(size)), null);
  const bad = new Uint8Array(17); bad[0] = 2;
  assert.equal(decodeGamepad(bad), null);
  for (const patch of [{lx:NaN}, {lt:2}, {seq:-1}, {buttons:65536}, {buttons:1.1}]) {
    assert.throws(() => encodeGamepad({...NEUTRAL, seq:0, ...patch}));
  }
});
test('view offsets and sequence wrap are honored; duplicate and half-range rejected', () => {
  const buffer = new Uint8Array(25); buffer.set(new Uint8Array(encodeGamepad({...NEUTRAL, seq:42})), 4);
  assert.equal(decodeGamepad(buffer.subarray(4,21)).seq, 42);
  assert.equal(newerSequence(0, 0xffffffff), true);
  assert.equal(newerSequence(42,42), false);
  assert.equal(newerSequence(41,42), false);
  assert.equal(newerSequence(0x80000000,0), false);
});
