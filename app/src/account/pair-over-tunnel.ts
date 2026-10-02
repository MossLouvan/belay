// A linked computer still has to be paired once: the account proves which
// node to dial, and the device token (with the proof secret and pinned
// certificate) still comes from the host. With account trust (auto-pair.ts)
// that is POST /pair/account — no code; otherwise the host's own /pair with
// the 6-digit code. Dial the node, then hand the loopback port to the connect
// screen exactly as a typed address.

import { router } from 'expo-router';
import { pairOverTunnelRoute } from '../devices/add-computer-route';
import { tunnelPort } from '../devices/tunnel';
import { autoPairSameAccount } from './auto-pair';

/** Resolves false when the tunnel could not reach that computer right now. */
export async function startPairingOverTunnel(nodeId: string): Promise<boolean> {
  let port: number;
  try {
    port = await tunnelPort(nodeId);
  } catch {
    return false;
  }
  router.push(pairOverTunnelRoute(port, nodeId, autoPairSameAccount(nodeId)));
  return true;
}
