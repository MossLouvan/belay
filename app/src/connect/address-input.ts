// Reading a computer's address off whatever someone typed or pasted.
//
// The primary way into Belay is copying the 100.x address out of the
// Tailscale app, so this module is built around that: it accepts every shape
// the clipboard is likely to carry — a bare IP, one with a port, a full URL,
// a MagicDNS name, trailing whitespace from a sloppy copy — and normalises
// all of them to the origin the app expects, port 8787 unless told otherwise.
// It also produces the live micro-label under the field, so the reassurance
// ("Looks like a Tailscale address") and the correction ("Tailscale addresses
// start with 100.") come from the same reading as the URL.
//
// Pure, no imports: node tests hold every accepted and rejected form.

/** The port the host agent listens on unless told otherwise. */
export const DEFAULT_PORT = 8787;

/** The example shown under the field — the shape of a Tailscale address. */
export const EXAMPLE_TAILSCALE_ADDRESS = '100.101.102.103';

/** What every Tailscale address begins with; also the tap-to-start prefix. */
export const TAILSCALE_PREFIX = '100.';

/** A pasted pairing link (`belay://pair?…` or the pre-rename `tether:`). */
export function looksLikePairLink(text: string): boolean {
  return /^(belay|tether):/i.test(text.trim());
}

/** Where a computer's address is reachable from, judged by its shape alone. */
export type AddressFamily =
  /** A 100.64.0.0/10 address — the Tailscale app's number for the computer. */
  | 'tailscale'
  /** A MagicDNS name (`*.ts.net`) — the same tunnel, spelled as a name. */
  | 'magicdns'
  /** Any other IPv4 — home Wi-Fi only. */
  | 'lan'
  /** A hostname such as `pc.local` — resolved by whatever network is around. */
  | 'name';

export type ParsedAddress =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'ok';
      /** The origin Belay talks to, e.g. `http://100.101.102.103:8787`. */
      readonly url: string;
      readonly host: string;
      readonly port: number;
      readonly family: AddressFamily;
      /** True when the input carried `user:pass@`, which the URL drops. */
      readonly hadCredentials: boolean;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
/** scheme? credentials? host port? path? */
const ADDRESS_SHAPE = /^(?:(https?):\/\/)?(?:([^@/]*)@)?([^:/?#]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i;

const BAD_IPV4 = (host: string): string =>
  `"${host}" is not a complete address — four numbers, each 0–255, like ${EXAMPLE_TAILSCALE_ADDRESS}.`;

const BAD_ADDRESS = (input: string): string =>
  `"${input}" is not an address. Copy the 100.x address from Tailscale, e.g. ${EXAMPLE_TAILSCALE_ADDRESS}.`;

/** Every octet in range, four of them. */
export function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => IPV4_OCTET.test(p));
}

/** In 100.64.0.0/10 — the range Tailscale hands out. */
export function isTailscaleIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** A MagicDNS name — `mosss-macbook-air.tail1234.ts.net`. */
export function isMagicDnsName(host: string): boolean {
  return /\.ts\.net$/i.test(host) && isHostname(host);
}

function isHostname(host: string): boolean {
  if (host.length > 253 || host.endsWith('.')) return false;
  return host.split('.').every((label) => HOST_LABEL.test(label));
}

/** Digits and dots only — someone part-way through typing an IP. */
export function looksLikeIPv4Draft(text: string): boolean {
  return /^[\d.]+$/.test(text);
}

function familyOf(host: string): AddressFamily | null {
  if (isTailscaleIPv4(host)) return 'tailscale';
  if (isIPv4(host)) return 'lan';
  // Digits and dots that are not an IP are a mistyped IP, never a name.
  if (looksLikeIPv4Draft(host)) return null;
  if (isMagicDnsName(host)) return 'magicdns';
  if (isHostname(host)) return 'name';
  return null;
}

/**
 * Turn typed or pasted text into the origin Belay connects to.
 *
 * Total: never throws, and every rejection carries a sentence the field can
 * show. Purely syntactic — it says nothing about whether the host answers.
 */
export function parseAddress(input: string): ParsedAddress {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'empty' };
  if (/\s/.test(trimmed)) {
    return { kind: 'invalid', reason: 'An address cannot contain spaces.' };
  }

  const match = ADDRESS_SHAPE.exec(trimmed);
  if (!match) return { kind: 'invalid', reason: BAD_ADDRESS(trimmed) };
  const [, scheme, credentials, rawHost, rawPort] = match;
  const host = rawHost.toLowerCase();

  const family = familyOf(host);
  if (!family) {
    return {
      kind: 'invalid',
      reason: looksLikeIPv4Draft(host) ? BAD_IPV4(host) : BAD_ADDRESS(trimmed),
    };
  }

  const protocol = (scheme ?? 'http').toLowerCase();
  const port = rawPort === undefined ? (protocol === 'https' ? 443 : DEFAULT_PORT) : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: 'invalid', reason: `"${rawPort}" is not a port. The host agent usually listens on ${DEFAULT_PORT}.` };
  }

  const portSuffix = protocol === 'https' && port === 443 ? '' : `:${port}`;
  return {
    kind: 'ok',
    url: `${protocol}://${host}${portSuffix}`,
    host,
    port,
    family,
    hadCredentials: Boolean(credentials),
  };
}

