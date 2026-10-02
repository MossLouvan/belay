// Forgetting a computer (#83): the dialog promises "this phone will be
// un-paired from it", so the host must stop trusting the token, not just the
// phone. Revoke is best effort — an asleep or unreachable computer must not
// stop the user from forgetting it — and local removal always follows.
//
// The token never goes to an address verify-host has not passed (the rule
// since 6201b38): a saved LAN or Tailscale IP can belong to a different
// machine after a Wi-Fi change, and a revoke that "succeeds" there would
// leave the real host trusting a token we then delete our copy of. So the
// revoke runs only against the live, already-verified connection, or an
// address that answers /health and passes the same verifyHost as connectTo.

import { findDevice, removeDevice } from './model.ts';
import type { DeviceStore, SavedDevice } from './model.ts';
import type { TrustInput, TrustVerdict } from './verify-host.ts';

export interface RevokeDeps {
  /** The verified host URL of the live connection, when it is this device's. */
  readonly connectedHost: string | null;
  readonly checkHost: (url: string) => Promise<{ ok: boolean; id?: string }>;
  /** `verifyHost` with its challenge and randomness already bound. */
  readonly verify: (input: TrustInput) => Promise<TrustVerdict>;
  readonly revoke: (device: SavedDevice, host: string) => Promise<unknown>;
}

/** Revoke `device`'s own token at its host — only once that host has proven itself. */
export async function revokeAtVerifiedHost(device: SavedDevice, deps: RevokeDeps): Promise<void> {
  if (deps.connectedHost) {
    await deps.revoke(device, deps.connectedHost);
    return;
  }
  const url = device.lastKnownGoodUrl ?? device.addresses[0]?.url;
  if (!url) throw new Error('no address to revoke at');
  const health = await deps.checkHost(url);
  if (!health.ok) throw new Error('host did not answer');
  const trust = await deps.verify({ device, url, reportedHostId: health.id });
  if (!trust.ok) throw new Error(`host refused: ${trust.problem}`);
  await deps.revoke(device, url);
}

export async function forgetDevice(
  store: DeviceStore,
  id: string,
  revoke: (device: SavedDevice) => Promise<unknown>,
): Promise<DeviceStore> {
  const device = findDevice(store, id);
  if (!device) return store;
  await revoke(device).catch(() => { /* unreachable, unverified or already revoked: forget anyway */ });
  return removeDevice(store, id);
}
