// Host / Origin allow-list for the HTTP server and WebSocket upgrades.

import { productEnv } from './env.js';

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
 * Extra names — a Tailscale MagicDNS name, say — go in `BELAY_HOSTS`.
 */
function extraHosts(): readonly string[] {
  return (productEnv('HOSTS') || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
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

/**
 * Origins that are not web pages.
 *
 * A native client sends no `Origin` at all. Two clients send an *opaque* one
 * instead: a page loaded from `file://` (the Electron desktop client) sends
 * `file://`, and a sandboxed document sends the literal `null`. Neither can be
 * parsed into a host, so both used to be refused — which is what stopped the
 * desktop client's WebSocket from ever connecting.
 *
 * Accepting them costs nothing the origin check was providing. What it defends
 * against is DNS rebinding, and that attack's giveaway is the *Host* header,
 * not the origin: a page served from `evil.example` still sends
 * `Host: evil.example`, which `isTrustedHost` refuses whatever its origin says.
 * An opaque origin is therefore no more dangerous than the absent one a native
 * app already sends.
 */
const OPAQUE_ORIGINS = new Set(['null', 'file://']);

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // native app
  if (OPAQUE_ORIGINS.has(origin.trim().toLowerCase())) return true;
  try { return isTrustedHost(new URL(origin).host); } catch { return false; }
}
