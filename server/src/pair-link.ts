// The pairing link encoded into the QR code the host prints at startup.
//
// Typing an IP address and then a 6-digit code is the clunkiest part of setting
// Belay up, and it is the one step that still requires being at the computer.
// A QR removes the typing entirely: the phone scans it and has the address, the
// code, and the machine's identity in one go.
//
// Format:
//
//   belay://pair?v=1&id=<uuid>&n=<label>&p=<platform>&c=<code>&f=<sha256>&a=<url>&a=<url>
//
// `f` is the SHA-256 fingerprint of the host's TLS certificate (tls-cert.ts),
// lowercase hex. It rides in the QR because the QR is the one channel that is
// read off the host's own screen: a phone that learns the fingerprint here
// can refuse every other certificate before it has said a word to anyone.
//
// Every address the host knows is included as a repeated `a` parameter, so the
// phone can save all of them and race them later — the same reason /health
// reports them. `c` is the live pairing code.
//
// A repeated parameter rather than a packed blob is deliberate: it survives
// being read by a human, logged, or pasted into a bug report, and it needs no
// second encoding layer that could disagree between the two implementations.

import { HostAddress } from './addresses.js';

// 'belay' since the rename, with the old scheme still parsed: links that
// already left this machine — QR photos, ntfy notifications sitting on a lock
// screen — cannot be recalled, so they must keep working.
export const PAIR_LINK_SCHEME = 'belay';
export const LEGACY_PAIR_LINK_SCHEME = 'tether';
export const PAIR_LINK_VERSION = '1';

export interface PairLinkInput {
  readonly hostId: string;
  readonly label: string;
  readonly platform: string;
  readonly code: string;
  readonly addresses: readonly HostAddress[];
  /** Certificate fingerprint, lowercase hex. Omitted only by tests of older shapes. */
  readonly fingerprint?: string;
}

/**
 * Build the link.
 *
 * Note what is *not* in here: no token. The QR carries the pairing code, which
 * is single-use and short-lived, so photographing the screen is exactly as
 * powerful as reading the code off it — no more. That equivalence is why the
 * rate limiting in pair-guard.ts is a prerequisite for this feature rather than
 * an unrelated improvement.
 */
export function buildPairLink(input: PairLinkInput): string {
  const params = new URLSearchParams();
  params.set('v', PAIR_LINK_VERSION);
  params.set('id', input.hostId);
  params.set('n', input.label);
  params.set('p', input.platform);
  params.set('c', input.code);
  if (input.fingerprint) params.set('f', input.fingerprint);
  // URLSearchParams.append keeps repeats, which is how several addresses ride
  // along without inventing a separator that could appear inside a URL.
  for (const address of input.addresses) params.append('a', address.url);
  return `${PAIR_LINK_SCHEME}://pair?${params.toString()}`;
}

export interface ParsedPairLink {
  readonly hostId: string;
  readonly label: string;
  readonly platform: string;
  readonly code: string;
  readonly addresses: readonly string[];
  /** Absent from links printed by a host older than TLS. */
  readonly fingerprint?: string;
}

/**
 * Parse a scanned link, or null if it is not one of ours.
 *
 * Every field is validated because this is a boundary: the input is whatever a
 * camera happened to decode, which may be any QR code in the world — a wifi
 * config, a URL, a payment link. Returning null rather than throwing lets the
 * scanner keep looking instead of showing an error for every unrelated code
 * that drifts through frame.
 */
export function parsePairLink(raw: string): ParsedPairLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== `${PAIR_LINK_SCHEME}:` && url.protocol !== `${LEGACY_PAIR_LINK_SCHEME}:`) return null;
  // `belay://pair?...` parses with host 'pair' and empty pathname, so accept
  // either shape rather than depending on which the platform's URL gives us.
  const isPair = url.hostname === 'pair' || url.pathname.replace(/\//g, '') === 'pair';
  if (!isPair) return null;

  const params = url.searchParams;
  if (params.get('v') !== PAIR_LINK_VERSION) return null;

  const hostId = params.get('id') ?? '';
  const code = params.get('c') ?? '';
  const addresses = params.getAll('a').filter((a) => isHttpUrl(a));

  // A link without an id, a code, or somewhere to send them is not usable.
  if (!hostId || !isSixDigitCode(code) || addresses.length === 0) return null;

  const fingerprint = normalizeFingerprint(params.get('f'));
  return {
    hostId,
    label: params.get('n') || 'My computer',
    platform: params.get('p') || 'other',
    code,
    addresses,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/** A SHA-256 fingerprint in any spelling (colons, spaces, case) → 64 lowercase hex, or null. */
export function normalizeFingerprint(value: string | null | undefined): string | null {
  const hex = String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 64 ? hex : null;
}

function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

/**
 * Only http(s) addresses are accepted.
 *
 * Without this a crafted QR could point the app at some other scheme entirely,
 * and the app would then send a pairing request — and later a bearer token — to
 * whatever it named.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
