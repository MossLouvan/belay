// Seam: "auto-pair a same-account phone" (account trust).
//
// A computer linked to this account (by the claim QR, or by signing in on
// it) is paired with no code: startPairingOverTunnel consults this switch and
// sends the connect screen to the host's POST /pair/account instead of the
// 6-digit screen (account/account-pair.ts). The host decides the rest — the
// first phone connects at once, a later one waits for one tap on Belay.app or
// on a phone already paired, and an older host without the route answers 404
// so the code screen comes back on its own.

/** True when this phone may pair the linked computer `nodeId` without a code. */
export function autoPairSameAccount(_nodeId: string): boolean {
  return true;
}
