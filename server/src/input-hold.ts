// Live drags (#136): /input/down presses, /input/move drags while held,
// /input/up releases. /input/drag stays for old phones.
//
// A press the phone never releases (app killed, network gone mid-drag) would
// leave the host's button physically held, turning every later move into a
// drag. The hold guard releases it after a quiet spell; moves re-arm it.

type Button = 'left' | 'right' | 'middle';

interface HoldNative {
  down?(button: string, x?: number, y?: number, screen?: number, window?: string): Promise<unknown>;
  up(button: string, x?: number, y?: number, screen?: number, window?: string): Promise<unknown>;
}

interface Timers {
  set(fn: () => unknown, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createHoldGuard(native: HoldNative, quietMs: number, timers: Timers = realTimers) {
  let timer: unknown;
  let hold: { button: string; screen?: number; window?: string } | undefined;
  const disarm = () => { if (timer !== undefined) timers.clear(timer); timer = undefined; };
  const releaseNow = async () => {
    disarm();
    const h = hold;
    hold = undefined;
    if (h) await native.up(h.button, undefined, undefined, h.screen, h.window).catch(() => {});
  };
  const arm = () => { disarm(); if (hold) timer = timers.set(releaseNow, quietMs); };
  return {
    held(button: string, screen?: number, window?: string) { hold = { button, screen, window }; arm(); },
    /** A move while held: the finger is still there, push the deadline out. */
    touch: arm,
    released() { hold = undefined; disarm(); },
    releaseNow,
    get holding() { return hold !== undefined; },
  };
}

export type HoldGuard = ReturnType<typeof createHoldGuard>;

export function parseHold(body: unknown):
  | { ok: true; button: Button; x: number; y: number }
  | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const { x, y, button = 'left' } = b;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: 'needs finite x,y' };
  }
  if (button !== 'left' && button !== 'right' && button !== 'middle') return { ok: false, error: 'unknown button' };
  return { ok: true, button, x, y };
}

interface Res { status(code: number): Res; json(body: unknown): unknown }
interface HoldDeps {
  auth: unknown;
  withFloor(req: any, res: any, act: () => Promise<void>): Promise<boolean>;
  native: Required<HoldNative>;
  screenIndexOf(v: unknown): number | undefined;
  windowIdOf(v: unknown): string | undefined;
  guard: HoldGuard;
}

export function registerHoldRoutes(app: { post(path: string, ...handlers: any[]): unknown }, d: HoldDeps) {
  const route = (verb: 'down' | 'up') => async (req: any, res: Res) => {
    try {
      const p = parseHold(req.body);
      if (!p.ok) { res.status(400).json({ error: `${verb} ${p.error}` }); return; }
      const screen = d.screenIndexOf(req.body?.screen);
      const window = d.windowIdOf(req.body?.window);
      const granted = await d.withFloor(req, res, async () => {
        await d.native[verb](p.button, p.x, p.y, screen, window);
        if (verb === 'down') d.guard.held(p.button, screen, window);
        else d.guard.released();
        res.json({ ok: true });
      });
      // Refused release (someone else took the floor mid-drag): still let go of
      // the button we pressed, without moving the pointer.
      if (!granted && verb === 'up') await d.guard.releaseNow();
    } catch (e: any) {
      if (verb === 'down') await d.guard.releaseNow();
      res.status(500).json({ error: e.message });
    }
  };
  app.post('/input/down', d.auth, route('down'));
  app.post('/input/up', d.auth, route('up'));
}
