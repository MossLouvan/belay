// Parser for the pairing link encoded in the QR the host prints at startup.
//
// Deliberately a mirror of server/src/pair-link.ts rather than a shared module:
// the app and the host are separate packages with separate build setups, and a
// parser this small is cheaper to duplicate with tests on both sides than to
// wire a workspace around. The format is documented in the host's copy, and
// both suites cover the same cases so drift shows up as a test failure.
//
//   tether://pair?v=1&id=<uuid>&n=<label>&p=<platform>&c=<code>&a=<url>&a=<url>

export const PAIR_LINK_VERSION = '1';

export interface ParsedPairLink {
  readonly hostId: string;
  readonly label: string;
  readonly platform: string;
  readonly code: string;
  readonly addresses: readonly string[];
}

/**
 * Parse a scanned link, or null if it is not one of ours.
 *
 * This is a boundary: the input is whatever the camera decoded, which may be
 * any QR code that happens to pass through frame — a wifi config, a URL, a
 * payment link. Returning null rather than throwing lets the scanner keep
 * looking instead of surfacing an error for every unrelated code it sees.
 */
export function parsePairLink(raw: string): ParsedPairLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'tether:') return null;
  // `tether://pair?...` parses with host 'pair' and an empty pathname, so
  // accept either shape rather than depending on which form the platform's URL
  // implementation produces.
  const isPair = url.hostname === 'pair' || url.pathname.replace(/\//g, '') === 'pair';
  if (!isPair) return null;

  const params = url.searchParams;
  if (params.get('v') !== PAIR_LINK_VERSION) return null;

  const hostId = params.get('id') ?? '';
  const code = params.get('c') ?? '';
  const addresses = params.getAll('a').filter(isHttpUrl);

  if (!hostId || !/^\d{6}$/.test(code) || addresses.length === 0) return null;

  return {
    hostId,
    label: params.get('n') || 'My computer',
    platform: params.get('p') || 'other',
    code,
    addresses,
  };
}

/**
 * Only http(s) addresses are accepted.
 *
 * Without this a crafted QR could name any scheme it liked, and the app would
 * then send a pairing request — and shortly afterwards hold a bearer token
 * for — whatever it pointed at.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
