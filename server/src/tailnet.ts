// Tailnet identity: who is on the other end of a connection that arrived over
// Tailscale, and is it *us*?
//
// Why this exists. The 6-digit pairing code guards against someone on the same
// network pairing a phone you never approved. Over Tailscale that someone
// cannot exist: the tailnet is a private network of devices signed in to your
// own account, and every packet on it carries a verified node identity. So
// when a pairing request arrives on the Tailscale interface from a device that
// belongs to the same Tailscale login as this host, asking for a code proves
// nothing the tunnel has not already proven — and it is the one step that
// still forces you to be standing at the computer. Skipping it lets a phone
// that was un-paired (a reinstall, a revoke, a wiped app) pair itself again
// from anywhere, on the strength of the tailnet alone.
//
// What it does NOT do: it never trusts an address on its own. The CGNAT range
// Tailscale uses is also handed out by ISPs (see addresses.ts), so the source
// address is only the first filter; the decision rests on `tailscale whois`,
// which answers from the local daemon's authenticated peer map.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { isCgnatAddress } from './addresses.js';

import { productEnv } from './env.js';

const WHOIS_TIMEOUT_MS = 3000;
const SELF_CACHE_MS = 60 * 1000;

/** Candidate locations for the CLI when it is not on PATH. */
const CLI_CANDIDATES = process.platform === 'win32'
  ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
  : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];

let cliPath: string | null | undefined;

/** The tailscale CLI, or null when it is not installed. Resolved once. */
export function tailscaleCli(): string | null {
  if (cliPath !== undefined) return cliPath;
  const configured = productEnv('TAILSCALE_CLI');
  if (configured && existsSync(configured)) return (cliPath = configured);
  for (const c of CLI_CANDIDATES) if (existsSync(c)) return (cliPath = c);
  // Fall back to PATH lookup; `execFile` will fail cleanly if it is missing.
  return (cliPath = 'tailscale');
}

/** Strip the IPv4-mapped-IPv6 prefix Node reports for dual-stack listeners. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Whether the source address could possibly be a tailnet peer. Cheap filter. */
export function couldBeTailnet(ip: string | undefined): boolean {
  const v4 = normalizeIp(ip);
  if (isCgnatAddress(v4)) return true;
  // Tailscale's IPv6 ULA prefix.
  return v4.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export interface Whois {
  readonly login: string;
  readonly node: string;
}

/**
 * Pull login + node name out of `tailscale whois --json` output. Exported for
 * tests; the shape has been stable but every field is treated as optional.
 */
export function parseWhois(json: string): Whois | null {
  try {
    const j = JSON.parse(json) as { UserProfile?: { LoginName?: unknown }; Node?: { Name?: unknown } };
    const login = j?.UserProfile?.LoginName;
    const node = j?.Node?.Name;
    if (typeof login !== 'string' || !login) return null;
    return { login, node: typeof node === 'string' ? node : '' };
  } catch {
    return null;
  }
}

/** The login this host is signed in as, from `tailscale status --json`. */
export function parseSelfLogin(json: string): string | null {
  try {
    const j = JSON.parse(json) as {
      Self?: { UserID?: unknown };
      User?: Record<string, { LoginName?: unknown }>;
    };
    const id = j?.Self?.UserID;
    if (id === undefined || id === null) return null;
    const login = j?.User?.[String(id)]?.LoginName;
    return typeof login === 'string' && login ? login : null;
  } catch {
    return null;
  }
}

function run(args: string[]): Promise<string> {
  const cli = tailscaleCli();
  if (!cli) return Promise.reject(new Error('tailscale CLI not found'));
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: WHOIS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

let selfCache: { login: string | null; at: number } | null = null;

async function selfLogin(): Promise<string | null> {
  const now = Date.now();
  if (selfCache && now - selfCache.at < SELF_CACHE_MS) return selfCache.login;
  let login: string | null = null;
  try { login = parseSelfLogin(await run(['status', '--json'])); } catch { login = null; }
  selfCache = { login, at: now };
  return login;
}

export async function whois(ip: string): Promise<Whois | null> {
  try { return parseWhois(await run(['whois', '--json', ip])); } catch { return null; }
}

/** Whether code-less tailnet pairing is enabled at all (on by default). */
export function tailnetPairingEnabled(): boolean {
  return productEnv('TAILNET_PAIR') !== '0';
}

/**
 * Decide whether a connection from `ip` may pair without a code: it must be a
 * tailnet address, `tailscale whois` must know the peer, and the peer must be
 * signed in as the same account this host is. Every failure is a "no" — an
 * absent CLI, a stopped daemon, a shared node from someone else's tailnet.
 */
export async function tailnetTrusted(ip: string | undefined): Promise<{ trusted: boolean; peer?: Whois }> {
  if (!tailnetPairingEnabled() || !couldBeTailnet(ip)) return { trusted: false };
  const [self, peer] = await Promise.all([selfLogin(), whois(normalizeIp(ip))]);
  if (!self || !peer) return { trusted: false };
  return { trusted: peer.login.toLowerCase() === self.toLowerCase(), peer };
}
