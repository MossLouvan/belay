// The tunnel: reach the computer from anywhere, without Tailscale.
//
// `isTunnelAvailable` exists for the same reason `isAvailable` does next door:
// a binary built before this module landed, Expo Go or web has no native
// tunnel, and the connection race must simply skip the `tunnel:` candidate
// rather than crash on a missing module.

import { requireNativeModule } from 'expo-modules-core';

export interface TunnelStats {
  readonly connected: boolean;
  /** Smoothed RTT in ms, 0 when not connected. */
  readonly rttMs: number;
  /** True when the selected path is direct (hole-punched), false when relayed. */
  readonly direct: boolean;
}

interface BelayTunnelNativeModule {
  start(secretHex: string, relayUrls: string[]): Promise<string>;
  dial(nodeId: string): Promise<number>;
  stats(nodeId: string): Promise<TunnelStats>;
  close(): Promise<void>;
}

let native: BelayTunnelNativeModule | null = null;
try {
  native = requireNativeModule<BelayTunnelNativeModule>('BelayTunnel');
} catch {
  native = null;
}

export function isTunnelAvailable(): boolean {
  return native !== null;
}

function required(): BelayTunnelNativeModule {
  if (!native) throw new Error('the native tunnel module is not in this build');
  return native;
}

/**
 * Start the endpoint with this phone's secret key (64 hex chars from
 * SecureStore; generate it once with BelayPin.randomHex(32)). Resolves to this
 * phone's node id, the value to register with POST /devices. Relay URLs empty
 * = n0 public relays (development only).
 */
export function startTunnel(secretHex: string, relayUrls: readonly string[] = []): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) return Promise.reject(new Error('tunnel key must be 64 hex chars'));
  return required().start(secretHex, [...relayUrls]);
}

/** A 127.0.0.1 port forwarding to `nodeId`; connect to `https://127.0.0.1:<port>`. */
export function dialTunnel(nodeId: string): Promise<number> {
  if (!/^[0-9a-f]{64}$/i.test(nodeId)) return Promise.reject(new Error('node id must be 64 hex chars'));
  return required().dial(nodeId);
}

export function tunnelStats(nodeId: string): Promise<TunnelStats> {
  if (!native) return Promise.resolve({ connected: false, rttMs: 0, direct: false });
  return native.stats(nodeId);
}

export function closeTunnel(): Promise<void> {
  return native ? native.close() : Promise.resolve();
}
