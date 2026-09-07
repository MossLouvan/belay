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
import { emptyExit, exitHold } from './guide';
import { hostStatus, reconnectStatus, usesPhysicalController } from './session-policy';
import type { InputMode } from './session-policy';

export function useGamepad(enabled: boolean, preset: PresetId, connectionKey: string, onGuideExit: () => void, monitor = enabled) {
  const theme = useTheme();
  const exitRef = useRef(onGuideExit); exitRef.current = onGuideExit;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [physical, setPhysical] = useState(false);
  const [kind, setKind] = useState<ControllerKind>('generic');
  const [backend, setBackend] = useState('Connecting to the computer…');
  const [keymap, setKeymap] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('auto');
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [exitProgress, setExitProgress] = useState(0);
  const inputModeRef = useRef(inputMode); inputModeRef.current = inputMode;
  const touch = useRef<GamepadState>(NEUTRAL);
  const controller = useRef<GamepadState>(NEUTRAL);
  const physicalRef = useRef(false);
  const escape = useRef(emptyExit());
  const guidePressed = useRef(false);
  const touchExitPressed = useRef(false);
  const setExitPressed = useCallback((pressed: boolean) => { touchExitPressed.current = pressed; }, []);
  const changeInputMode = useCallback((mode: InputMode) => {
    touch.current = NEUTRAL; controller.current = NEUTRAL;
    escape.current = emptyExit(); guidePressed.current = false;
    inputModeRef.current = mode; setInputMode(mode); setExitProgress(0);
  }, []);
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
      escape.current = emptyExit(); guidePressed.current = false; setExitProgress(0);
      setControllerError(null);
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
    void gamepadNative?.start(theme.colors.accent).then(connection).catch(() => {
      if (live) setControllerError('Bluetooth input could not start. Phone controls are available.');
    });
    return () => {
      live = false; events?.remove(); connections?.remove();
      physicalRef.current = false; setPhysical(false); controller.current = NEUTRAL; touch.current = NEUTRAL;
      setKind('generic'); escape.current = emptyExit(); guidePressed.current = false;
      void gamepadNative?.stop().catch(() => { });
    };
  }, [monitor, foreground, theme.colors.accent]);
  useEffect(() => {
    if (!enabled || !foreground) return;
    let live = true, ready = false, seq = 0;
    let failure: string | null = null;
    let connecting = true;
    let progressAt = 0;
    escape.current = emptyExit(); touchExitPressed.current = false; setExitProgress(0); setKeymap(false);
    let rumbleAt: number | null = null;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = async (): Promise<void> => {
      setBackend(connecting ? 'Connecting to the computer…' : reconnectStatus(failure));
      connecting = false;
      try {
        const url = await wsUrl('/ws/gamepad', { preset });
        if (!live) return;
        const socket = new WebSocket(url); ws = socket; socket.binaryType = 'arraybuffer';
        socket.onmessage = event => {
          if (!live || ws !== socket) return;
          const message = parseGamepadMessage(event.data);
          if (message?.type === 'hello') {
            ready = message.available;
            failure = message.available ? null : hostStatus(message);
            setKeymap(message.backend === 'keymap');
            setBackend(hostStatus(message));
          } else if (message?.type === 'rumble') {
            rumbleAt = Date.now(); void gamepadNative?.rumble(message.low, message.high).catch(() => { });
          }
        };
        socket.onerror = () => socket.close();
        socket.onclose = event => {
          if (ws !== socket) return;
          ready = false; ws = null;
          void gamepadNative?.rumble(0, 0).catch(() => { });
          if (live) {
            failure = failure || event.reason || null;
            setKeymap(false); setBackend(reconnectStatus(failure));
            retry = setTimeout(() => { void open(); }, 1500);
          }
        };
      } catch (error) {
        if (live) {
          failure = failure || (error instanceof Error ? error.message : null);
          setBackend(reconnectStatus(failure)); retry = setTimeout(() => { void open(); }, 1500);
        }
      }
    };
    void open();
    // Full-state heartbeat also repairs missed releases. No unbounded send queue.
    const timer = setInterval(() => {
      const now = Date.now();
      const physicalInput = usesPhysicalController(inputModeRef.current, physicalRef.current);
      const input = physicalInput ? controller.current : touch.current;
      const previous = escape.current;
      escape.current = exitHold(previous, input.buttons, physicalInput && guidePressed.current, touchExitPressed.current, now);
      if (now - progressAt >= 40 || previous.suppress !== escape.current.suppress || escape.current.exit) {
        progressAt = now; setExitProgress(escape.current.progress);
      }
      if (escape.current.exit) { controller.current = NEUTRAL; touch.current = NEUTRAL; exitRef.current(); return; }
      if (rumbleAt !== null && Date.now() - rumbleAt > 750) { rumbleAt = null; void gamepadNative?.rumble(0, 0).catch(() => { }); }
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 34) return;
      const state = escape.current.suppress ? NEUTRAL : input;
      try { ws.send(encodeGamepad({ ...state, seq })); seq = (seq + 1) >>> 0; } catch { ws.close(); }
    }, 8);
    return () => {
      live = false; clearInterval(timer); if (retry) clearTimeout(retry);
      if (ws?.readyState === WebSocket.OPEN) { try { ws.send(encodeGamepad({ ...NEUTRAL, seq })); } catch {/* closing */ } }
      ws?.close(); void gamepadNative?.rumble(0, 0).catch(() => { });
      touch.current = NEUTRAL;
      touchExitPressed.current = false; escape.current = emptyExit(); setExitProgress(0);
    };
  }, [enabled, foreground, preset, connectionKey]);
  return { physical, usingPhysical: usesPhysicalController(inputMode, physical), inputMode, setInputMode: changeInputMode,
    kind, backend, keymap, updateTouch, foreground, controllerError, exitProgress, setExitPressed };
}
