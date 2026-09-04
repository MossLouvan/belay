// pair-notify.ts — put the pairing prompt on the host's own screen.
//
// The pairing code is shown on the PC and nowhere else; that is the whole basis
// for treating it as proof of physical presence (see pair-replay.ts). But a code
// printed to a terminal is invisible if the terminal is minimised, scrolled, or
// the host runs in the background — so the person who is actually at the machine
// cannot see who is asking or what to type. This surfaces both.
//
// What it deliberately does NOT do:
//   - It never notifies on a SUCCESSFUL pair with a code. The person typed the
//     code off this screen; telling them again is noise.
//   - It is throttled. Anyone who can reach the port can trigger a pairing
//     attempt, and an unthrottled popup is a way to make the desktop unusable.
//   - It never includes anything the requester controls verbatim beyond a short,
//     sanitised device name. The name arrives from the network.

/**
 * Structural, not the concrete NativeHost: this module only ever needs to
 * draw a popup, and a narrow type keeps it testable with a stub.
 */
export interface NotifySink {
  notify(title: string, body: string, accent: string, seconds: number):
    Promise<{ shown?: boolean; reason?: string }>;
}

/** Minimum gap between popups, however many attempts arrive. */
const THROTTLE_MS = 8_000;

/** How long a popup stays up. Long enough to read and type a 6-digit code. */
const VISIBLE_SEC = 20;

// -Infinity, not 0: 'never shown yet' must not be confused with 'shown at
// epoch', or the very first attempt after a start/reset gets throttled away.
let lastShownAt = Number.NEGATIVE_INFINITY;
let suppressed = 0;

export interface PairAttempt {
  /** Remote address of whoever is asking. */
  readonly from: string;
  /** Device name they offered, if any. Untrusted input. */
  readonly deviceName?: string | null;
  /** The live pairing code, or null when there is none to show. */
  readonly code: string | null;
  /** True when this attempt already succeeded (tailnet identity, replay). */
  readonly alreadyPaired?: boolean;
}

/**
 * A device name arrives over the network, so it is clamped hard before it is
 * drawn on the owner's screen: printable ASCII only, short, no control
 * characters that could garble the popup or hide the rest of the text.
 */
export function safeName(raw: string | null | undefined): string {
  if (!raw) return 'Unknown device';
  const cleaned = String(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : 'Unknown device';
}

/** True when enough time has passed to show another popup. */
export function shouldShow(now: number, last: number): boolean {
  return now - last >= THROTTLE_MS;
}

/** Reset internal state. Tests only. */
export function _reset(): void {
  lastShownAt = Number.NEGATIVE_INFINITY;
  suppressed = 0;
}

/**
 * Show "someone is trying to connect" on the host screen. Never throws and
 * never blocks the pairing request: a popup is a courtesy, not a gate.
 */
export async function notifyPairAttempt(
  native: NotifySink | null,
  attempt: PairAttempt,
  now: number = Date.now(),
): Promise<void> {
  if (!native) return;
  if (attempt.alreadyPaired) return;

  if (!shouldShow(now, lastShownAt)) {
    suppressed += 1;
    return;
  }

  const skipped = suppressed;
  suppressed = 0;
  lastShownAt = now;

  const who = safeName(attempt.deviceName);
  const lines = [`${who} (${attempt.from}) is trying to connect.`];
  lines.push(
    attempt.code
      ? 'Enter this code on the phone if this was you:'
      : 'No pairing code is active right now.',
  );
  if (skipped > 0) {
    lines.push(`(${skipped} more attempt${skipped === 1 ? '' : 's'} while this was hidden)`);
  }

  try {
    await native.notify(
      'Belay — connection request',
      lines.join('\n'),
      attempt.code ?? '',
      VISIBLE_SEC,
    );
  } catch {
    // A helper that is too old to know `notify`, or has no desktop to draw on,
    // must never break pairing.
  }
}
