// "Pair this linked computer over the tunnel" travels in memory, not in the
// route. A URL can be a deep link from anywhere; if it could name a node (or
// switch on account trust), a crafted link could make the phone save some
// other address under an account computer's identity. So the URL carries
// only the loopback address, and the connect screen asks here whether that
// exact address is the one startPairingOverTunnel just dialled, for a node
// that is on this account. Pure, so tunnel-intent.test.mjs runs it in node.

export interface TunnelIntent {
  readonly port: number;
  readonly nodeId: string;
  /** auto-pair.ts said: try account trust before any code. */
  readonly trust: boolean;
}

let current: TunnelIntent | null = null;

export function setTunnelIntent(intent: TunnelIntent): void {
  current = intent;
}

export function clearTunnelIntent(): void {
  current = null;
}

/** The intent behind `address`, only if it is the live dial for an account node. */
export function tunnelIntentFor(
  address: string | null,
  accountNodeIds: readonly string[],
): { readonly nodeId: string; readonly trust: boolean } | null {
  if (!current || address !== `https://127.0.0.1:${current.port}`) return null;
  if (!accountNodeIds.includes(current.nodeId)) return null;
  return { nodeId: current.nodeId, trust: current.trust };
}
