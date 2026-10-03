// The live micro-label under the address field, in the phone app's words.
//
// The app (app/src/connect/address-input.ts) reassures the moment a Tailscale
// address is recognised and nudges when the digits are heading somewhere
// else. This is the same line for the desktop, built on the desktop's own
// address reading (url.js) so the feedback and the origin that Connect uses
// can never disagree. Pure; tested in test/address-feedback.test.mjs.

import { hostOrigin, isTailscaleOrigin } from './url.js';

/** The example shown under an empty field — a home-network address. */
export const EXAMPLE_ADDRESS = '192.168.1.20';

const IPV4_DRAFT = /^[\d.]+$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const hostnameOf = (origin) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
};

const feedback = (tone, text) => Object.freeze({ tone, text });

/**
 * `{ tone, text }` for the text as it stands, or null when there is nothing
 * to say yet (the field shows the example instead). Tones are the app's:
 * good / dim / warn / bad.
 */
export function addressFeedback(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return feedback('bad', 'An address cannot contain spaces.');

  const origin = hostOrigin(trimmed);
  if (origin && isTailscaleOrigin(origin)) {
    return feedback('good', 'Looks like a Tailscale address — no pairing code needed');
  }
  // Digits and dots that are not yet four numbers: someone mid-way through
  // typing an IP, not a name (the URL parser would happily read "100.101" as
  // 100.0.0.101, which is why this comes before the origin check).
  if (IPV4_DRAFT.test(trimmed) && !IPV4.test(trimmed)) {
    return feedback('dim', `Keep going — four numbers, like ${EXAMPLE_ADDRESS}`);
  }
  if (!origin) {
    return feedback('bad', `"${trimmed}" is not an address — four numbers, e.g. ${EXAMPLE_ADDRESS}.`);
  }
  if (/\.ts\.net$/i.test(hostnameOf(origin))) return feedback('good', 'Looks like a Tailscale name');
  if (IPV4.test(hostnameOf(origin))) {
    return feedback('good', 'Local address — works on the same network.');
  }
  return feedback('dim', 'A computer name — works on the same network only');
}
