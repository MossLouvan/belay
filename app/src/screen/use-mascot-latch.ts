// The mascot's orientation latch. Tapping the beluga anywhere spins it (the
// avatar's own onPress delight) AND pins the app upright — from landscape
// that IS "switch the view to vertical"; a later tap lets the device drive
// rotation again. The spin stacks momentum per tap, so a burst of rapid taps
// must NOT flap the latch: only the first tap of a burst toggles it
// (mascotTapLatches). Pure decisions in orientation-lock.ts, the
// expo-screen-orientation calls in orientation-native.ts (best-effort: on
// web they no-op and rotation simply stays free).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_ORIENTATION_LOCK,
  mascotAccessibilityLabel,
  mascotTapLatches,
  nextOrientationLock,
} from './orientation-lock';
import type { OrientationLockState } from './orientation-lock';
import { applyOrientationLock } from './orientation-native';

export interface MascotLatch {
  readonly onMascotPress: () => void;
  /** Pin the screen upright after an explicit controller fullscreen exit. */
  readonly keepUpright: () => Promise<void>;
  /** The spoken contract on the avatar, naming what the next tap does. */
  readonly mascotLabel: string;
}

export function useMascotLatch(): MascotLatch {
  const [orientationLock, setOrientationLock] = useState<OrientationLockState>(DEFAULT_ORIENTATION_LOCK);
  const lastMascotTapAt = useRef<number | null>(null);
  const onMascotPress = useCallback(() => {
    const now = Date.now();
    const latches = mascotTapLatches(lastMascotTapAt.current, now);
    lastMascotTapAt.current = now;
    if (!latches) return;
    setOrientationLock((state) => {
      const next = nextOrientationLock(state);
      void applyOrientationLock(next);
      return next;
    });
  }, []);
  const keepUpright = useCallback(() => {
    setOrientationLock('portrait');
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
  const mascotLabel = mascotAccessibilityLabel(orientationLock);

  return { onMascotPress, keepUpright, mascotLabel };
}