/** How the micro-label under the field speaks. */
export type FeedbackTone = 'good' | 'dim' | 'warn' | 'bad';

export interface AddressFeedback {
  readonly tone: FeedbackTone;
  readonly text: string;
}

/**
 * The live line under the field, for the text as it currently stands.
 *
 * Reassures the moment a Tailscale address is recognised, nudges when the
 * digits are heading somewhere else, and explains any rejection. Null when
 * there is nothing to say yet — the field shows the example instead.
 */
export function addressFeedback(input: string): AddressFeedback | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (looksLikePairLink(trimmed)) {
    return { tone: 'good', text: 'Pairing link — Connect pairs automatically' };
  }
  const parsed = parseAddress(trimmed);
  if (parsed.kind === 'ok') return feedbackFor(parsed);
  if (parsed.kind === 'empty') return null;

  if (looksLikeIPv4Draft(trimmed)) {
    return trimmed.startsWith(TAILSCALE_PREFIX) || TAILSCALE_PREFIX.startsWith(trimmed)
      ? { tone: 'dim', text: `Keep going — four numbers, like ${EXAMPLE_TAILSCALE_ADDRESS}` }
      : { tone: 'warn', text: 'Tailscale addresses start with 100.' };
  }
  return { tone: 'bad', text: parsed.reason };
}

function feedbackFor(parsed: Extract<ParsedAddress, { kind: 'ok' }>): AddressFeedback {
  switch (parsed.family) {
    case 'tailscale':
      return { tone: 'good', text: 'Looks like a Tailscale address' };
    case 'magicdns':
      return { tone: 'good', text: 'Looks like a Tailscale name' };
    case 'lan':
      return parsed.host.startsWith(TAILSCALE_PREFIX)
        ? { tone: 'good', text: 'Looks like a Tailscale address' }
        : { tone: 'warn', text: 'Local address — works on the same Wi-Fi only. Tailscale addresses start with 100.' };
    case 'name':
      return { tone: 'dim', text: 'A computer name — works on the same Wi-Fi only' };
  }
}

/**
 * Clean up text that arrived from the clipboard before it goes in the field.
 *
 * What the Tailscale app actually hands over varies: the admin console copies
 * a bare `100.x`, the mobile app can carry a trailing newline, the machine
 * detail view can give a MagicDNS name, and a browser copy is a full
 * `http://host:port/` URL. Someone who copied a line out of a note can also
 * bring quotes, a leading `Address:` label, or several lines at once.
 *
 * Rather than reject any of that, this reduces it to the shortest thing the
 * field can show and `parseAddress` accepts: the host, plus `:port` when the
 * port is not the one Belay assumes. A pairing link is handed back untouched —
 * `resolveHost` pairs from it directly.
 *
 * Total: anything it cannot read comes back trimmed, so the field shows what
 * was pasted and the live feedback line explains what is wrong with it.
 */
export function normalizePastedAddress(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (looksLikePairLink(trimmed)) return trimmed;

  // A paste that is one thing is taken at its word, whatever shape it is —
  // someone who copied a bare computer name meant that name.
  const whole = pretty(parseAddress(stripWrappers(trimmed)));
  if (whole) return whole;

  // Otherwise the paste is a line or a block with an address somewhere in it,
  // and picking a word out of prose needs more confidence than "it is a legal
  // hostname" — "Address", "hello" and "Connected" all are. Only a token that
  // is unmistakably an address (an IP, or a MagicDNS name) is taken.
  for (const token of trimmed.split(/\s+/).map(stripWrappers)) {
    if (!token) continue;
    const found = pretty(parseAddress(token), (family) => family !== 'name');
    if (found) return found;
  }
  return trimmed;
}

/** The shortest text the field can show for a parse the caller will accept. */
function pretty(parsed: ParsedAddress, accepts?: (family: AddressFamily) => boolean): string | null {
  if (parsed.kind !== 'ok') return null;
  if (accepts && !accepts(parsed.family)) return null;
  const defaultPort = parsed.url.startsWith('https://') ? 443 : DEFAULT_PORT;
  return parsed.port === defaultPort ? parsed.host : `${parsed.host}:${parsed.port}`;
}

/** Quotes, angle brackets and trailing punctuation a copied line drags along. */
function stripWrappers(token: string): string {
  return token
    .replace(/^[\s"'<([]+/, '')
    .replace(/[\s"'>)\].,;]+$/, '');
}
