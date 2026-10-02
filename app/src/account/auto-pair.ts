// Seam: "auto-pair a same-account phone".
//
// A computer linked by signing in on it (POST /hosts/link) shows up in this
// phone's list by itself (GET /devices → merge-devices.ts → LinkedSection).
// Pairing it is unchanged: startPairingOverTunnel (pair-over-tunnel.ts) dials
// the node and opens the 6-digit code screen. How much a phone on the same
// account is trusted is the owner's call; when that rule ships, this is the
// one switch startPairingOverTunnel consults to skip the code (calling the
// host's account-trust pairing route) instead of opening the code screen.
// Until then it is off and nothing reads it.

/** True when this phone may pair the linked computer `nodeId` without a code. */
export function autoPairSameAccount(_nodeId: string): boolean {
  return false;
}
