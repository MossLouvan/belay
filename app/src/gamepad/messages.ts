export type GamepadMessage =
  | { readonly type: 'hello'; readonly available: boolean; readonly backend: 'vigem' | 'keymap' | 'unavailable'; readonly reason?: string }
  | { readonly type: 'rumble'; readonly low: number; readonly high: number };
export function parseGamepadMessage(raw: unknown): GamepadMessage | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const m = value as Record<string, unknown>;
    if (m.type === 'rumble' && typeof m.low === 'number' && typeof m.high === 'number' && [m.low, m.high].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return { type: 'rumble', low: m.low, high: m.high };
    if (m.type === 'hello' && (m.backend === 'vigem' || m.backend === 'keymap' || m.backend === 'unavailable') && m.available === (m.backend !== 'unavailable')) return { type: 'hello', available: m.available, backend: m.backend, ...(typeof m.reason === 'string' ? { reason: m.reason } : {}) };
  } catch {/* malformed host message */ }
  return null;
}
