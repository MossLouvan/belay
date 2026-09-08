// How controller samples reach the host. Two implementations of one shape:
//
//   nativeTransport — the socket and the 8 ms send loop live in the iOS module
//   (modules/belay-gamepad/ios/GamepadSession.swift). JS feeds state in and
//   receives the host's text messages; a stalled JS thread cannot go quiet on
//   the wire, which is what the host's 2 s watchdog punishes.
//
//   jsTransport — the original loop, kept for web and for a binary without the
//   native session. Same wire, same gating, same neutral-on-close.
//
// use-gamepad.ts owns everything above the wire: exit hold, status strings,
// reconnect backoff, rumble. This file stays free of the native module import
// so the node test runner can load it; select-transport.ts does the choosing.

import type { GamepadNative } from '../../modules/belay-gamepad/src';
import { encodeGamepad, NEUTRAL } from './codec.ts';
import type { GamepadState } from './codec.ts';
import { parseGamepadMessage } from './messages.ts';
import { usesPhysicalController } from './session-policy.ts';
import type { InputMode } from './session-policy.ts';

export interface TransportEvents {
  readonly onMessage: (text: string) => void;
  readonly onClose: (code: number, reason: string) => void;
}

export interface GamepadTransport {
  /** Connect to a fully formed /ws/gamepad URL (ticket and preset included). */
  readonly open: (url: string) => void;
  /** Send one neutral frame, close, and stop reporting events. */
  readonly close: () => void;
  readonly setTouch: (state: GamepadState) => void;
  readonly setPhysical: (state: GamepadState) => void;
  readonly setPhysicalConnected: (connected: boolean) => void;
  readonly setInputMode: (mode: InputMode) => void;
  /** While true the wire carries neutral (the exit hold is in progress). */
  readonly setSuppressed: (value: boolean) => void;
}

const SEND_INTERVAL_MS = 8;
/** One frame is 17 bytes; two queued means the link is stalling. */
const MAX_BUFFERED_BYTES = 34;

export function nativeTransport(events: TransportEvents, native: GamepadNative | null): GamepadTransport {
  let live = true;
  const messages = native?.addListener('onSessionMessage', raw => {
    const text = (raw as { text?: unknown } | null)?.text;
    if (live && typeof text === 'string') events.onMessage(text);
  });
  const closes = native?.addListener('onSessionClose', raw => {
    const event = (raw as { code?: unknown; reason?: unknown } | null) ?? {};
    if (!live) return;
    events.onClose(typeof event.code === 'number' ? event.code : 1006, typeof event.reason === 'string' ? event.reason : '');
  });
  const ignore = (): void => { /* the module logs; JS has nothing to add */ };
  return {
    open: url => {
      void native?.startSession?.(url).catch(error => {
        if (live) events.onClose(1006, error instanceof Error ? error.message : 'native session failed');
      });
    },
    close: () => {
      live = false; messages?.remove(); closes?.remove();
      void native?.stopSession?.().catch(ignore);
    },
    setTouch: state => { void native?.setTouchState?.(state).catch(ignore); },
    // The module samples the pad itself; JS only mirrors it for the HUD.
    setPhysical: () => { },
    setPhysicalConnected: () => { },
    setInputMode: mode => { void native?.setInputMode?.(mode).catch(ignore); },
    setSuppressed: value => { void native?.setSuppressed?.(value).catch(ignore); },
  };
}

export function jsTransport(events: TransportEvents): GamepadTransport {
  let live = true, ready = false, seq = 0;
  let ws: WebSocket | null = null;
  let touch: GamepadState = NEUTRAL, physical: GamepadState = NEUTRAL;
  let physicalConnected = false, mode: InputMode = 'auto', suppressed = false;
  const send = (state: GamepadState): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(encodeGamepad({ ...state, seq })); seq = (seq + 1) >>> 0; } catch { ws.close(); }
  };
  // Full-state heartbeat also repairs missed releases. No unbounded send queue.
  const timer = setInterval(() => {
    if (!ready || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    const input = usesPhysicalController(mode, physicalConnected) ? physical : touch;
    send(suppressed ? NEUTRAL : input);
  }, SEND_INTERVAL_MS);
  return {
    open: url => {
      if (!live) return;
      const socket = new WebSocket(url); ws = socket; socket.binaryType = 'arraybuffer';
      socket.onmessage = event => {
        if (!live || ws !== socket || typeof event.data !== 'string') return;
        const message = parseGamepadMessage(event.data);
        if (message?.type === 'hello') ready = message.available;
        events.onMessage(event.data);
      };
      socket.onerror = () => socket.close();
      socket.onclose = event => {
        if (ws !== socket) return;
        ready = false; ws = null;
        if (live) events.onClose(event.code, event.reason ?? '');
      };
    },
    close: () => {
      live = false; clearInterval(timer);
      if (ws?.readyState === WebSocket.OPEN) send(NEUTRAL);
      ws?.close(); ws = null;
    },
    setTouch: state => { touch = state; },
    setPhysical: state => { physical = state; },
    setPhysicalConnected: connected => { physicalConnected = connected; if (!connected) physical = NEUTRAL; },
    setInputMode: next => { mode = next; touch = NEUTRAL; physical = NEUTRAL; },
    setSuppressed: value => { suppressed = value; },
  };
}
