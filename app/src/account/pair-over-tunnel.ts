// A linked computer still has to be paired once: the account only proves
// which node to dial, the device token (and the proof secret and pinned
// certificate that come with it) still come from the host's own /pair, with
// the 6-digit code read off the host's window. Dial the node, then hand the
// loopback port to the connect screen exactly as a typed address.

import { router } from 'expo-router';
import { pairOverTunnelRoute } from '../devices/add-computer-route';
import { tunnelPort } from '../devices/tunnel';

/** Resolves false when the tunnel could not reach that computer right now. */
export async function startPairingOverTunnel(nodeId: string): Promise<boolean> {
  let port: number;
  try {
    port = await tunnelPort(nodeId);
  } catch {
    return false;
  }
  router.push(pairOverTunnelRoute(port, nodeId));
  return true;
}
