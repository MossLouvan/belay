// Browser standard mapping -> version-1 Belay frame. Values are quantized
// before change detection so sub-wire-resolution axis noise stays quiet.
const BITS = Object.freeze([4096,8192,16384,32768,256,512,0,0,32,16,64,128,1,2,4,8,0]);
export const NEUTRAL = Object.freeze({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });

export function kindOf(id) {
  if (typeof id !== 'string' || id.length > 1024) return 'generic';
  // DS4 must precede the shared Sony vendor / Wireless Controller name.
  if (/09cc|05c4|dualshock/i.test(id)) return 'dualshock';
  if (/054c|0ce6|dualsense|wireless controller/i.test(id)) return 'dualsense';
  if (/xbox|xinput|045e/i.test(id)) return 'xbox';
  return 'generic';
}
export function firstPad(pads) {
  return Array.from(pads ?? []).find(pad => pad?.connected === true) ?? null;
}
export function standardState(pad) {
  if (pad?.connected !== true || pad.mapping !== 'standard' || !Array.isArray(pad.buttons)
      || pad.buttons.length < 17 || !Array.isArray(pad.axes) || pad.axes.length < 4) return null;
  if (!pad.axes.slice(0, 4).every(Number.isFinite)
      || !pad.buttons.slice(0, 17).every(b => typeof b?.pressed === 'boolean' && Number.isFinite(b.value))) return null;
  const clamp = (n, min) => Math.max(min, Math.min(1, n));
  const axis = (n) => { const v = clamp(n, -1); return Math.round(v * (v < 0 ? 32768 : 32767)) || 0; };
  return {
    buttons: BITS.reduce((mask, bit, i) => pad.buttons[i].pressed ? mask | bit : mask, 0),
    lt: Math.round(clamp(pad.buttons[6].value, 0) * 255), rt: Math.round(clamp(pad.buttons[7].value, 0) * 255),
    lx: axis(pad.axes[0]), ly: axis(-pad.axes[1]), rx: axis(pad.axes[2]), ry: axis(-pad.axes[3]),
  };
}
export function encodeFrame(state, seq) {
  const within = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!state || !within(seq, 0, 0xffffffff) || !within(state.buttons, 0, 65535)
      || !['lt','rt'].every(k => within(state[k], 0, 255))
      || !['lx','ly','rx','ry'].every(k => within(state[k], -32768, 32767))) throw new RangeError('Invalid gamepad frame');
  const buffer = new ArrayBuffer(17), v = new DataView(buffer);
  v.setUint8(0, 1); v.setUint16(1, state.buttons, true);
  v.setUint8(3, state.lt); v.setUint8(4, state.rt);
  ['lx','ly','rx','ry'].forEach((key, i) => v.setInt16(5 + i * 2, state[key], true));
  v.setUint32(13, seq, true);
  return buffer;
}
