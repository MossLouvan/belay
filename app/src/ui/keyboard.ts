// Keyboard geometry — the pure math behind `useKeyboardLift` (keyboard-lift.tsx).
//
// Kept free of react-native imports, like track.ts next to track-label.tsx,
// so node's test runner can exercise it directly:
//
//   cd app && node --test src/ui/keyboard.test.mjs
//
// Why this exists at all: RN's KeyboardAvoidingView assumes its own layout
// coordinates are window coordinates and resizes ALL of its children. On the
// screen tab that shrank the live video stage by the keyboard's height and
// yanked the absolutely-positioned fullscreen dock up mid-picture. The fix is
// to leave the layout alone and float only the affected row above the
// keyboard, which needs exactly two numbers: is the keyboard on screen, and
// by how much does it overlap a given view.

/** The subset of RN's KeyboardEvent.endCoordinates this math needs. */
export interface KeyboardFrame {
  /** Top edge of the keyboard, in window coordinates. */
  readonly screenY: number;
  readonly height: number;
}

/**
 * True when a keyboard frame actually covers part of the window. iOS reports
 * a "hidden" keyboard as a frame parked AT the window's bottom edge
 * (screenY === windowHeight), so presence is a geometry question, not a
 * separate event. Malformed frames (a hardware-keyboard edge case, or a
 * platform handing back undefined) count as hidden — the safe default is
 * "nothing to avoid".
 */
export function keyboardShown(frame: KeyboardFrame | null | undefined, windowHeight: number): boolean {
  if (!frame || !Number.isFinite(frame.screenY) || !Number.isFinite(frame.height)) return false;
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return false;
  return frame.height > 0 && frame.screenY < windowHeight;
}

/**
 * How far the keyboard intrudes into a view whose bottom edge sits at
 * `viewBottom` (window coordinates, from measureInWindow). Zero when the
 * keyboard is entirely below the view — e.g. the non-fullscreen screen tab,
 * whose bottom stops above the tab bar, on Android where adjustResize has
 * already shrunk the window. Never negative: a lift can only go up.
 */
export function keyboardOverlap(viewBottom: number, keyboardTop: number): number {
  if (!Number.isFinite(viewBottom) || !Number.isFinite(keyboardTop)) return 0;
  return Math.max(0, viewBottom - keyboardTop);
}
