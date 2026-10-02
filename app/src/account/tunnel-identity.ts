// This phone's tunnel identity — the node id registered with POST /devices so
// the computer's sidecar will accept this phone (design.md, Tunnel).
//
// The secret key is generated once and lives in the keychain, readable after
// the first unlock and never migrated to another device (a restored backup
// is a new phone, and must register as one). Starting the endpoint is the
// only way to learn the node id, so the first call starts the tunnel and the
// endpoint stays up while signed in; sign-out closes it.
//
// A build without the native module (web, Expo Go) cannot derive a node id
// from the key; it keeps the pre-FFI placeholder so the account still sees
// one phone, but nothing will ever be dialled from it.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { closeTunnel, isTunnelAvailable, startTunnel } from '../../modules/belay-stream/src/tunnel';
import { randomBytes } from '../devices/pinning';
import { loadOrCreateTunnelSecret, parseRelayUrls } from './tunnel-key';

const SECRET_KEY = 'belay.tunnel.secret';
/** The placeholder node id for builds without the native tunnel. */
const PLACEHOLDER_KEY = 'belay.tunnel.nodeId';

/** Comma-separated https relay URLs; the production relay when unset. */
export const RELAY_URLS = parseRelayUrls(process.env.EXPO_PUBLIC_RELAY_URLS);

export interface TunnelIdentity {
  /** The public node id other peers dial. 64 lowercase hex, as iroh prints it. */
  readonly nodeId: string;
  /** False on a build with no native tunnel: the node id is a placeholder. */
  readonly real: boolean;
}

let memo: Promise<TunnelIdentity> | null = null;

const useKeychain = Platform.OS !== 'web';
const readSecure = (key: string) => (useKeychain ? SecureStore.getItemAsync(key).catch(() => null) : Promise.resolve(null));
const writeSecure = async (key: string, value: string) => {
  if (!useKeychain) return;
  await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
};

async function placeholderIdentity(): Promise<TunnelIdentity> {
  const nodeId = await loadOrCreateTunnelSecret(() => readSecure(PLACEHOLDER_KEY), (v) => writeSecure(PLACEHOLDER_KEY, v).catch(() => undefined), randomBytes);
  return { nodeId, real: false };
}

async function realIdentity(): Promise<TunnelIdentity> {
  const secret = await loadOrCreateTunnelSecret(() => readSecure(SECRET_KEY), (v) => writeSecure(SECRET_KEY, v), randomBytes);
  const nodeId = (await startTunnel(secret, RELAY_URLS)).toLowerCase();
  return { nodeId, real: true };
}

/** Starts the tunnel on first use. Memoised; a failed start is retried on the next call. */
export function getTunnelIdentity(): Promise<TunnelIdentity> {
  if (!memo) {
    memo = (isTunnelAvailable() ? realIdentity() : placeholderIdentity())
      .catch((e: unknown) => { memo = null; throw e; });
  }
  return memo;
}

/** Sign-out: the endpoint goes down; the key stays for the next sign-in. */
export async function stopTunnel(): Promise<void> {
  memo = null;
  await closeTunnel().catch(() => undefined);
}
