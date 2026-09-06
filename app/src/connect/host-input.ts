// Host-address handling for the connect screen: validation, resolution preview
// and the "recent hosts" list.
//
// The parsing itself lives in ./address-input (pure, node-tested); this file
// adds pair-link detection and the AsyncStorage-backed recent list, so every
// call site goes through `resolveHost` — a total function that never throws
// and always explains itself.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isMagicDnsName, isTailscaleIPv4, parseAddress } from './address-input';
import { parsePairLink } from './pair-link';
import type { ParsedPairLink } from './pair-link';

/** Where the recent-host list lives. Distinct from the keys ../api owns. */
// 'belay.*' since the bundle id moved and wiped the old container.
const RECENT_KEY = 'belay.recentHosts';
const MAX_RECENT = 5;

export type HostResolution =
  | {
      readonly ok: true;
      readonly url: string;
      readonly note?: string;
      /** A non-blocking remark about what was discarded from the input. */
      readonly hint?: string;
    }
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: 'pair-link';
      readonly link: ParsedPairLink;
    };

/** A tailnet address — reachable from anywhere the tailnet reaches. */
export function isTailscaleAddress(url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').split(/[:/]/)[0] ?? '';
  return isTailscaleIPv4(host) || isMagicDnsName(host);
}

const CREDENTIALS_HINT =
  'Credentials in the address are ignored. Belay authenticates with the pairing code instead.';

/**
 * Turn whatever the user typed into a base URL, or explain why it cannot be one.
 * Purely syntactic — it says nothing about whether the host is reachable.
 *
 * Also detects pasted pair links (belay://pair?... or tether:) and returns
 * them directly — paste-to-pair, no scan required. Everything else goes
 * through `parseAddress`, which is where the accepted forms are tested.
 */
export function resolveHost(input: string): HostResolution {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Type the address from your Tailscale app, e.g. 100.101.102.103' };
  }

  // Detect pair links first: belay://pair?... or tether: — paste-to-pair.
  if (trimmed.match(/^(belay|tether):/i)) {
    const link = parsePairLink(trimmed);
    if (link) {
      return { ok: 'pair-link', link };
    }
    return { ok: false, reason: 'This looks like a pairing link, but it is incomplete or invalid.' };
  }

  const parsed = parseAddress(trimmed);
  if (parsed.kind !== 'ok') {
    return { ok: false, reason: parsed.kind === 'invalid' ? parsed.reason : 'Enter an address.' };
  }
  return {
    ok: true,
    url: parsed.url,
    note: isTailscaleAddress(parsed.url) ? 'Tailscale address — reachable from anywhere' : undefined,
    hint: parsed.hadCredentials ? CREDENTIALS_HINT : undefined,
  };
}

// --- recent hosts -----------------------------------------------------------

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Reads the recent-host list. A corrupt entry is treated as an empty list rather
 * than crashing the first screen of the app; the next successful pair rewrites it.
 */
export async function loadRecentHosts(): Promise<readonly string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return isStringArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

const persist = async (next: readonly string[]): Promise<readonly string[]> => {
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable store must not block connecting; the list is a
    // convenience, and the in-memory copy the caller gets back still works.
  }
  return next;
};

/** Moves `url` to the front of the list, de-duplicated and capped. */
export async function rememberHost(url: string): Promise<readonly string[]> {
  const current = await loadRecentHosts();
  const next = [url, ...current.filter((h) => h !== url)].slice(0, MAX_RECENT);
  return persist(next);
}

export async function forgetHost(url: string): Promise<readonly string[]> {
  const current = await loadRecentHosts();
  return persist(current.filter((h) => h !== url));
}

/** Strips the scheme and the default port so a saved host reads like an address. */
export function prettyHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/:8787$/, '');
}
