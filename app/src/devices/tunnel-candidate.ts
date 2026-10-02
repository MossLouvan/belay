// The tunnel as one more candidate in the connection race.
//
// A linked computer is dialled by node id, not by URL: `tunnel:<nodeId>` is
// raced beside the saved addresses, and only when it is probed does the FFI
// hand back a 127.0.0.1 port forwarding to that node. The host answers
// there over the same TLS certificate it uses on the LAN, so the saved
// fingerprint is pinned for that host:port BEFORE the first byte — the same
// rule connection.tsx applies to every other https address.
//
// Pure apart from the injected dial/pin/check, so tunnel-candidate.test.mjs
// covers the ordering and the pin-before-probe rule without a network.

import type { HostAddress, SavedDevice } from './model.ts';
import type { HostCheck } from '../api';

export const TUNNEL_PREFIX = 'tunnel:';
const NODE_ID = /^[0-9a-f]{64}$/;

export const isTunnelCandidate = (url: string): boolean => url.startsWith(TUNNEL_PREFIX);

export function tunnelNodeId(url: string): string | null {
  const id = url.slice(TUNNEL_PREFIX.length);
  return isTunnelCandidate(url) && NODE_ID.test(id) ? id : null;
}

export const tunnelUrl = (port: number): string => `https://127.0.0.1:${port}`;

/**
 * `ordered` with the tunnel in second place.
 *
 * Second, not last: the race staggers candidates 75 ms apart, so the usual
 * LAN winner keeps its head start and still wins whenever it answers, while
 * on cellular the tunnel is already dialling instead of waiting behind every
 * dead LAN and Tailscale entry. Skipped for a computer with no node id or no
 * fingerprint — the tunnel is https and an unpinned https answer is refused.
 */
export function withTunnelCandidate(
  ordered: readonly HostAddress[],
  device: Pick<SavedDevice, 'nodeId' | 'fingerprint'>,
): readonly { readonly url: string }[] {
  if (!device.nodeId || !device.fingerprint) return ordered;
  const tunnel = { url: `${TUNNEL_PREFIX}${device.nodeId}` };
  return ordered.length === 0 ? [tunnel] : [ordered[0], tunnel, ...ordered.slice(1)];
}

export interface TunnelProbeDeps {
  readonly dial: (nodeId: string) => Promise<number>;
  readonly pin: (urls: readonly string[], fingerprint: string) => void;
  readonly check: (url: string, signal: AbortSignal) => Promise<HostCheck>;
}

/** Dial, pin, then (and only then) probe /health on the loopback port. */
export async function probeViaTunnel(
  deps: TunnelProbeDeps,
  nodeId: string,
  fingerprint: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; hostId?: string; via?: string }> {
  let port: number;
  try {
    port = await deps.dial(nodeId);
  } catch {
    // The tunnel could not reach that node right now: a dead candidate, like
    // a LAN address from the wrong network.
    return { ok: false };
  }
  const url = tunnelUrl(port);
  deps.pin([url], fingerprint);
  const health = await deps.check(url, signal);
  return { ok: health.ok, hostId: health.id, via: url };
}

const isLoopback = (url: string): boolean => /^https?:\/\/127\./i.test(url);

/**
 * A computer paired THROUGH the tunnel: keep its node id, drop the loopback
 * port it was paired on (ephemeral; the next launch dials a new one).
 */
export function savedOverTunnel(device: SavedDevice, nodeId: string): SavedDevice {
  return {
    ...device,
    nodeId,
    addresses: device.addresses.filter((a) => !isLoopback(a.url)),
    lastKnownGoodUrl: `${TUNNEL_PREFIX}${nodeId}`,
  };
}

/** How the phone reached the computer, for the status row. */
export type ConnectionPath = 'wifi' | 'direct' | 'relay';

export function pathLabel(path: ConnectionPath | null): string | undefined {
  if (path === 'wifi') return 'Wi-Fi';
  if (path === 'direct') return 'Direct';
  if (path === 'relay') return 'Relay';
  return undefined;
}
