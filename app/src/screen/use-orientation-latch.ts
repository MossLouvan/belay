// The immersive HUD's orientation latch.
//
// Landscape is fullscreen on this screen, so the only way back upright is a
// control: tapping it pins the app to portrait, tapping it again lets the
// device drive rotation. Pure decisions in orientation-lock.ts, the
// expo-screen-orientation calls in orientation-native.ts (best-effort: on web
// they no-op and rotation simply stays free).

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_ORIENTATION_LOCK,
  nextOrientationLock,
  orientationLatchLabel,
  orientationLatchPinned,
} from './orientation-lock';
import type { OrientationLockState } from './orientation-lock';
import { applyOrientationLock } from './orientation-native';

export interface OrientationLatch {
  /** Toggle the latch. Every tap counts. */
  readonly onToggle: () => void;
  /** Pin the screen upright after an explicit controller fullscreen exit. */
  readonly keepUpright: () => Promise<void>;
  /** The spoken contract on the control, naming what the next tap does. */
  readonly label: string;
  /** True while the view is held upright — the control reads as engaged. */
  readonly pinned: boolean;
}

export function useOrientationLatch(): OrientationLatch {
  const [lock, setLock] = useState<OrientationLockState>(DEFAULT_ORIENTATION_LOCK);
  const onToggle = useCallback(() => {
    setLock((state) => {
      const next = nextOrientationLock(state);
      void applyOrientationLock(next);
      return next;
    });
  }, []);
  const keepUpright = useCallback(() => {
    setLock('portrait');
    return applyOrientationLock('portrait');
  }, []);
  // Leaving the screen hands rotation back — the latch is a Screen-view
  // stance, not an app-wide setting the other surfaces inherit.
  useEffect(
    () => () => {
      void applyOrientationLock('free');
    },
    []
  );

  return { onToggle, keepUpright, label: orientationLatchLabel(lock), pinned: orientationLatchPinned(lock) };
}
