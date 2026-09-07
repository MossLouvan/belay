import { decodeGamepad, NEUTRAL } from './gamepad-codec.js';
import type { GamepadState } from './gamepad-codec.js';
import { acceptFrame, emptySession, helperHello, takeFrame } from './gamepad-session.js';

interface GamepadSocket {
  readonly readyState: number; readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}
export interface GamepadHelper {
  gamepadAttach(preset: string): Promise<unknown>;
  gamepadDetach(): Promise<unknown>;
  gamepad(state: GamepadState): boolean;
  onGamepadEvent(listener: (event: unknown) => void): () => void;
}
interface Options {
  readonly now?: () => number;
  readonly schedule?: (tick: () => void) => () => void;
  readonly onActivity?: (injected: boolean) => void;
}
/** One virtual target per host. Ownership survives asynchronous attach/detach. */
export function createGamepadHub(helper: GamepadHelper, options: Options = {}) {
  let owned = false;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((tick: () => void) => { const timer = setInterval(tick, 4); timer.unref(); return () => clearInterval(timer); });
  return {
    handle(ws: GamepadSocket, preset: string): void {
      const send = (message: object): void => { if (ws.readyState === 1 && ws.bufferedAmount < 4096) ws.send(JSON.stringify(message)); };
      if (owned) { send({ type: 'hello', available: false, backend: 'unavailable', reason: 'Another controller is connected' }); ws.close(1008, 'Controller busy'); return; }
      owned = true;
      let closed = false, attached = false, cleaning = false;
      let session = emptySession();
      let keymap = false, wasActive = false;
      let rumble: { readonly type: 'rumble'; readonly low: number; readonly high: number } | null = null;
      let rumbleAt = 0;
      let stop = () => { };
      let unlisten = () => { };
      const detach = async (): Promise<void> => {
        if (cleaning) return; cleaning = true;
        try { await helper.gamepadDetach(); } catch {/* helper watchdog also neutralizes */ } finally { owned = false; }
      };
      const close = (): void => { if (closed) return; closed = true; stop(); unlisten(); if (attached) void detach(); };
      ws.on('close', close); ws.on('error', () => { close(); ws.close(); });
      ws.on('message', (data, isBinary) => {
        if (closed || !attached) return;
        if (!isBinary || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) { ws.close(1003, 'Binary gamepad frames required'); close(); return; }
        const frame = decodeGamepad(data);
        if (!frame) { ws.close(1007, 'Invalid gamepad frame'); close(); return; }
        session = acceptFrame(session, frame, now());
      });
      void helper.gamepadAttach(preset === 'roblox' || preset === 'fortnite' ? preset : 'generic').then(reply => {
        attached = true;
        if (closed) { void detach(); return; }
        const hello = helperHello(reply); send(hello); keymap = hello.backend === 'keymap';
        if (!hello.available) { ws.close(1011, 'Gamepad unavailable'); close(); return; }
        unlisten = helper.onGamepadEvent(raw => {
          if (!raw || typeof raw !== 'object') return;
          const event = raw as Record<string, unknown>;
          if (event.type === 'rumble' && typeof event.low === 'number' && typeof event.high === 'number' && [event.low, event.high].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
            const message = { type: 'rumble' as const, low: event.low, high: event.high };
            send(message); rumble = event.low > 0 || event.high > 0 ? message : null; rumbleAt = now();
          }
          if (event.type === 'gamepadstatus') {
            const status = helperHello(event); send(status); keymap = status.backend === 'keymap';
            if (!status.available) { ws.close(1011, 'Native helper unavailable'); close(); }
          }
        });
        let lastActivity = 0;
        stop = schedule(() => {
          if (closed) return;
          if (session.last !== null && now() - session.receivedAt > 750) {
            helper.gamepad(NEUTRAL); ws.close(1001, 'Controller timed out'); close(); return;
          }
          if (rumble && now() - rumbleAt >= 250) { send(rumble); rumbleAt = now(); }
          if (!session.pending) return;
          if (helper.gamepad(session.pending)) {
            const frame = session.pending;
            const activeSample = frame.buttons !== 0 || frame.lt > 0 || frame.rt > 0
              || frame.lx !== 0 || frame.ly !== 0 || frame.rx !== 0 || frame.ry !== 0;
            // Neutral heartbeat isn't an OS injection. Mark the release once,
            // otherwise a parked controller masks real keyboard activity forever.
            const injected = keymap && (activeSample || wasActive);
            wasActive = activeSample;
            session = takeFrame(session);
            if (now() - lastActivity >= 100) { lastActivity = now(); options.onActivity?.(injected); }
          }
        });
      }).catch(error => {
        attached = true;
        send({ type: 'hello', available: false, backend: 'unavailable', reason: error instanceof Error ? error.message : 'Native helper unavailable' });
        ws.close(1011, 'Gamepad unavailable'); close(); if (closed) void detach();
      });
    }
  };
}
