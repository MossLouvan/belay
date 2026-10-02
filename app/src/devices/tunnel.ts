// The tunnel as the connection race sees it: a port per node id, and the
// path (direct or relayed) the status row reports.
//
// Dialling is cached per node id: the FFI forwarder keeps one QUIC
// connection per dial and redials on drop, so a second dial for the same
// computer would only open a second listener. The tunnel itself is started
// by the account (tunnel-identity.ts); a dial on a build without it simply
// fails, which the race reads as a dead candidate.

import { dialTunnel, isTunnelAvailable, tunnelLastError, tunnelStats } from '../../modules/belay-stream/src/tunnel';
import { getTunnelIdentity } from '../account/tunnel-identity';
import type { ConnectionPath } from './tunnel-candidate';

const ports = new Map<string, Promise<number>>();

/** The loopback port forwarding to `nodeId`; the same port for the same node until the app restarts. */
export function tunnelPort(nodeId: string): Promise<number> {
  if (!isTunnelAvailable()) return Promise.reject(new Error('no native tunnel in this build'));
  let port = ports.get(nodeId);
  if (!port) {
    // Make sure the endpoint is up (a cold launch may race the account's start).
    port = getTunnelIdentity().then(() => dialTunnel(nodeId))
      .catch((e: unknown) => { ports.delete(nodeId); throw e; });
    ports.set(nodeId, port);
  }
  return port;
}

/** Whether the live tunnel to `nodeId` is hole-punched or going through a relay. */
export async function tunnelPath(nodeId: string): Promise<ConnectionPath> {
  const stats = await tunnelStats(nodeId).catch(() => ({ connected: false, direct: false, rttMs: 0 }));
  return stats.direct ? 'direct' : 'relay';
}

/**
 * Why the tunnel behind `https://127.0.0.1:<port>` last failed (the Rust
 * forwarder's own words: connect timed out, refused by the computer, ...), or
 * null when `url` is not one of our tunnel ports or nothing failed.
 */
export async function tunnelErrorFor(url: string): Promise<string | null> {
  const m = /^https:\/\/127\.0\.0\.1:(\d+)(\/|$)/.exec(url);
  if (!m) return null;
  for (const [nodeId, port] of ports) {
    if ((await port.catch(() => -1)) === Number(m[1])) return tunnelLastError(nodeId);
  }
  return null;
}
