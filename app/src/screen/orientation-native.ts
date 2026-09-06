// The orientation latch's native half — applies an OrientationLockState.
//
// Kept apart from ./orientation-lock.ts so the pure model stays importable
// by the node test runner; this file is the only place expo-screen-orientation
// is touched, and the only two calls that exist: pin upright, or hand
// rotation back to the device.

import * as ScreenOrientation from 'expo-screen-orientation';
import type { OrientationLockState } from './orientation-lock';

/**
 * Best-effort by design: on web (and any platform without the native module)
 * lockAsync rejects, and the honest behavior is simply that rotation keeps
 * working — nothing is broken and there is nothing useful to tell the user,
 * so the failure is absorbed here rather than surfaced as a toast.
 */
export async function applyOrientationLock(state: OrientationLockState): Promise<void> {
  try {
    if (state === 'portrait') {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } else {
      await ScreenOrientation.unlockAsync();
    }
  } catch {
    // Unsupported platform (web) or a racing unmount — rotation stays free.
  }
}
