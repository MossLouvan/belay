// When does the header get a one-tap switch, and to where?
//
// The common shape of this app's real household is exactly two computers — a
// Mac and a Windows PC — and bouncing between them through a full list screen
// costs two taps and a navigation for a decision with only one possible
// answer. With exactly two machines, "the other one" is unambiguous, so the
// header can offer it directly *and name it*, which is what makes a
// session-dropping tap safe: you know where you will land before your thumb
// does. At three or more there is no "other one", and guessing (most recent?
// alphabetical?) would make the same tap land somewhere different each day —
// so the shortcut simply does not appear and the list stays the only door.
//
// Pure, so it can be unit tested under node without React or react-native.

import type { SavedDevice } from './model';

export interface QuickSwitch {
  /** The one other computer — the destination of the tap. */
  readonly target: SavedDevice;
  /** Rendered as the header's second tracked label, naming the destination. */
  readonly text: string;
  /** Spoken form names where the tap goes, not just "switch computer". */
  readonly accessibilityLabel: string;
  /** Warns that the tap costs the current session. */
  readonly accessibilityHint: string;
}

/**
 * The machine a one-tap switch would land on, or null when the shortcut must
 * not exist: fewer than two computers (nothing to switch to), more than two
 * (no unambiguous "other"), or an active id that is somehow not one of the
 * two — in which case naming a destination would be a guess.
 */
export function quickSwitchTarget(
  devices: readonly SavedDevice[],
  activeId: string | null | undefined,
): SavedDevice | null {
  if (devices.length !== 2 || !activeId) return null;
  const others = devices.filter((d) => d.id !== activeId);
  return others.length === 1 ? others[0] : null;
}

/** Everything the header's quick-switch label needs, or null to render none. */
export function quickSwitch(
  devices: readonly SavedDevice[],
  active: SavedDevice | undefined,
): QuickSwitch | null {
  const target = quickSwitchTarget(devices, active?.id);
  if (!target || !active) return null;
  return {
    target,
    // ⇄ rather than → : the same tap will bring you back, and saying so is
    // what makes a no-confirm session-dropping control feel safe.
    text: `⇄ ${target.label}`,
    accessibilityLabel: `Switch to ${target.label}.`,
    accessibilityHint: `Disconnects from ${active.label}.`,
  };
}
