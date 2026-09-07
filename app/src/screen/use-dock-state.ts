// The control bar's own state: the pointer mode and the armed one-shot
// button and the auto-hide that tucks the floating bar
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
}

export interface DockState {
  readonly mode: PointerMode;
  readonly setMode: (mode: PointerMode) => void;
  /** The armed one-shot button override (right-/double-click). */
  readonly button: PendingButton;
  readonly clearButton: () => void;
  readonly toggleRight: () => void;
  readonly toggleDouble: () => void;
  readonly dockHide: AutoHide;
  /** Whether the bar is on screen: always in portrait, until hidden while immersive. */
  readonly dockShown: boolean;
  readonly dockOpacity: Animated.Value;
}

export function useDockState({ immersive, typeOpen }: DockStateInputs): DockState {
  const theme = useTheme();
  const [mode, setMode] = useState<PointerMode>('touch');
  const [button, setButton] = useState<PendingButton>('none');

  // While immersive (portrait fullscreen OR landscape) the floating dock
  // hides after 4s untouched; while the text field or the key bar is open it
  // stays put (the user is actively working the bar — hiding it under their
  // thumbs would be hostile). Stage touches never poke this: they are remote
  // input. The reveal is a swipe UP from the very bottom edge of the screen
  // (EdgeRevealStrip) — an edge gesture that can never be mistaken for a
  // remote click or scroll — plus a Hide chevron for the deliberate dismiss.
  const dockHide = useAutoHide(dockAutoHides({ immersive, keyboardOpen: typeOpen }));
  const dockShown = !immersive || dockHide.visible;
  const dockOpacity = useToggleAnimation(dockShown, theme.motion.fast);

  const clearButton = useCallback(() => setButton('none'), []);
  const toggleRight = useCallback(() => setButton((b) => toggleArmedButton(b, 'right')), []);
  const toggleDouble = useCallback(() => setButton((b) => toggleArmedButton(b, 'double')), []);

  return {
    mode,
    setMode,
    button,
    clearButton,
    toggleRight,
    toggleDouble,
    dockHide,
    dockShown,
    dockOpacity,
  };
}
