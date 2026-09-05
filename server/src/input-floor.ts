// Who is allowed to touch the desktop right now.
//
// There is exactly one OS pointer and one keyboard focus, on Windows and on
// macOS alike, and no supported API creates a second of either. Cursors can be
// virtual (cursors.ts); *acting* cannot. So the desktop is a floor that one
// person holds at a time, and this module is the only thing that decides who.
//
// Two rules, in order:
//
//   1. The person physically at the machine always wins. If real input arrives
//      at the host, remote input freezes for LOCAL_GRACE_MS. Their pointer is
//      never yanked mid-sentence by someone on a phone.
//   2. Otherwise the floor is exclusive and briefly held. A grant lasts
//      LEASE_MS and is renewed by each further action, so one person's drag or
//      typed burst completes as a unit instead of interleaving with another's.
//
// Before this existed every device's input went straight to native.* and the
// helper's single command queue decided the order — which is to say two people
// clicking at once produced an arbitrary interleaving of both, on whichever
// pixels the last move happened to land on. That is the bug this fixes.
//
// Everything here is pure logic over an injected clock. No timers, no I/O.

/** How long a grant survives without renewal. Long enough to cover the gap
 *  between a press and its release on a slow link; short enough that a phone
 *  that walks into a lift stops holding the desktop hostage. */
export const LEASE_MS = 1_500;

/** How long remote input stays frozen after the host's own input. Sized for
 *  the pause between keystrokes of someone actually typing, so a sentence does
 *  not repeatedly hand the floor back and forth mid-word. */
export const LOCAL_GRACE_MS = 3_000;

/** How close to our own injection a host input event must be to be assumed
 *  ours. GetLastInputInfo counts injected input too, so without this every
 *  remote click would look like local activity and freeze the next one. */
export const INJECT_MARGIN_MS = 400;

export type FloorDenial = 'local' | 'held';

export interface FloorGranted {
  readonly ok: true;
  /** When this grant lapses unless renewed. */
  readonly until: number;
}

export interface FloorDenied {
  readonly ok: false;
  readonly reason: FloorDenial;
  /** Who holds it, when someone does. Absent for a `local` freeze — the person
   *  at the keyboard is not a connected device and has no cursor id. */
  readonly holder?: string;
  readonly holderName?: string;
  /** Roughly how long until a retry could succeed. Clients back off by this
   *  rather than hammering. */
  readonly retryInMs: number;
}

export type FloorDecision = FloorGranted | FloorDenied;

/**
 * Was the host's most recent input a human at the machine, or our own
 * injection coming back to us?
 *
 * `idleMs` is what the helper reports: how long since the OS last saw any
 * input at all. Injected input counts, so an event that lands within
 * `marginMs` of our own last injection is assumed to be that injection. The
 * cost of the assumption is bounded and one-sided: a human who touches the
 * mouse in the same 400 ms window as a remote click is missed once, and caught
 * on their next movement.
 */
export function isLocalActivity(
  idleMs: number | null,
  now: number,
  lastInjectAt: number,
  marginMs: number = INJECT_MARGIN_MS,
): boolean {
  // No probe (an older helper, or a platform without one) means no evidence of
  // a local user. Freezing on no evidence would break remote input entirely.
  if (idleMs === null || !Number.isFinite(idleMs) || idleMs < 0) return false;
  const inputAt = now - idleMs;
  return inputAt > lastInjectAt + marginMs;
}

export interface InputFloor {
  /**
   * Ask to act. Renews an existing grant held by the same id.
   *
   * This is the single gate: every route that reaches native.* calls it and
   * honours the answer.
   */
  request(id: string, name: string, now?: number): FloorDecision;
  /** Give the floor up early — the client let go, or its socket closed. */
  release(id: string, now?: number): void;
  /** Record that the host's own input device was used. */
  noteLocalActivity(at: number): void;
  /** Record that we injected, so the probe does not mistake it for a human. */
  noteInjection(at: number): void;
  /** When did we last inject? Feeds isLocalActivity. */
  lastInjectionAt(): number;
  /** Who holds the floor right now, or null. */
  holder(now?: number): string | null;
  /** True while the host's own user has it frozen. */
  frozen(now?: number): boolean;
  reset(): void;
}

export function createInputFloor(opts: {
  readonly leaseMs?: number;
  readonly localGraceMs?: number;
} = {}): InputFloor {
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const localGraceMs = opts.localGraceMs ?? LOCAL_GRACE_MS;

  let holderId: string | null = null;
  let holderName = '';
  let heldUntil = 0;
  let frozenUntil = 0;
  let lastInject = 0;

  const holderAt = (now: number): string | null =>
    holderId !== null && now < heldUntil ? holderId : null;

  return {
    request(id, name, now = Date.now()) {
      if (now < frozenUntil) {
        return { ok: false, reason: 'local', retryInMs: frozenUntil - now };
      }
      const current = holderAt(now);
      if (current !== null && current !== id) {
        return {
          ok: false, reason: 'held', holder: current, holderName,
          retryInMs: heldUntil - now,
        };
      }
      holderId = id;
      holderName = name;
      heldUntil = now + leaseMs;
      return { ok: true, until: heldUntil };
    },

    release(id, now = Date.now()) {
      if (holderAt(now) !== id) return;
      holderId = null;
      holderName = '';
      heldUntil = 0;
    },

    noteLocalActivity(at) {
      frozenUntil = Math.max(frozenUntil, at + localGraceMs);
      // The local user takes the floor outright. Leaving a remote grant
      // standing would let it resume the instant the freeze lapses, which is
      // the opposite of "the person at the machine wins".
      holderId = null;
      holderName = '';
      heldUntil = 0;
    },

    noteInjection(at) { lastInject = Math.max(lastInject, at); },
    lastInjectionAt: () => lastInject,
    holder: (now = Date.now()) => holderAt(now),
    frozen: (now = Date.now()) => now < frozenUntil,
    reset() {
      holderId = null; holderName = ''; heldUntil = 0; frozenUntil = 0; lastInject = 0;
    },
  };
}

/** The HTTP body a denied action returns. Shared so every route says it the
 *  same way and the app has one shape to render. */
export function denialBody(d: FloorDenied): {
  error: string; reason: FloorDenial; holder?: string; holderName?: string; retryInMs: number;
} {
  const error = d.reason === 'local'
    ? 'someone is using this computer directly'
    : `${d.holderName || 'another user'} is acting on this desktop`;
  return {
    error,
    reason: d.reason,
    ...(d.holder ? { holder: d.holder } : {}),
    ...(d.holderName ? { holderName: d.holderName } : {}),
    retryInMs: Math.max(0, Math.round(d.retryInMs)),
  };
}
