import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGamepad, decodeGamepad, newerSequence, NEUTRAL } from './codec.ts';

test('golden vector shared with the native encoder (ios/GamepadSession.swift)', () => {
  // Pinned bytes, not a round trip: the Swift encoder is written to this exact
  // output (note lt 0.5 → 128, JS Math.round rounds halves up), so a change on
  // either side must change this line too.
  const bytes = encodeGamepad({ buttons: 0x1234, lt: 0.5, rt: 1, lx: -0.25, ly: 0.75, rx: -1, ry: 0, seq: 0xDEADBEEF });
  assert.equal([...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(' '),
    '01 34 12 80 ff 00 e0 ff 5f 00 80 00 00 ef be ad de');
});

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

test('phone and host codecs are byte-for-byte interoperable over deterministic samples', async () => {
 const host=await import('../../../server/src/gamepad-codec.ts');
 for(let i=0;i<256;i++){
  const state={buttons:i*257,lt:i/255,rt:(255-i)/255,lx:Math.sin(i),ly:Math.cos(i),rx:0,ry:-1,seq:i};
  assert.deepEqual(host.encodeGamepad(state),encodeGamepad(state));
  assert.deepEqual(host.decodeGamepad(encodeGamepad(state)),decodeGamepad(host.encodeGamepad(state)));
 }
});

test('desktop standard mapping matches phone/host codec quantization', async () => {
 const desktop = await import('../../../desktop/src/gamepad-codec.js');
 for (let i=0;i<256;i++) {
  const axes = [Math.sin(i), Math.cos(i), -1, 1];
  const buttons = Array.from({length:17},(_,n)=>({pressed:n===0,value:n===6?i/255:n===7?(255-i)/255:0}));
  const sample = desktop.standardState({ connected:true, mapping:'standard', axes, buttons });
  assert.deepEqual(desktop.encodeFrame(sample,i),encodeGamepad({buttons:4096,lt:i/255,rt:(255-i)/255,lx:axes[0],ly:-axes[1],rx:-1,ry:-1,seq:i}));
 }
});
