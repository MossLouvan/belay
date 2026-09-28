// Proof that the machine answering is the one a device paired with.
//
// The host id in /health is public — it is in the QR and in every
// unauthenticated reply — so matching it proves nothing: a stranger holding
// the same 192.168.x address on another network can echo it and collect the
// bearer token the app sends next. Over the LAN the pinned certificate settles
// this, but over Tailscale the app still speaks plain HTTP, so the host has to
// prove itself another way before a token is sent.
//
// Pairing hands each device a second secret beside its token. The client
// sends a fresh random nonce, the host answers HMAC-SHA256 over it keyed by
// that device's secret, and the client checks the answer before it says
// `Authorization` to anyone. The secret is never sent; an impostor without it
// cannot produce the proof, and a captured proof is useless against the next
// nonce. Nothing here rate-limits: with a 256-bit key an HMAC oracle gives an
// attacker nothing to work with.
//
// Wire contract, mirrored in app/src/devices/proof.ts and desktop/src/proof.js
// — all three must agree byte for byte:
//   key     = UTF-8 bytes of the secret exactly as issued (a hex string)
//   message = UTF-8 bytes of PROOF_CONTEXT + nonce
//   proof   = lowercase hex of the HMAC-SHA256

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROOF_CONTEXT = 'belay-host-proof:v1:';
/** Hex, 16–32 bytes. Anything else is refused before it touches the HMAC. */
const NONCE = /^[0-9a-f]{32,64}$/i;

export function isValidNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

export function proveDevice(secret: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(PROOF_CONTEXT + nonce.toLowerCase(), 'utf8')
    .digest('hex');
}

/** Constant-time check of a proof against the expected one. */
export function proofMatches(expected: string, offered: unknown): boolean {
  if (typeof offered !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(offered.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
