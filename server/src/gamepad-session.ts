import { newerSequence } from './gamepad-codec.js';
import type { GamepadFrame } from './gamepad-codec.js';
export interface SessionState {
  readonly last: number | null; readonly pending: GamepadFrame | null;
  readonly windowAt: number; readonly count: number; readonly receivedAt: number;
}
export const emptySession = (): SessionState => ({ last: null, pending: null, windowAt: 0, count: 0, receivedAt: 0 });
export function acceptFrame(s: SessionState, frame: GamepadFrame, now: number): SessionState {
  if (s.last !== null && !newerSequence(frame.seq, s.last)) return s;
  const count = now - s.windowAt >= 1000 ? 0 : s.count;
  if (count >= 500) return s;
  return { last: frame.seq, pending: frame, windowAt: count === 0 ? now : s.windowAt, count: count + 1, receivedAt: now };
}
export const takeFrame = (s: SessionState): SessionState => ({ ...s, pending: null });
export interface GamepadHello { readonly type: 'hello'; readonly available: boolean; readonly backend: 'vigem' | 'keymap' | 'unavailable'; readonly reason?: string }
export function helperHello(raw: unknown): GamepadHello {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const backend = r.backend === 'vigem' || r.backend === 'keymap' ? r.backend : 'unavailable';
  return { type: 'hello', available: backend !== 'unavailable', backend, ...(typeof r.reason === 'string' ? { reason: r.reason.slice(0, 500) } : {}) };
}
