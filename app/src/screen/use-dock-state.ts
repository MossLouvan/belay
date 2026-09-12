// The control bar's own state: the pointer mode and the armed one-shot
// button and the auto-hide that tucks the floating bar
// away while immersive. The decisions are pure (screen-chrome.ts).

import { useCallback, useMemo, useState } from 'react';
import type { Animated } from 'react-native';
import { useTheme } from '../theme';
import { useToggleAnimation } from '../ui';
import { NO_MODE_CHOICES, rememberMode, resolveMode } from './pointer-mode-policy';
import type { ModeChoices } from './pointer-mode-policy';
import { dockAutoHides, toggleArmedButton } from './screen-chrome';
import { useAutoHide } from './useAutoHide';
import type { AutoHide } from './useAutoHide';
import type { PendingButton, PointerMode } from './viewport';

export interface DockStateInputs {
  readonly immersive: boolean;
  readonly typeOpen: boolean;
  /** Sideways: the pointer mode defaults to the trackpad (pointer-mode-policy.ts). */
  readonly landscape: boolean;
}

export interface DockState {
  /** The mode in force: this orientation's explicit choice, else its default. */
  readonly mode: PointerMode;
  /** Records a deliberate pick against the orientation it was made in. */
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

export function useDockState({ immersive, typeOpen, landscape }: DockStateInputs): DockState {
  const theme = useTheme();
  // What one finger does is remembered PER ORIENTATION, not globally: upright
  // the phone is a picture you poke (Touch), sideways it is a laptop (Pad).
  // Rotating therefore lands on the right default without ever overriding a
  // mode the user actually chose in that grip — see pointer-mode-policy.ts.
  const [choices, setChoices] = useState<ModeChoices>(NO_MODE_CHOICES);
  const mode = useMemo(() => resolveMode(choices, landscape), [choices, landscape]);
  const setMode = useCallback(
    (next: PointerMode) => setChoices((current) => rememberMode(current, landscape, next)),
    [landscape],
  );
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
