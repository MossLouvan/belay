// The immersive HUD's orientation latch — pure model, no expo imports.
//
// Landscape IS fullscreen on this screen, so "put me back upright" needs a
// control of its own; rotating the phone would just re-enter fullscreen.
// "Upright" is a LATCH, not a one-shot rotate: the tap pins the app to
// portrait until the next tap lets it swing free again. Two states, one
// toggle — modelled here so the decision (and the words the screen reader
// hears for each state) can be unit-tested without a device.
//
// This used to be the beluga mascot: tapping it spun the drawing AND toggled
// the latch, which is why the label promised a flip and why a burst guard
// swallowed rapid taps. The animated mascot was retired long ago, so the
// promise was false and the guard only made a deliberate second tap do
// nothing. Both are gone; the control is now a labelled button and every tap
// counts.
//
// The expo-screen-orientation side effect lives in ./orientation-native.ts;
// this module stays importable by the node test runner.

/** Whether the app follows the device ('free') or is pinned upright. */
export type OrientationLockState = 'free' | 'portrait';

/** The default: the app rotates with the device, landscape = fullscreen. */
export const DEFAULT_ORIENTATION_LOCK: OrientationLockState = 'free';

/**
 * The latch decision: free pins upright, pinned frees. Pure — returns the
 * next state, never mutates anything.
 */
export function nextOrientationLock(state: OrientationLockState): OrientationLockState {
  return state === 'portrait' ? 'free' : 'portrait';
}

/**
 * What the screen reader announces on the control. Names what the tap will do
 * NEXT — the accessibility contract is the action, not the current state.
 */
export function orientationLatchLabel(state: OrientationLockState): string {
  return state === 'portrait'
    ? 'Let the view rotate with the phone again'
    : 'Keep the view upright';
}

/** The visible state of the control: pinned upright, or free to rotate. */
export function orientationLatchPinned(state: OrientationLockState): boolean {
  return state === 'portrait';
}
