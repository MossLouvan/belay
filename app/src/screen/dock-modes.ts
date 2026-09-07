// The pointer-mode roster — the one list the dock's mode switch renders.
//
// Touch, Pad and Scroll answer the same question ("what does one finger
// do?"), so they are a single radio group, and everything about each option
// — the visible word, what VoiceOver says, the hint that teaches it — lives
// here as data rather than scattered through JSX. Pure module: the node test
// runner imports it directly, so it must never pull in a component.

import type { PointerMode } from './viewport';

export type ScreenMode = PointerMode | 'gaming';

export interface PointerModeOption {
  readonly id: ScreenMode;
  /** The word on the segment — sentence case, novice vocabulary. */
  readonly label: string;
  readonly accessibilityLabel: string;
  /** One line that teaches the mode to someone who has never used it. */
  readonly hint: string;
}

/** Ordered as rendered: the default (touch) first. */
export const POINTER_MODE_OPTIONS: readonly PointerModeOption[] = Object.freeze([
  Object.freeze({
    id: 'touch',
    label: 'Touch',
    accessibilityLabel: 'Touch mode',
    hint: 'Tap where you want to click',
  } as const),
  Object.freeze({
    id: 'trackpad',
    label: 'Pad',
    accessibilityLabel: 'Trackpad mode',
    hint: 'Drag anywhere to move a visible cursor',
  } as const),
  Object.freeze({
    id: 'scroll',
    label: 'Scroll',
    accessibilityLabel: 'Scroll mode',
    hint: 'Drag one finger to scroll the page; taps still click',
  } as const),
  Object.freeze({ id: 'gaming', label: 'Gaming', accessibilityLabel: 'Gaming mode', hint: 'Play with a controller or touch gamepad in landscape' } as const),
]);

/**
 * The option for a mode, always defined: an unknown value (impossible by
 * type, cheap to guard anyway) falls back to the first option so the switch
 * never renders an unlabelled segment.
 */
export function pointerModeOption(mode: ScreenMode): PointerModeOption {
  return POINTER_MODE_OPTIONS.find((option) => option.id === mode) ?? POINTER_MODE_OPTIONS[0];
}
