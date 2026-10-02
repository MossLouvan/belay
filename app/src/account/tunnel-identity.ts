// This phone's tunnel identity — the node id registered with POST /devices so
// the computer's sidecar will accept this phone (design.md, Tunnel).
//
// TODO(tunnel-ffi): the real identity comes from the belay-client xcframework
// (`belay_tunnel_start(secretKey, relayUrls)`), with the secret key in the
// keychain. Until that FFI lands this is a stub: a random placeholder node id,
// persisted so the account sees one phone rather than one per launch. Replace
// the body of getTunnelIdentity() with the FFI call; keep the signature.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { randomBytes } from '../devices/pinning';
import { toHex } from '../devices/hmac';

const NODE_ID_KEY = 'belay.tunnel.nodeId';

export interface TunnelIdentity {
  /** The public node id other peers dial. Hex, as iroh prints it. */
  readonly nodeId: string;
}

let memo: TunnelIdentity | null = null;

export async function getTunnelIdentity(): Promise<TunnelIdentity> {
  if (memo) return memo;
  const stored = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(NODE_ID_KEY).catch(() => null);
  const nodeId = stored ?? `stub-${toHex(randomBytes(30))}`;
  if (!stored && Platform.OS !== 'web') await SecureStore.setItemAsync(NODE_ID_KEY, nodeId).catch(() => undefined);
  memo = { nodeId };
  return memo;
}
