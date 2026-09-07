import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, firstPad, standardState, encodeFrame } from '../src/gamepad-codec.js';

const pad = (pressed = [], axes = [0, 0, 0, 0]) => Object.freeze({
  connected: true, mapping: 'standard', id: 'DualSense', axes: Object.freeze(axes),
  buttons: Object.freeze(Array.from({ length: 17 }, (_, i) => Object.freeze({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }))),
});
test('standard buttons use XUSB positions; Guide is never forwarded', () => {
  const bits = [4096,8192,16384,32768,256,512,0,0,32,16,64,128,1,2,4,8,0];
  bits.forEach((bit, index) => assert.equal(standardState(pad([index])).buttons, bit));
  assert.equal(standardState(pad(bits.map((_, i) => i))).buttons, 0xf3ff);
});
test('analog triggers and inverted Y encode exact 17-byte little endian frame', () => {
  const source = pad([], [-1, -1, 1, 1]);
  const state = standardState({ ...source, buttons: source.buttons.map((b, i) => ({ ...b, value: i === 6 ? 0.5 : i === 7 ? 1 : 0 })) });
  assert.deepEqual(state, { buttons: 0, lt: 128, rt: 255, lx: -32768, ly: 32767, rx: 32767, ry: -32768 });
  assert.deepEqual([...new Uint8Array(encodeFrame(state, 0x12345678))], [1,0,0,128,255,0,128,255,127,255,127,0,128,120,86,52,18]);
  assert.throws(() => encodeFrame(state, -1));
});
test('invalid samples are rejected; finite browser drift is clamped', () => {
  for (const p of [null, {}, { ...pad(), mapping: '' }, { ...pad(), connected: false }, pad([], [NaN,0,0,0]), { ...pad(), buttons: [] }]) assert.equal(standardState(p), null);
  assert.equal(standardState(pad([], [2,0,0,0])).lx, 32767);
  assert.equal(firstPad([null, { connected: false }, pad()]).id, 'DualSense');
});
test('kind detection validates ids and recognizes both Sony generations', () => {
  for (const id of ['054c-0ce6', 'DualSense Wireless Controller', 'Wireless Controller', 'Vendor: 054c Product: 0ce6', '054c']) assert.equal(kindOf(id), 'dualsense');
  for (const id of ['Wireless Controller (054c:09cc)', '054c-05c4', 'DualShock 4']) assert.equal(kindOf(id), 'dualshock');
  for (const id of ['Xbox 360 Controller', '045e-028e', 'XInput STANDARD GAMEPAD']) assert.equal(kindOf(id), 'xbox');
  for (const id of [null, {}, 54, '', 'Joystick', 'x'.repeat(1025)]) assert.equal(kindOf(id), 'generic');
});
