// When the app insists on a Belay account.
//
// Owner decision: accounts are required for remote use. Gating, exactly:
//   - a phone with no saved computers must sign in before it can pair anything;
//   - a phone that already has computers (paired over LAN/Tailscale before
//     accounts existed) keeps working signed out — those pairings never touch
//     the account service;
//   - adding or linking a NEW computer always requires sign-in, paired or not.
// Pure, so node can test it (gate.test.mjs).

export interface GateInputs {
  /** Both the saved computers and the stored session have been read. */
  readonly ready: boolean;
  readonly signedIn: boolean;
  readonly deviceCount: number;
  /** The user is on their way to pair/link a new computer. */
  readonly adding: boolean;
}

export function signInRequired(i: GateInputs): boolean {
  if (!i.ready || i.signedIn) return false;
  return i.deviceCount === 0 || i.adding;
}
