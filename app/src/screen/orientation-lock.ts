// The mascot's orientation latch — pure model, no expo imports.
//
// Tapping the beluga does two things at once: plays its flip (the avatar's
// own delight) and turns the view upright. "Upright" is a LATCH, not a
// one-shot rotate: the device may already be portrait, and rotating sideways
// is normally the fullscreen gesture, so the tap pins the app to portrait
// until the next tap lets it swing free again. Two states, one toggle —
// modelled here so the decision (and the words the screen reader hears for
// each state) can be unit-tested without a device.
//
// The expo-screen-orientation side effect lives in ./orientation-native.ts;
// this module stays importable by the node test runner.

/** Whether the app follows the device ('free') or is pinned upright. */
export type OrientationLockState = 'free' | 'portrait';

/** The default: the app rotates with the device, landscape = fullscreen. */
export const DEFAULT_ORIENTATION_LOCK: OrientationLockState = 'free';

/**
 * The mascot tap's latch decision: free pins upright, pinned frees. Pure —
 * returns the next state, never mutates anything.
 */
export function nextOrientationLock(state: OrientationLockState): OrientationLockState {
  return state === 'portrait' ? 'free' : 'portrait';
}

/**
 * What the screen reader announces on the mascot. Names the flip (always)
 * and what the tap will do NEXT — the accessibility contract is the action,
 * not the current state.
 */
export function mascotAccessibilityLabel(state: OrientationLockState): string {
  return state === 'portrait'
    ? 'Belay mascot — tap to flip and let the view rotate again'
    : 'Belay mascot — tap to flip and keep the view upright';
}
