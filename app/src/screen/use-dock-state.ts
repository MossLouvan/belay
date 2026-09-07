// The control bar's own state: the pointer mode and the armed one-shot
// button, the KEYS toggle, and the auto-hide that tucks the floating bar
// away while immersive. The decisions are pure (screen-chrome.ts).

import { useCallback, useState } from 'react';
import type { Animated } from 'react-native';
import { useTheme } from '../theme';
import { useToggleAnimation } from '../ui';
import { dockAutoHides, toggleArmedButton } from './screen-chrome';
import { useAutoHide } from './useAutoHide';
import type { AutoHide } from './useAutoHide';
import type { PendingButton, PointerMode } from './viewport';

export interface DockStateInputs {
  readonly immersive: boolean;
  readonly typeOpen: boolean;
  /** The first-run hint is proved unnecessary the moment Keys opens. */
  readonly dismissHint: () => void;
}

export interface DockState {
  readonly mode: PointerMode;
  readonly setMode: (mode: PointerMode) => void;
  /** The armed one-shot button override (right-/double-click). */
  readonly button: PendingButton;
  readonly clearButton: () => void;
  readonly toggleRight: () => void;
  readonly toggleDouble: () => void;
  readonly keysOn: boolean;
  readonly toggleKeys: () => void;
  readonly dockHide: AutoHide;
  /** Whether the bar is on screen: always in portrait, until hidden while immersive. */
  readonly dockShown: boolean;
  readonly dockOpacity: Animated.Value;
}

export function useDockState({ immersive, typeOpen, dismissHint }: DockStateInputs): DockState {
  const theme = useTheme();
  const [mode, setMode] = useState<PointerMode>('touch');
  const [button, setButton] = useState<PendingButton>('none');
  const [keysOn, setKeysOn] = useState(false);

  // While immersive (portrait fullscreen OR landscape) the floating dock
  // hides after 4s untouched; while the text field or the key bar is open it
  // stays put (the user is actively working the bar — hiding it under their
  // thumbs would be hostile). Stage touches never poke this: they are remote
  // input. The reveal is a swipe UP from the very bottom edge of the screen
  // (EdgeRevealStrip) — an edge gesture that can never be mistaken for a
  // remote click or scroll — plus a Hide chevron for the deliberate dismiss.
  const dockHide = useAutoHide(dockAutoHides({ immersive, typeOpen, keysOn }));
  const dockShown = !immersive || dockHide.visible;
  const dockOpacity = useToggleAnimation(dockShown, theme.motion.fast);

  const clearButton = useCallback(() => setButton('none'), []);
  const toggleRight = useCallback(() => setButton((b) => toggleArmedButton(b, 'right')), []);
  const toggleDouble = useCallback(() => setButton((b) => toggleArmedButton(b, 'double')), []);

  // The KEYS toggle now lives in the control bar (the founder's call: an eye
  // glyph on the stage was the one control nobody found). In full screen a
  // press also pokes the auto-hidden dock back, so the key bar that appears
  // has its companion controls on screen with it.
  const toggleKeys = useCallback(() => {
    dismissHint();
    if (immersive) dockHide.poke();
    setKeysOn((v) => !v);
  }, [immersive, dockHide, dismissHint]);

  return {
    mode,
    setMode,
    button,
    clearButton,
    toggleRight,
    toggleDouble,
    keysOn,
    toggleKeys,
    dockHide,
    dockShown,
    dockOpacity,
  };
}
