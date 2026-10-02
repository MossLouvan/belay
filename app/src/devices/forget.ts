// Forgetting a computer (#83): the dialog promises "this phone will be
// un-paired from it", so the host must stop trusting the token, not just the
// phone. Revoke is best effort — an asleep or unreachable computer must not
// stop the user from forgetting it — and local removal always follows.

import { findDevice, removeDevice } from './model.ts';
import type { DeviceStore, SavedDevice } from './model.ts';

export async function forgetDevice(
  store: DeviceStore,
  id: string,
  revoke: (device: SavedDevice) => Promise<unknown>,
): Promise<DeviceStore> {
  const device = findDevice(store, id);
  if (!device) return store;
  await revoke(device).catch(() => { /* host unreachable or already revoked: forget anyway */ });
  return removeDevice(store, id);
}
