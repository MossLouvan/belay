/** Version 1: XUSB button bits, normalized axes, uint32 wraparound sequence. */
export interface GamepadState {
  readonly buttons: number;
  readonly lt: number; readonly rt: number;
  readonly lx: number; readonly ly: number; readonly rx: number; readonly ry: number;
}
export interface GamepadFrame extends GamepadState { readonly seq: number }
export const NEUTRAL: GamepadState = Object.freeze({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
export const BUTTONS = Object.freeze({ up: 1, down: 2, left: 4, right: 8, start: 16, select: 32, l3: 64, r3: 128, lb: 256, rb: 512, edit: 1024, build: 2048, a: 4096, b: 8192, x: 16384, y: 32768 });
export function validState(raw: unknown): raw is GamepadState {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return typeof s.buttons === 'number' && Number.isInteger(s.buttons) && s.buttons >= 0 && s.buttons <= 65535
    && ['lt', 'rt', 'lx', 'ly', 'rx', 'ry'].every(key => typeof s[key] === 'number' && Number.isFinite(s[key])
      && s[key] >= (key === 'lt' || key === 'rt' ? 0 : -1) && s[key] <= 1);
}
export function newerSequence(next: number, previous: number): boolean {
  const delta = (next - previous) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}
export function encodeGamepad(state: GamepadFrame): ArrayBuffer {
  if (!validState(state) || !Number.isInteger(state.seq) || state.seq < 0 || state.seq > 0xffffffff) throw new RangeError('Invalid gamepad state');
  const out = new ArrayBuffer(17);
  const v = new DataView(out);
  v.setUint8(0, 1); v.setUint16(1, state.buttons, true);
  v.setUint8(3, Math.round(state.lt * 255)); v.setUint8(4, Math.round(state.rt * 255));
  [state.lx, state.ly, state.rx, state.ry].forEach((axis, i) => v.setInt16(5 + i * 2, Math.round(axis * (axis < 0 ? 32768 : 32767)), true));
  v.setUint32(13, state.seq, true);
  return out;
}
export function decodeGamepad(raw: ArrayBuffer | ArrayBufferView): GamepadFrame | null {
  if (raw.byteLength !== 17) return null;
  const v = ArrayBuffer.isView(raw) ? new DataView(raw.buffer, raw.byteOffset, raw.byteLength) : new DataView(raw);
  if (v.getUint8(0) !== 1) return null;
  const axis = (offset: number): number => { const n = v.getInt16(offset, true); return n / (n < 0 ? 32768 : 32767); };
  return {
    buttons: v.getUint16(1, true), lt: v.getUint8(3) / 255, rt: v.getUint8(4) / 255,
    lx: axis(5), ly: axis(7), rx: axis(9), ry: axis(11), seq: v.getUint32(13, true)
  };
}
