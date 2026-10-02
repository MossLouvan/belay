// Where the computer list sends "add a computer".
//
// Pure, so node can test it: the list's field hands its text to the connect
// screen in the URL, and the connect screen checks it on arrival. Kept apart
// from the component so the two screens cannot drift on parameter names.

export interface AddComputerRoute {
  readonly pathname: '/';
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A typed address goes to the connect screen already filled in and checked;
 * `null` asks for the scanner instead. Blank text goes nowhere — Connect on
 * an empty field is a no-op, not a trip to another screen.
 */
/**
 * Pair a linked computer through the tunnel: the connect screen checks the
 * loopback port like any typed https address (reads and shows the host's
 * fingerprint; with `trust`, account trust first, else the 6-digit code), and `node` tells it to save the
 * computer under its node id rather than the ephemeral port.
 */
export function pairOverTunnelRoute(port: number, nodeId: string, trust = false): AddComputerRoute {
  const params = { add: '1', address: `https://127.0.0.1:${port}`, node: nodeId };
  // `trust`: ask the host's account trust (POST /pair/account) before any code.
  return { pathname: '/', params: trust ? { ...params, trust: '1' } : params };
}

export function addComputerRoute(address: string | null): AddComputerRoute | null {
  if (address === null) {
    return { pathname: '/', params: { add: '1', scan: '1' } };
  }
  const trimmed = address.trim();
  if (!trimmed) return null;
  return { pathname: '/', params: { add: '1', address: trimmed } };
}
