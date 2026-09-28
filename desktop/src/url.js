// Turning what someone types into a host URL.
//
// Accepts the shapes people actually paste: "192.168.1.20", "mac.local:8787",
// "http://100.101.2.3:8787", with or without a trailing slash. The host prints
// its URLs on boot, but nobody retypes them exactly.

/** The port the host listens on unless told otherwise. */
export const DEFAULT_PORT = 8787;

/**
 * Normalize a typed address into an origin, or null when it cannot be one.
 *
 * A bare host gets the default port and a scheme chosen by where it is: the
 * host serves the LAN over TLS and plain HTTP only over Tailscale and
 * loopback (server/src/transport.ts), so a 100.x address gets http:// and
 * anything else https://. An address already carrying a scheme keeps it.
 * Returns null rather than throwing: the caller's job is to show "that
 * doesn't look like an address", not to handle an exception.
 */
export function hostOrigin(input) {
  // No trailing-slash trimming: `origin` discards the path anyway, and
  // stripping the slashes first turned "http://" into the scheme-less "http:",
  // which then parsed as a machine literally named http.
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const typedScheme = /^https?:\/\//i.test(raw);
  let url;
  try {
    url = new URL(typedScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (!typedScheme) {
    if (!url.port) url.port = String(DEFAULT_PORT);
    if (!isTailscaleOrigin(url.origin) && !isLoopbackOrigin(url.origin)) url.protocol = 'https:';
  } else if (!url.port && !/^https:/i.test(raw)) {
    url.port = String(DEFAULT_PORT);
  }
  return url.origin;
}

function isLoopbackOrigin(origin) {
  let hostname;
  try { hostname = new URL(origin).hostname; } catch { return false; }
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

/** The ws:// or wss:// origin matching an http(s) one. */
export function socketOrigin(origin) {
  return String(origin).replace(/^http/i, (m) => (m === 'HTTP' ? 'WS' : 'ws'));
}

/**
 * Whether an origin points at a Tailscale peer (CGNAT 100.64.0.0/10). A host
 * on the owner's own tailnet pairs on identity alone, so the client can skip
 * the code instead of asking for one that will never be checked.
 */
export function isTailscaleOrigin(origin) {
  let hostname;
  try {
    hostname = new URL(String(origin ?? '')).hostname;
  } catch {
    return false;
  }
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
