// iOS Local Network permission: which failures it explains.
//
// With the permission off (declined, or never answered), iOS drops every
// packet to a LAN address before it leaves the phone. Nothing in a fetch
// rejection says so — React Native reports "Network request failed", and the
// certificate probe just fails — so the app used to blame the computer or its
// certificate. The native side (BelayPinModule's localNetworkStatus) reads the
// permission; this file decides, purely, when a failure is that permission.
//
// Pure: no React Native, so it runs under `node --test`.

export type LocalNetworkStatus = 'granted' | 'denied' | 'unknown';

export const LOCAL_NETWORK_TITLE = "Belay can't reach computers on your Wi-Fi";
export const LOCAL_NETWORK_MESSAGE =
  'Turn on Local Network for Belay in Settings (Privacy & Security → Local Network → Belay).';

/**
 * What iOS's own error text says when the permission is what blocked a
 * request: the Network framework's unsatisfied-path reason, and the DNS-SD
 * policy-denied error (kDNSServiceErr_PolicyDenied, -65570).
 */
const DENIED_PATTERNS: readonly RegExp[] = [
  /local network prohibited/i,
  /policy ?denied/i,
  /-65570\b/,
];

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Whether `url` is an address the Local Network permission governs: RFC 1918
 * and link-local IPv4, IPv6 link-local and unique-local, and `.local` names.
 * Not 100.64/10 (Tailscale): that traffic goes through the VPN interface,
 * which the permission does not cover.
 */
export function isLanUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  if (host.endsWith('.local')) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export interface FailureContext {
  /** `Platform.OS`; only iOS has the permission. */
  readonly platform: string;
  /** The address(es) that failed. One LAN address among them is enough. */
  readonly urls: readonly string[];
  /** The rejection text, if any. */
  readonly error?: string;
  /** What localNetworkStatus() reported, if it was asked. */
  readonly status?: LocalNetworkStatus;
}

/** Whether this failure is the Local Network permission rather than the computer. */
export function isLocalNetworkBlocked({ platform, urls, error, status }: FailureContext): boolean {
  if (platform !== 'ios') return false;
  if (!urls.some(isLanUrl)) return false;
  if (status === 'denied') return true;
  return DENIED_PATTERNS.some((p) => p.test(error ?? ''));
}
