// Which of the desktop's sheets is up, plus the two toggles and the settings
// the Screen options sheet edits. Each sheet keeps its own flag, exactly as
// the route held them before: the menu closes itself before opening the sheet
// it points at, so none ever stack.

import { useCallback, useMemo, useState } from 'react';
import type { StreamSettings } from './stream-settings-sheet';

export type SheetId = 'menu' | 'quality' | 'streamSettings' | 'help' | 'monitor' | 'clipboard';

const NONE_OPEN: Readonly<Record<SheetId, boolean>> = Object.freeze({
  menu: false,
  quality: false,
  streamSettings: false,
  help: false,
  monitor: false,
  clipboard: false,
});

export interface ScreenSheets {
  readonly isOpen: (id: SheetId) => boolean;
  readonly open: (id: SheetId) => void;
  readonly close: (id: SheetId) => void;
  /** A stable "close this one" handler, for a Sheet's onClose. */
  readonly closer: (id: SheetId) => () => void;
  /** A stable "open this one" handler, for a key or a row. */
  readonly opener: (id: SheetId) => () => void;
  /** Close the menu and open the sheet it points at. */
  readonly fromMenu: (id: SheetId) => () => void;
  readonly showHud: boolean;
  readonly toggleHud: () => void;
  /** Host system audio on the phone's speaker. */
  readonly audioOn: boolean;
  readonly toggleAudio: () => void;
  readonly streamSettings: StreamSettings;
  readonly applyStreamSettings: (settings: StreamSettings) => void;
}

export function useScreenSheets(): ScreenSheets {
  const [flags, setFlags] = useState<Readonly<Record<SheetId, boolean>>>(NONE_OPEN);
  const [showHud, setShowHud] = useState(false);
  // Host system audio on the phone's speaker. Default OFF: it is opt-in and
  // rides the BELAY_WEBRTC-gated /ws/audio, so a host without the flag simply
  // never delivers frames and the toggle is a harmless no-op.
  const [audioOn, setAudioOn] = useState(false);
  // Stream performance settings (bitrate, FPS ceiling, codec, audio)
  const [streamSettings, setStreamSettings] = useState<StreamSettings>({
    fps: 60,
    bitrateMbps: 0, // Auto
    audioEnabled: false,
    codec: 'h264',
  });

  const isOpen = useCallback((id: SheetId) => flags[id], [flags]);
  const open = useCallback((id: SheetId) => setFlags((f) => ({ ...f, [id]: true })), []);
  const close = useCallback((id: SheetId) => setFlags((f) => ({ ...f, [id]: false })), []);
  const handlers = useMemo(() => {
    const ids: readonly SheetId[] = ['menu', 'quality', 'streamSettings', 'help', 'monitor', 'clipboard'];
    const build = (make: (id: SheetId) => () => void): Readonly<Record<SheetId, () => void>> =>
      Object.fromEntries(ids.map((id) => [id, make(id)])) as Record<SheetId, () => void>;
    return {
      closers: build((id) => () => close(id)),
      openers: build((id) => () => open(id)),
      fromMenu: build((id) => () => setFlags((f) => ({ ...f, menu: false, [id]: true }))),
    };
  }, [open, close]);
  const closer = useCallback((id: SheetId) => handlers.closers[id], [handlers]);
  const opener = useCallback((id: SheetId) => handlers.openers[id], [handlers]);
  const fromMenu = useCallback((id: SheetId) => handlers.fromMenu[id], [handlers]);

  const toggleHud = useCallback(() => setShowHud((v) => !v), []);
  const toggleAudio = useCallback(() => setAudioOn((v) => !v), []);
  const applyStreamSettings = useCallback((settings: StreamSettings) => {
    setStreamSettings(settings);
    setAudioOn(settings.audioEnabled);
  }, []);

  return {
    isOpen,
    open,
    close,
    closer,
    opener,
    fromMenu,
    showHud,
    toggleHud,
    audioOn,
    toggleAudio,
    streamSettings,
    applyStreamSettings,
  };
}
