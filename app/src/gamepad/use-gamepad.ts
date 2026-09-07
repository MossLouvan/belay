import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { wsUrl } from '../api';
import { gamepadNative } from '../../modules/belay-gamepad/src';
import { encodeGamepad, NEUTRAL, validState } from './codec';
import type { GamepadState } from './codec';
import type { PresetId } from './presets';
import { parseGamepadMessage } from './messages';
import { useTheme } from '../theme';
import { kindOf } from './glyphs';
import type { ControllerKind } from './glyphs';
import { emptyGuide, guideHold } from './guide';

export function useGamepad(enabled: boolean, preset: PresetId, connectionKey: string, onGuideExit: () => void, monitor = enabled) {
  const theme = useTheme();
  const exitRef = useRef(onGuideExit); exitRef.current = onGuideExit;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [physical, setPhysical] = useState(false);
  const [kind, setKind] = useState<ControllerKind>('generic');
  const [backend, setBackend] = useState('Connecting controller…');
  const [keymap, setKeymap] = useState(false);
  const touch = useRef<GamepadState>(NEUTRAL);
  const controller = useRef<GamepadState>(NEUTRAL);
  const physicalRef = useRef(false);
  const guide = useRef(emptyGuide());
  const guidePressed = useRef(false);
  const updateTouch = useCallback((state: GamepadState) => { if (validState(state)) touch.current = state; }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!monitor || !foreground) return;
    let live = true;
    const connection = (raw: unknown): void => {
      if (!live || !raw || typeof raw !== 'object') return;
      const event = raw as Record<string, unknown>;
      if (typeof event.connected !== 'boolean') return;
      controller.current = NEUTRAL; touch.current = NEUTRAL;
      guide.current = emptyGuide(); guidePressed.current = false;
      physicalRef.current = event.connected; setPhysical(event.connected);
      setKind(event.connected ? kindOf(event.kind) : 'generic');
    };
    const events = gamepadNative?.addListener('onState', raw => {
      if (live && validState(raw)) {
        controller.current = raw;
        guidePressed.current = 'guide' in raw && raw.guide === true;
      }
    });
    const connections = gamepadNative?.addListener('onConnection', connection);
    void gamepadNative?.start(theme.colors.accent).then(connection).catch(() => { if (live) setBackend('Physical controller module could not start'); });
    return () => {
      live = false; events?.remove(); connections?.remove();
      physicalRef.current = false; setPhysical(false); controller.current = NEUTRAL; touch.current = NEUTRAL;
      setKind('generic'); guide.current = emptyGuide(); guidePressed.current = false;
      void gamepadNative?.stop().catch(() => { });
    };
  }, [monitor, foreground, theme.colors.accent]);
  useEffect(() => {
    if (!enabled || !foreground) return;
    let live = true, ready = false, seq = 0;
    let rumbleAt: number | null = null;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = async (): Promise<void> => {
      setBackend('Connecting controller…');
      try {
        const url = await wsUrl('/ws/gamepad', { preset });
        if (!live) return;
        const socket = new WebSocket(url); ws = socket; socket.binaryType = 'arraybuffer';
        socket.onmessage = event => {
          if (!live || ws !== socket) return;
          const message = parseGamepadMessage(event.data);
          if (message?.type === 'hello') {
            ready = message.available;
            setKeymap(message.backend === 'keymap');
            setBackend(message.available ? (message.backend === 'vigem' ? 'Xbox controller' : 'Keyboard / mouse fallback') : message.reason ?? 'Controller unavailable');
          } else if (message?.type === 'rumble') {
            rumbleAt = Date.now(); void gamepadNative?.rumble(message.low, message.high).catch(() => { });
          }
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
          if (ws !== socket) return;
          ready = false; ws = null;
          void gamepadNative?.rumble(0, 0).catch(() => { });
          if (live) { setBackend('Controller disconnected · reconnecting'); retry = setTimeout(() => { void open(); }, 1500); }
        };
      } catch { if (live) { setBackend('Controller unavailable · reconnecting'); retry = setTimeout(() => { void open(); }, 1500); } }
    };
    void open();
    // Full-state heartbeat also repairs missed releases. No unbounded send queue.
    const timer = setInterval(() => {
      guide.current = guideHold(guide.current, physicalRef.current && guidePressed.current, Date.now());
      if (guide.current.exit) { controller.current = NEUTRAL; exitRef.current(); return; }
      if (rumbleAt !== null && Date.now() - rumbleAt > 750) { rumbleAt = null; void gamepadNative?.rumble(0, 0).catch(() => { }); }
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 34) return;
      const state = physicalRef.current ? controller.current : touch.current;
      try { ws.send(encodeGamepad({ ...state, seq })); seq = (seq + 1) >>> 0; } catch { ws.close(); }
    }, 8);
    return () => {
      live = false; clearInterval(timer); if (retry) clearTimeout(retry);
      if (ws?.readyState === WebSocket.OPEN) { try { ws.send(encodeGamepad({ ...NEUTRAL, seq })); } catch {/* closing */ } }
      ws?.close(); void gamepadNative?.rumble(0, 0).catch(() => { });
      touch.current = NEUTRAL;
    };
  }, [enabled, foreground, preset, connectionKey]);
  return { physical, kind, backend, keymap, updateTouch, foreground };
}
