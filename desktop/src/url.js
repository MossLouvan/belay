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
 * A bare host gets http:// and the default port, because that is what the host
 * agent serves; anything already carrying a scheme keeps it, so a user who put
 * the agent behind https is not overridden. Returns null rather than throwing:
 * the caller's job is to show "that doesn't look like an address", not to
 * handle an exception.
 */
export function hostOrigin(input) {
  // No trailing-slash trimming: `origin` discards the path anyway, and
  // stripping the slashes first turned "http://" into the scheme-less "http:",
  // which then parsed as a machine literally named http.
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (!url.port && !/^https:/i.test(withScheme)) url.port = String(DEFAULT_PORT);
  return url.origin;
}

/** The ws:// or wss:// origin matching an http(s) one. */
export function socketOrigin(origin) {
  return String(origin).replace(/^http/i, (m) => (m === 'HTTP' ? 'WS' : 'ws'));
}
