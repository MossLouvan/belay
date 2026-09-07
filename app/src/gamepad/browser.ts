import type { GamepadState } from './codec';
const NEUTRAL: GamepadState = Object.freeze({ buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 });

const BITS = [4096,8192,16384,32768,256,512,0,0,32,16,64,128,1,2,4,8,0];
export function browserState(pad: Gamepad | null): GamepadState | null {
  if (!pad?.connected || pad.mapping !== 'standard' || pad.axes.length < 4 || pad.buttons.length < 17) return null;
  if (!pad.axes.slice(0,4).every(Number.isFinite) || !pad.buttons.slice(0,17).every(b => Number.isFinite(b.value))) return null;
  const axis = (n: number) => Math.max(-1, Math.min(1, n));
  return { buttons: BITS.reduce((mask, bit, i) => pad.buttons[i].pressed ? mask | bit : mask, 0),
    lx: axis(pad.axes[0]), ly: axis(-pad.axes[1]), rx: axis(pad.axes[2]), ry: axis(-pad.axes[3]),
    lt: Math.max(0, Math.min(1, pad.buttons[6].value)), rt: Math.max(0, Math.min(1, pad.buttons[7].value)) };
}

/** Same event contract as the iOS module; no native build needed on the web. */
export function createBrowserGamepad() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let running = false, frame = 0, pad: Gamepad | null = null;
  const emit = (name: string, event: unknown) => listeners.get(name)?.forEach(fn => fn(event));
  const connection = () => ({ connected: !!pad, kind: pad ? /09cc|05c4|dualshock/i.test(pad.id) ? 'dualshock' : /054c|dualsense|wireless controller/i.test(pad.id) ? 'dualsense' : /xbox|045e/i.test(pad.id) ? 'xbox' : 'generic' : 'generic' });
  const poll = () => {
    if (!running) return;
    let next: Gamepad | null = null;
    try { if (!document.hidden) next = Array.from(navigator.getGamepads?.() ?? []).find(p => browserState(p) !== null) ?? null; } catch { /* permission denied: remain on touch controls */ }
    if (next?.id !== pad?.id || next?.index !== pad?.index) { pad = next; emit('onConnection', connection()); }
    else pad = next;
    emit('onState', pad ? { ...browserState(pad), guide: pad.buttons[16]?.pressed === true } : NEUTRAL);
    frame = requestAnimationFrame(poll);
  };
  const visibility = () => { if (document.hidden) { pad = null; emit('onConnection', connection()); emit('onState', NEUTRAL); } };
  return {
    addListener(name: string, listener: (event: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return { remove: () => { listeners.get(name)?.delete(listener); } };
    },
    async start(_accent: string) { if (!running) { running = true; document.addEventListener('visibilitychange', visibility); poll(); } return connection(); },
    async stop() { running = false; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); pad = null; },
    async rumble(low: number, high: number) {
      const actuator = (pad as (Gamepad & { vibrationActuator?: { playEffect(type: string, effect: object): Promise<unknown> } }) | null)?.vibrationActuator;
      await actuator?.playEffect('dual-rumble', { duration: 500, startDelay: 0, strongMagnitude: Math.max(0, Math.min(1, low)), weakMagnitude: Math.max(0, Math.min(1, high)) });
    },
  };
}
