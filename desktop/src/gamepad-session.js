export const emptySender = () => ({ sample: null, changedAt: 0, sentAt: 0, seq: 0 });
export function nextSample(previous, sample, now, bufferedAmount = 0) {
  if (!sample || !Number.isFinite(now) || bufferedAmount > 34) return previous;
  const changed = !previous.sample || Object.keys(sample).some(k => sample[k] !== previous.sample[k]);
  if (!changed && now - previous.changedAt > 100 && now - previous.sentAt < 250) return previous;
  return { sample: { ...sample }, changedAt: changed ? now : previous.changedAt, sentAt: now, seq: (previous.seq + 1) >>> 0 };
}
export function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return null;
    if (m.type === 'rumble' && [m.low, m.high].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
      // The established host wire format is normalized, not bytes.
      return { type: 'rumble', low: m.low * 255, high: m.high * 255 };
    }
    if (m.type === 'hello' && ['vigem','keymap','unavailable'].includes(m.backend) && m.available === (m.backend !== 'unavailable')) {
      return { type: 'hello', backend: m.backend, available: m.available, reason: typeof m.reason === 'string' ? m.reason.slice(0, 500) : '' };
    }
  } catch { /* ignore malformed host messages */ }
  return null;
}
export function rumbleEffect(low, high) {
  if (![low, high].every(n => Number.isFinite(n) && n >= 0 && n <= 255)) return null;
  return { duration: 500, startDelay: 0, strongMagnitude: low / 255, weakMagnitude: high / 255 };
}
export function controllerLabel(kind, backend) {
  const name = { dualsense: 'DualSense', dualshock: 'DualShock 4', xbox: 'Xbox', generic: 'Generic' }[kind] ?? 'No pad';
  const glyphs = kind === 'dualsense' || kind === 'dualshock' ? '✕ ○ □ △' : 'ABXY';
  const target = { vigem: 'Xbox controller', keymap: 'Keyboard / mouse fallback' }[backend] ?? 'unavailable';
  return `Controller: ${name} · ${glyphs} · ${target}`;
}
export function streamConfig(gaming, defaults, screen) {
  return { type: 'config', ...(gaming ? { w: 1600, q: 65, fps: 30 } : defaults), ...(screen === undefined ? {} : { screen }) };
}
