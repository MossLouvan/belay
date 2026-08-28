// Host / Origin allow-list for the HTTP server and WebSocket upgrades.

/**
 * Host-header allow-list, the defence CORS cannot provide: DNS rebinding.
 *
 * A malicious page on `evil.example` can re-point that name at this machine's
 * IP after the page has loaded; the browser then treats requests to
 * `http://evil.example:8787` as *same-origin*, so no CORS check ever runs and
 * the page can read /health, hammer /pair and script every route with a token
 * it obtains. The one thing that gives such a request away is its `Host`
 * header, which still says `evil.example`. The app connects by IP (or a
 * `.local` name from discovery), so any other hostname is refused outright.
 * Extra names — a Tailscale MagicDNS name, say — go in `TETHER_HOSTS`.
 */
function extraHosts(): readonly string[] {
  return (process.env.TETHER_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function isTrustedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip the port; bracketed IPv6 literals keep their colons.
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  const name = (m ? m[1] : hostHeader.replace(/:\d+$/, '')).toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name.includes(':') && /^[0-9a-f:.]+$/.test(name)) return true;
  if (name.endsWith('.local')) return true;
  return extraHosts().includes(name);
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // native app
  try { return isTrustedHost(new URL(origin).host); } catch { return false; }
}
