// Orientation and the Full toggle — when the desktop's chrome floats.
//
// Portrait shows header + stage + docked control bar, with an optional Full
// mode that hides the chrome. Landscape IS full — turning the phone sideways
// is the fullscreen gesture, so the desktop goes edge-to-edge automatically
// and the Full toggle disappears (it would be a no-op with a broken exit).
// Gaming mode is immersive too. The decisions are pure (screen-chrome.ts);
// this hook owns the window subscription and the fullscreen state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, useWindowDimensions } from 'react-native';
import type { ScaledSize } from 'react-native';
import type { Size } from './model';
import { isImmersive, isLandscape, normalizedDeviceSize, shouldClearFullscreen } from './screen-chrome';

export interface Immersive {
  readonly window: ScaledSize;
  /** The phone's own pixel size, larger side first (screen-chrome.ts). */
  readonly device: Size;
  readonly landscape: boolean;
  /** The explicit portrait Full toggle. */
  readonly fullscreen: boolean;
  /** Gaming, Full, or sideways: the chrome floats and the stage goes edge-to-edge. */
  readonly immersive: boolean;
  readonly toggleFullscreen: () => void;
}

export function useImmersive(gamingEnabled: boolean, gamingExitCount = 0): Immersive {
  const [fullscreen, setFullscreen] = useState(false);

  // "Match my phone" needs the device's own pixel size (logical points × the
  // display scale), so the host can render a desktop of exactly this shape.
  // Guard against keyboard-induced dimension changes on Android: the keyboard
  // shrinks window.height with adjustResize, which would reshape the virtual
  // display mid-session and break the stream. Only re-measure when the screen
  // actually rotates (width/height swap), not when keyboard shows/hides.
  const window = useWindowDimensions();
  const device = useMemo<Size>(
    () => normalizedDeviceSize(window),
    [
      // Intentionally NOT depending on raw width/height to avoid keyboard reshaping.
      // Only re-measure when scale changes or orientation flips (detected via the
      // max/min normalization — a keyboard shrink keeps the same max).
      window.scale,
      Math.max(window.width, window.height), // Stable across keyboard
    ]
  );

  // Landscape is the fullscreen gesture: sideways, the desktop goes
  // edge-to-edge on its own and the chrome floats. The explicit Full toggle
  // is a portrait-only idea, so rotating clears it — otherwise coming back
  // upright would strand the user in a fullscreen they never chose, behind
  // an exit control they already found hard to hit.
  const landscape = isLandscape(window.width, window.height);
  const immersive = isImmersive({ gaming: gamingEnabled, fullscreen, landscape });
  const previousLandscape = useRef(landscape);
  const previousGamingExit = useRef(gamingExitCount);
  useEffect(() => {
    if (gamingExitCount !== previousGamingExit.current) {
      previousGamingExit.current = gamingExitCount;
      setFullscreen(false);
    }
    // Only a fresh rotation clears portrait fullscreen. Leaving Gaming while
    // its landscape lock is restoring must preserve the previous Full choice.
    const clear = shouldClearFullscreen({
      gaming: gamingEnabled,
      landscape,
      wasLandscape: previousLandscape.current,
      fullscreen,
    });
    if (clear) setFullscreen(false);
    previousLandscape.current = landscape;
  }, [landscape, fullscreen, gamingEnabled, gamingExitCount]);

  const toggleFullscreen = useCallback(() => {
    // The floating type bar is anchored to the root layout's bottom edge; the
    // fullscreen flip moves that edge without a keyboard event to re-measure
    // against. Dismissing first lets the keyboard-gone effect fold the row
    // cleanly (the draft survives in the type row's text); with no keyboard
    // up, a no-op.
    Keyboard.dismiss();
    setFullscreen((v) => !v);
  }, []);

  return { window, device, landscape, fullscreen, immersive, toggleFullscreen };
}
