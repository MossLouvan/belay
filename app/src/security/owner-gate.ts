// The Face ID gate's pure logic: when the app locks, and when a sensitive
// action (allow an agent, allow a phone, forget a computer, delete the
// account) may reuse a recent check instead of prompting again. No React, no
// native module — the prompt arrives as a function — so `node --test`
// (src/security/owner-gate.test.mjs) pins every rule here.

/** How long a passed check covers the next sensitive action. */
export const FRESH_MS = 60_000;

/**
 * Whether the app should be locked when it becomes active. `backgroundedAt`
 * is null on a cold start (always lock). A clock that ran backwards locks
 * too: a time we cannot trust is no proof the owner was here.
 */
export const shouldLock = (backgroundedAt: number | null, now: number, timeoutMs: number): boolean => {
  if (backgroundedAt === null) return true;
  const away = now - backgroundedAt;
  return away < 0 || away >= timeoutMs;
};

/** Whether a check passed at `at` still covers an action at `now`. */
export const isFresh = (at: number | null, now: number): boolean =>
  at !== null && now >= at && now - at < FRESH_MS;

export interface OwnerGateDeps {
  /** The native prompt (Face ID / Touch ID / passcode). True only on success. */
  readonly authenticate: (reason: string) => Promise<boolean>;
  readonly now: () => number;
  /** "Require Face ID" is on and the device has something enrolled. */
  readonly isEnabled: () => boolean;
}

export function createOwnerGate({ authenticate, now, isEnabled }: OwnerGateDeps) {
  let passedAt: number | null = null;
  let inflight: Promise<boolean> | null = null;

  /** Always prompts (sharing a prompt already on screen); a pass is remembered. */
  const unlock = (reason: string): Promise<boolean> => {
    if (!inflight) {
      inflight = authenticate(reason)
        .then((ok) => {
          if (ok) passedAt = now();
          return ok;
        })
        .catch(() => false)
        .finally(() => { inflight = null; });
    }
    return inflight;
  };

  /** True when the owner is verified: gate off, a fresh pass, or a new one. */
  const requireOwner = async (reason: string): Promise<boolean> => {
    if (!isEnabled() || isFresh(passedAt, now())) return true;
    return unlock(reason);
  };

  return { requireOwner, unlock };
}
