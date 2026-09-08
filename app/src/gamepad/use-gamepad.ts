// The Gaming session as React sees it: which pad is live, what the host said,
// the exit hold, rumble. The wire itself is a transport (transport.ts) — on
// iOS a native socket and timer that a stalled JS thread cannot starve.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { wsUrl } from '../api';
import { gamepadNative } from '../../modules/belay-gamepad/src';
import { NEUTRAL, validState } from './codec';
import type { GamepadState } from './codec';
import type { PresetId } from './presets';
import { parseGamepadMessage } from './messages';
import { useTheme } from '../theme';
import { kindOf } from './glyphs';
import type { ControllerKind } from './glyphs';
import { emptyExit, exitHold } from './guide';
import { hostStatus, reconnectStatus, usesPhysicalController } from './session-policy';
import type { InputMode } from './session-policy';
import { createTransport } from './select-transport';
import type { GamepadTransport } from './transport';

/** Exit-hold progress is UI, not wire: 16 ms is plenty for a 1.2 s ring. */
const HOLD_TICK_MS = 16;
const PROGRESS_REPAINT_MS = 40;
const RECONNECT_MS = 1500;
/** Game-generated rumble that stops being refreshed is a lost link; stop the motors. */
const RUMBLE_STALE_MS = 750;

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
  const transport = useRef<GamepadTransport | null>(null);
  const escape = useRef(emptyExit());
  const guidePressed = useRef(false);
  const touchExitPressed = useRef(false);
  const setExitPressed = useCallback((pressed: boolean) => { touchExitPressed.current = pressed; }, []);
  const changeInputMode = useCallback((mode: InputMode) => {
    touch.current = NEUTRAL; controller.current = NEUTRAL;
    escape.current = emptyExit(); guidePressed.current = false;
    inputModeRef.current = mode; setInputMode(mode); setExitProgress(0);
    transport.current?.setInputMode(mode);
  }, []);
  const updateTouch = useCallback((state: GamepadState) => {
    if (!validState(state)) return;
    touch.current = state;
    transport.current?.setTouch(state);
  }, []);
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
      transport.current?.setPhysicalConnected(event.connected);
      setKind(event.connected ? kindOf(event.kind) : 'generic');
    };
    const events = gamepadNative?.addListener('onState', raw => {
      if (live && validState(raw)) {
        controller.current = raw;
        transport.current?.setPhysical(raw);
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
      transport.current?.setPhysicalConnected(false);
      setKind('generic'); escape.current = emptyExit(); guidePressed.current = false;
      void gamepadNative?.stop().catch(() => { });
    };
  }, [monitor, foreground, theme.colors.accent]);
  useEffect(() => {
    if (!enabled || !foreground) return;
    let live = true;
    let failure: string | null = null;
    let connecting = true;
    let progressAt = 0;
    let suppressed = false;
    let rumbleAt: number | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    escape.current = emptyExit(); touchExitPressed.current = false; setExitProgress(0); setKeymap(false);
    const stopRumble = (): void => { void gamepadNative?.rumble(0, 0).catch(() => { }); };
    const open = async (): Promise<void> => {
      setBackend(connecting ? 'Connecting to the computer…' : reconnectStatus(failure));
      connecting = false;
      try {
        const url = await wsUrl('/ws/gamepad', { preset });
        if (live) wire.open(url);
      } catch (error) {
        if (live) {
          failure = failure || (error instanceof Error ? error.message : null);
          setBackend(reconnectStatus(failure)); retry = setTimeout(() => { void open(); }, RECONNECT_MS);
        }
      }
    };
    const wire = createTransport({
      onMessage: text => {
        if (!live) return;
        const message = parseGamepadMessage(text);
        if (message?.type === 'hello') {
          failure = message.available ? null : hostStatus(message);
          setKeymap(message.backend === 'keymap');
          setBackend(hostStatus(message));
        } else if (message?.type === 'rumble') {
          rumbleAt = Date.now(); void gamepadNative?.rumble(message.low, message.high).catch(() => { });
        }
      },
      onClose: (_code, reason) => {
        stopRumble();
        if (!live) return;
        failure = failure || reason || null;
        setKeymap(false); setBackend(reconnectStatus(failure));
        retry = setTimeout(() => { void open(); }, RECONNECT_MS);
      },
    });
    transport.current = wire;
    wire.setInputMode(inputModeRef.current);
    wire.setPhysicalConnected(physicalRef.current);
    wire.setPhysical(controller.current);
    wire.setTouch(touch.current);
    void open();
    const timer = setInterval(() => {
      const now = Date.now();
      const physicalInput = usesPhysicalController(inputModeRef.current, physicalRef.current);
      const previous = escape.current;
      escape.current = exitHold(previous, physicalInput && guidePressed.current, touchExitPressed.current, now);
      if (now - progressAt >= PROGRESS_REPAINT_MS || escape.current.exit) {
        progressAt = now; setExitProgress(escape.current.progress);
      }
      const holding = escape.current.since !== null;
      if (holding !== suppressed) { suppressed = holding; wire.setSuppressed(holding); }
      if (escape.current.exit) {
        controller.current = NEUTRAL; touch.current = NEUTRAL; wire.setTouch(NEUTRAL); wire.setPhysical(NEUTRAL);
        exitRef.current(); return;
      }
      if (rumbleAt !== null && now - rumbleAt > RUMBLE_STALE_MS) { rumbleAt = null; stopRumble(); }
    }, HOLD_TICK_MS);
    return () => {
      live = false; clearInterval(timer); if (retry) clearTimeout(retry);
      if (transport.current === wire) transport.current = null;
      wire.close(); stopRumble();
      touch.current = NEUTRAL;
      touchExitPressed.current = false; escape.current = emptyExit(); setExitProgress(0);
    };
  }, [enabled, foreground, preset, connectionKey]);
  return { physical, usingPhysical: usesPhysicalController(inputMode, physical), inputMode, setInputMode: changeInputMode,
    kind, backend, keymap, updateTouch, foreground, controllerError, exitProgress, setExitPressed };
}
